import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { MEMORY } from '../config.js';
import { logger } from '../logger.js';
import type { AiClient } from '../ai/client.js';
import { EXTRACTOR_SYSTEM, type PromptBuilder } from '../ai/prompts.js';
import { FactExtractionSchema } from '../ai/schemas.js';
import type { Repo } from '../memory/repo.js';

export interface ExtractorEvents {
  onFact(memberJid: string, fact: string, category: string | null): void;
}

/**
 * Background fact-extraction job. Triggered by message volume or idle period.
 * Learns durable facts about members + maintains the rolling group summary.
 */
export class FactExtractor {
  private lastProcessedTs: number;
  private running = false;
  private idleTimer: NodeJS.Timeout | null = null;

  constructor(
    private chatJid: string,
    private repo: Repo,
    private ai: AiClient,
    private prompts: PromptBuilder,
    private events: ExtractorEvents,
  ) {
    this.lastProcessedTs = Number(repo.getConfig(`extract_ts_${chatJid}`) ?? Date.now());
  }

  /** Call on every stored group message. */
  onActivity(): void {
    const unprocessed = this.repo.countMessagesSince(this.chatJid, this.lastProcessedTs);
    if (unprocessed >= MEMORY.EXTRACT_EVERY_MSGS) {
      void this.run();
      return;
    }
    // idle trigger: re-arm a timer; if the group goes quiet with enough backlog, extract
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      const n = this.repo.countMessagesSince(this.chatJid, this.lastProcessedTs);
      if (n >= MEMORY.EXTRACT_IDLE_MIN_MSGS) void this.run();
    }, MEMORY.EXTRACT_IDLE_MS);
  }

  async run(): Promise<void> {
    if (this.running) return;
    if (this.ai.isOverBudget()) return; // respect the daily budget (matches the voice profiler)
    this.running = true;
    const upToTs = Date.now();

    try {
      const rows = this.repo.getMessagesBetween(this.chatJid, this.lastProcessedTs, upToTs);
      if (rows.length === 0) return;

      const transcript = this.prompts.formatTranscript(rows, null);

      // current facts for context (id + member + fact so the model can supersede) — this group only
      const facts = this.repo.getActiveFacts(this.chatJid);
      const factList = facts.length
        ? facts.map(f => `[id ${f.id}] ${f.member_jid}: ${f.fact}`).join('\n')
        : '(none yet)';

      const members = this.repo.getMembersForChat(this.chatJid)
        .map(m => `${m.display_name ?? '?'} = ${m.jid}`)
        .join('\n');

      const summary = this.repo.getSummary(this.chatJid)?.summary ?? '(none yet)';

      const response = await this.ai.client.messages.parse({
        model: this.ai.utilityModel,
        max_tokens: 2000,
        system: EXTRACTOR_SYSTEM,
        messages: [{
          role: 'user',
          content: [
            `MEMBERS (name = jid):\n${members}`,
            `KNOWN FACTS:\n${factList}`,
            `CURRENT GROUP SUMMARY:\n${summary}`,
            `NEW TRANSCRIPT CHUNK:\n${transcript}`,
          ].join('\n\n'),
        }],
        output_config: { format: zodOutputFormat(FactExtractionSchema) },
      });

      this.ai.recordUsage(this.ai.utilityModel, response.usage, 'extract', this.chatJid);

      const parsed = response.parsed_output;
      if (parsed) {
        let learned = 0;
        for (const f of parsed.facts) {
          if (f.confidence < 0.6) continue;
          const newId = this.repo.insertFact(this.chatJid, f.member_jid, f.fact, f.category, f.confidence, null);
          if (newId !== null) {
            learned += 1;
            if (f.supersedes_fact_id != null) this.repo.supersedeFact(f.supersedes_fact_id, newId);
            this.events.onFact(f.member_jid, f.fact, f.category);
          }
        }
        if (learned > 0) {
          this.repo.bumpStat('facts_learned', learned);
          this.repo.bumpStat(`facts_learned:${this.chatJid}`, learned);
          this.prompts.memoryVersion += 1;
        }
        if (parsed.summary_update) {
          this.repo.setSummary(this.chatJid, parsed.summary_update, upToTs);
          this.prompts.memoryVersion += 1;
        }
        logger.info({ learned, summaryUpdated: !!parsed.summary_update }, 'fact extraction complete');
      }

      this.lastProcessedTs = upToTs;
      this.repo.setConfig(`extract_ts_${this.chatJid}`, String(upToTs));
    } catch (err) {
      logger.error({ err }, 'fact extraction failed');
    } finally {
      this.running = false;
    }
  }
}
