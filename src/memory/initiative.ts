import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { INITIATIVE } from '../config.js';
import { logger } from '../logger.js';
import type { AiClient } from '../ai/client.js';
import { INITIATIVE_DISTILLER_SYSTEM, type PromptBuilder } from '../ai/prompts.js';
import { InitiativePrinciplesSchema } from '../ai/schemas.js';
import type { Repo } from '../memory/repo.js';

export interface InitiativeEvents { onDistilled(count: number): void; }
export type DistillStatus = 'ok' | 'busy' | 'budget' | 'empty' | 'error';
export interface DistillResult { status: DistillStatus; learned: number; }

/**
 * Distills the owner's flagged "Influence" moves (instruction + why + surrounding chat) into a
 * small, conservative set of reusable INITIATIVE PRINCIPLES — general rules about WHEN to take
 * initiative within a live conversation and WHAT KIND of move fits. Mirrors the VoiceProfiler
 * distillation pattern (budget + concurrency guard, dedup/supersede). Owner-triggered, or auto
 * after enough flagged moves pile up.
 */
export class InitiativeDistiller {
  private running = false;

  constructor(
    private repo: Repo,
    private ai: AiClient,
    private prompts: PromptBuilder,
    private events: InitiativeEvents,
  ) {}

  /** Auto-distill once enough new flagged moves have accumulated. */
  maybeAuto(): void {
    if (this.repo.countUndistilledLessons() >= INITIATIVE.AUTO_DISTILL_AFTER) void this.run();
  }

  async run(): Promise<DistillResult> {
    if (this.running) return { status: 'busy', learned: 0 };
    if (this.ai.isOverBudget()) return { status: 'budget', learned: 0 };
    const lessons = this.repo.getUndistilledLessons();
    if (lessons.length === 0) return { status: 'empty', learned: 0 };
    this.running = true;

    try {
      const known = this.repo.getActiveInitiativePrinciples();
      const knownList = known.length ? known.map(p => `[id ${p.id}] ${p.content}`).join('\n') : '(none yet)';

      const lessonBlock = lessons.map((l, i) => {
        const tgt = l.target_excerpt ? `\n  REPLYING TO: "${l.target_excerpt}"` : '';
        return `MOVE ${i + 1}:\n  OWNER STEER: ${l.text || '(no text — bot chose)'}\n  WHY: ${l.why || '(none given)'}${tgt}\n  CHAT AROUND IT:\n${l.context || '  (no context)'}`;
      }).join('\n\n');

      const response = await this.ai.client.messages.parse({
        model: INITIATIVE.MODEL,
        max_tokens: INITIATIVE.MAX_OUTPUT_TOKENS,
        system: INITIATIVE_DISTILLER_SYSTEM,
        messages: [{
          role: 'user',
          content: [
            `KNOWN PRINCIPLES (do NOT duplicate; supersede to sharpen):\n${knownList}`,
            `NEW FLAGGED MOVES TO DISTILL:\n${lessonBlock}`,
          ].join('\n\n'),
        }],
        output_config: { format: zodOutputFormat(InitiativePrinciplesSchema) },
      });

      this.ai.recordUsage(INITIATIVE.MODEL, response.usage, 'initiative');

      let learned = 0;
      const parsed = response.parsed_output;
      if (parsed) {
        for (const p of parsed.principles) {
          const content = p.content?.trim();
          if (!content) continue;
          const newId = this.repo.insertInitiativePrinciple(content, p.example?.trim() || null);
          if (newId !== null) { // null = UNIQUE collision (already known)
            learned += 1;
            if (p.supersedes_id != null) this.repo.supersedeInitiativePrinciple(p.supersedes_id, newId);
          }
        }
      }
      this.repo.markLessonsDistilled(lessons.map(l => l.id)); // consumed either way
      if (learned > 0) { this.prompts.memoryVersion += 1; this.events.onDistilled(learned); }
      logger.info({ lessons: lessons.length, learned }, 'initiative principles distilled');
      return { status: 'ok', learned };
    } catch (err) {
      logger.error({ err }, 'initiative distiller failed');
      return { status: 'error', learned: 0 };
    } finally {
      this.running = false;
    }
  }
}
