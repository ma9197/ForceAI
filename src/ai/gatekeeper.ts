import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { ARBITER } from '../config.js';
import { logger } from '../logger.js';
import type { Repo } from '../memory/repo.js';
import type { GateResult } from '../types.js';
import type { AiClient } from './client.js';
import { GATEKEEPER_SYSTEM, type PromptBuilder } from './prompts.js';
import { GateResultSchema } from './schemas.js';

export class Gatekeeper {
  constructor(
    private ai: AiClient,
    private repo: Repo,
    private prompts: PromptBuilder,
  ) {}

  /**
   * Decide RESPOND/WAIT/IGNORE for the unconsumed buffer.
   * @param consumedUpToTs everything ≤ this has been handled before
   * @param forceDecide append a "no more waiting" instruction (after MAX_WAITS)
   */
  async decide(chatJid: string, consumedUpToTs: number, secondsSinceBotMessage: number | null, forceDecide: boolean): Promise<GateResult> {
    const rows = this.repo.getRecentMessages(chatJid, ARBITER.GATEKEEPER_LINES);
    const transcript = this.prompts.formatTranscript(rows, consumedUpToTs);

    const contextNote = secondsSinceBotMessage !== null && secondsSinceBotMessage < 60
      ? `\n(You last spoke ${Math.round(secondsSinceBotMessage)}s ago.)`
      : '';
    const forceNote = forceDecide
      ? '\nYou have already waited the maximum amount of time. You MUST decide RESPOND or IGNORE now — WAIT is not allowed.'
      : '';

    try {
      const response = await this.ai.client.messages.parse({
        model: this.ai.gatekeeperModel,
        max_tokens: 1500,
        system: GATEKEEPER_SYSTEM,
        messages: [{
          role: 'user',
          content: `${transcript}${contextNote}${forceNote}`,
        }],
        output_config: { format: zodOutputFormat(GateResultSchema) },
      });

      this.ai.recordUsage(this.ai.gatekeeperModel, response.usage, 't1', chatJid);

      const parsed = response.parsed_output;
      if (!parsed) {
        logger.warn('gatekeeper returned unparseable output — defaulting to IGNORE');
        return { decision: 'IGNORE', reason: 'parse failure', address_message_ids: [], heat: 'low' };
      }
      if (forceDecide && parsed.decision === 'WAIT') {
        return { ...parsed, decision: 'IGNORE', reason: parsed.reason + ' (forced after max waits)' };
      }
      return parsed;
    } catch (err) {
      logger.error({ err }, 'gatekeeper call failed — defaulting to IGNORE');
      return { decision: 'IGNORE', reason: 'API error', address_message_ids: [], heat: 'low' };
    }
  }
}
