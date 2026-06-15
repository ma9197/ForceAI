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

export type VoiceLearnStatus =
  | 'ok'      // analysis ran; `learned` is how many genuinely-new items were added (may be 0)
  | 'busy'    // another analysis (auto or manual) is already running — try again shortly
  | 'budget'  // skipped: over the daily budget
  | 'empty'   // nothing to analyze from this source
  | 'error';  // the model call threw
export interface VoiceLearnResult { status: VoiceLearnStatus; learned: number; }

/**
 * Background + on-demand voice-profiler. Distills the group's recurring texting STYLE (phrases,
 * slang, jokes, references, patterns, per-member style) so the bot can sound like the group.
 *
 * Automatic: runs on message volume or idle, independently of the arbiter's sleep state (the
 * owner wants the group's voice learned even overnight). Still respects the daily budget.
 *
 * Manual: `learnFromChat()` (deep re-scan of recent history) and `learnFromMemory()` (mine the
 * stored facts + summary) are triggered from the dashboard. All paths share one analyze() core,
 * one concurrency guard (so spamming the button never double-runs), and the same dedup: known
 * items are shown to the model AND the DB has a UNIQUE(chat,category,content) constraint, so a
 * re-scan only ever ADDS something new — it never duplicates what's already there.
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

  /** Automatic incremental pass over messages accumulated since the last checkpoint. */
  async run(): Promise<void> {
    if (this.running) return;
    const upToTs = Date.now();
    const rows = this.repo.getMessagesBetween(this.chatJid, this.lastProcessedTs, upToTs);
    // only learn from real human messages (not the bot's own outputs — we want the GROUP's voice,
    // not a reflection of the bot's current style)
    const humanRows = rows.filter(r => !r.is_bot);
    if (humanRows.length < 5) { this.advance(upToTs); return; }

    const transcript = this.prompts.formatTranscript(humanRows, null);
    const res = await this.analyze('new messages', `NEW TRANSCRIPT CHUNK:\n${transcript}`);
    // only checkpoint a window we actually analyzed — on busy/budget we retry on the next message
    if (res.status === 'ok') this.advance(upToTs);
  }

  /**
   * Manual: deep re-scan of the most recent stored messages (far more than the incremental pass).
   * Messages are never pruned, so this reaches back as far as the bot has been in the group.
   */
  async learnFromChat(): Promise<VoiceLearnResult> {
    const rows = this.repo.getRecentMessages(this.chatJid, VOICE_PROFILE.MANUAL_CHAT_MSGS);
    const humanRows = rows.filter(r => !r.is_bot);
    if (humanRows.length < 5) return { status: 'empty', learned: 0 };
    const transcript = this.prompts.formatTranscript(humanRows, null);
    return this.analyze(
      'chat history',
      `CHAT HISTORY (a deep sample of recent messages — find the recurring style across all of it):\n${transcript}`,
    );
  }

  /** Manual: mine the group's already-learned memory (facts + running summary) for voice style. */
  async learnFromMemory(): Promise<VoiceLearnResult> {
    const digest = this.buildMemoryDigest();
    if (!digest) return { status: 'empty', learned: 0 };
    return this.analyze('group memory', digest);
  }

  /** Build a digest of stored facts + summary, framed for voice-style extraction. */
  private buildMemoryDigest(): string | null {
    const members = this.repo.getMembersForChat(this.chatJid);
    const facts = this.repo.getActiveFacts(this.chatJid);
    const summary = this.repo.getSummary(this.chatJid)?.summary?.trim();
    if (facts.length === 0 && !summary) return null;

    const byMember = new Map<string, string[]>();
    for (const f of facts) {
      if (!byMember.has(f.member_jid)) byMember.set(f.member_jid, []);
      byMember.get(f.member_jid)!.push(f.category ? `${f.fact} (${f.category})` : f.fact);
    }
    const factLines = members.map(m => {
      const fs = byMember.get(m.jid) ?? [];
      if (fs.length === 0 && !m.personality_notes) return null;
      const notes = m.personality_notes ? ` | notes: ${m.personality_notes}` : '';
      const name = m.display_name ?? m.jid.split('@')[0];
      return `- ${name} [${m.jid}]: ${fs.join('; ') || '—'}${notes}`;
    }).filter(Boolean).join('\n');

    return [
      'GROUP MEMORY — facts & a running summary the bot has already learned about this group.',
      'Mine it ONLY for VOICE-relevant style: inside jokes, nicknames / recurring references, running bits, and how specific members come across (member_style). Skip purely biographical facts that say nothing about HOW they talk.',
      summary ? `RUNNING SUMMARY:\n${summary}` : '',
      factLines ? `KNOWN FACTS BY MEMBER:\n${factLines}` : '',
    ].filter(Boolean).join('\n\n');
  }

  /**
   * Shared analysis core. Guards against concurrent runs + budget, shows the model the existing
   * items (so it won't duplicate), then inserts only genuinely-new ones (UNIQUE constraint is the
   * final backstop). Returns a result the caller/UI can surface.
   */
  private async analyze(sourceLabel: string, contentBlock: string): Promise<VoiceLearnResult> {
    if (this.running) return { status: 'busy', learned: 0 };
    if (this.ai.isOverBudget()) return { status: 'budget', learned: 0 };
    this.running = true;

    try {
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
            `KNOWN VOICE ITEMS (already saved — do NOT re-add these; only output genuinely new style):\n${knownList}`,
            `CURRENT VOICE OVERVIEW:\n${overview}`,
            contentBlock,
          ].join('\n\n'),
        }],
        output_config: { format: zodOutputFormat(VoiceProfileSchema) },
      });

      this.ai.recordUsage(VOICE_PROFILE_MODEL, response.usage, 'voice', this.chatJid);

      let learned = 0;
      const parsed = response.parsed_output;
      if (parsed) {
        for (const it of parsed.items) {
          const content = it.content?.trim();
          if (!content) continue;
          const memberJid = it.category === 'member_style' ? it.member_jid : null;
          const newId = this.repo.insertVoiceItem(this.chatJid, it.category, content, it.example?.trim() || null, memberJid);
          if (newId !== null) { // null = UNIQUE collision (already known) → silently skipped
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
      }

      logger.info({ chatJid: this.chatJid, source: sourceLabel, learned }, 'voice profile analyzed');
      return { status: 'ok', learned };
    } catch (err) {
      logger.error({ err, source: sourceLabel }, 'voice profiler failed');
      return { status: 'error', learned: 0 };
    } finally {
      this.running = false;
    }
  }

  private advance(ts: number): void {
    this.lastProcessedTs = ts;
    this.repo.setConfig(`voice_ts_${this.chatJid}`, String(ts));
  }
}
