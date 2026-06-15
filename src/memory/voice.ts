import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { VOICE_PROFILE, VOICE_PROFILE_MODEL } from '../config.js';
import { logger } from '../logger.js';
import type { AiClient } from '../ai/client.js';
import { VOICE_PROFILER_SYSTEM, type PromptBuilder } from '../ai/prompts.js';
import { VoiceProfileSchema } from '../ai/schemas.js';
import type { Repo } from '../memory/repo.js';

export interface VoiceEvents {
  onLearned(count: number): void;
}

/**
 * Background voice-profiler. Distills the group's recurring texting STYLE (phrases, slang,
 * jokes, references, patterns, per-member style) so the bot can sound like the group.
 * Runs on message volume or idle — independently of the arbiter's sleep state (the owner
 * wants the group's voice learned even overnight). Still respects the daily budget.
 */
export class VoiceProfiler {
  private lastProcessedTs: number;
  private running = false;
  private idleTimer: NodeJS.Timeout | null = null;

  constructor(
    private chatJid: string,
    private repo: Repo,
    private ai: AiClient,
    private prompts: PromptBuilder,
    private events: VoiceEvents,
  ) {
    this.lastProcessedTs = Number(repo.getConfig(`voice_ts_${chatJid}`) ?? Date.now());
  }

  /** Call on every stored human group message. Triggers analysis on volume, or after an idle lull. */
  onActivity(): void {
    const unprocessed = this.repo.countMessagesSince(this.chatJid, this.lastProcessedTs);
    if (unprocessed >= VOICE_PROFILE.EVERY_MSGS) {
      void this.run();
      return;
    }
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      const n = this.repo.countMessagesSince(this.chatJid, this.lastProcessedTs);
      if (n >= VOICE_PROFILE.IDLE_MIN_MSGS) void this.run();
    }, VOICE_PROFILE.IDLE_MS);
  }

  async run(): Promise<void> {
    if (this.running) return;
    if (this.ai.isOverBudget()) {
      logger.info('voice profiler skipped — over daily budget');
      return;
    }
    this.running = true;
    const upToTs = Date.now();

    try {
      const rows = this.repo.getMessagesBetween(this.chatJid, this.lastProcessedTs, upToTs);
      // only learn from real human messages (not the bot's own outputs — we don't want to
      // reinforce the bot's current style; we want the GROUP's voice)
      const humanRows = rows.filter(r => !r.is_bot);
      if (humanRows.length < 5) { this.advance(upToTs); return; }

      const transcript = this.prompts.formatTranscript(humanRows, null);

      const known = this.repo.getVoiceItems(this.chatJid);
      const knownList = known.length
        ? known.map(i => `[id ${i.id}] (${i.category})${i.member_jid ? ' ' + i.member_jid : ''}: ${i.content}`).join('\n')
        : '(none yet)';

      const members = this.repo.getMembersForChat(this.chatJid)
        .map(m => `${m.display_name ?? '?'} = ${m.jid}`)
        .join('\n');

      const overview = this.repo.getVoiceOverview(this.chatJid) ?? '(none yet)';

      const response = await this.ai.client.messages.parse({
        model: VOICE_PROFILE_MODEL, // pinned to Sonnet — style capture is quality-sensitive (see config)
        max_tokens: 2500,
        system: VOICE_PROFILER_SYSTEM,
        messages: [{
          role: 'user',
          content: [
            `MEMBERS (name = jid):\n${members}`,
            `KNOWN VOICE ITEMS:\n${knownList}`,
            `CURRENT VOICE OVERVIEW:\n${overview}`,
            `NEW TRANSCRIPT CHUNK:\n${transcript}`,
          ].join('\n\n'),
        }],
        output_config: { format: zodOutputFormat(VoiceProfileSchema) },
      });

      this.ai.recordUsage(VOICE_PROFILE_MODEL, response.usage, 'voice', this.chatJid);

      const parsed = response.parsed_output;
      if (parsed) {
        let learned = 0;
        for (const it of parsed.items) {
          const content = it.content?.trim();
          if (!content) continue;
          const memberJid = it.category === 'member_style' ? it.member_jid : null;
          const newId = this.repo.insertVoiceItem(this.chatJid, it.category, content, it.example?.trim() || null, memberJid);
          if (newId !== null) {
            learned += 1;
            if (it.supersedes_id != null) this.repo.supersedeVoiceItem(it.supersedes_id, newId);
          }
        }
        if (learned > 0) {
          this.repo.bumpStat('voice_items_learned', learned);
          this.repo.bumpStat(`voice_items_learned:${this.chatJid}`, learned);
          this.prompts.memoryVersion += 1;
          this.events.onLearned(learned);
        }
        if (parsed.overview_update && parsed.overview_update.trim()) {
          this.repo.setVoiceOverview(this.chatJid, parsed.overview_update.trim());
          this.prompts.memoryVersion += 1;
        }
        logger.info({ chatJid: this.chatJid, learned, overviewUpdated: !!parsed.overview_update }, 'voice profile updated');
      }

      this.advance(upToTs);
    } catch (err) {
      logger.error({ err }, 'voice profiler failed');
    } finally {
      this.running = false;
    }
  }

  private advance(ts: number): void {
    this.lastProcessedTs = ts;
    this.repo.setConfig(`voice_ts_${this.chatJid}`, String(ts));
  }
}
