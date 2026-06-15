import fs from 'node:fs';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { ARBITER, VISION } from '../config.js';
import { logger } from '../logger.js';
import type { Repo } from '../memory/repo.js';
import type { ActionPlan } from '../types.js';
import type { AiClient } from './client.js';
import type { PromptBuilder } from './prompts.js';
import { ActionPlanSchema } from './schemas.js';

export interface GenerateInput {
  chatJid: string;
  /** ts of last already-handled message — everything after gets the NEW marker (null = nothing new flagged) */
  consumedUpToTs: number | null;
  /** gatekeeper hints */
  addressIds?: string[];
  gatekeeperReason?: string;
  /** operator instruction from Influence / Continue / Admin: */
  operatorInstruction?: string | null;
}

export class Generator {
  constructor(
    private ai: AiClient,
    private repo: Repo,
    private prompts: PromptBuilder,
  ) {}

  async generate(input: GenerateInput): Promise<ActionPlan | null> {
    const rows = this.repo.getRecentMessages(input.chatJid, ARBITER.TRANSCRIPT_LINES);
    const transcript = this.prompts.formatTranscript(rows, input.consumedUpToTs);

    const parts: string[] = [
      `Current group chat transcript:`,
      transcript || '(chat is empty so far)',
    ];
    if (input.addressIds?.length) {
      parts.push(`HINT: address ${input.addressIds.map(i => '#' + i).join(', ')}${input.gatekeeperReason ? ` — ${input.gatekeeperReason}` : ''}`);
    }
    if (input.operatorInstruction) {
      parts.push(`<operator_instruction>${input.operatorInstruction}</operator_instruction>`);
      parts.push('(An operator instruction is present — you MUST act on it. "nothing" is not an acceptable plan here.)');
    }
    parts.push(`Decide your actions now. Current time: ${new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`);

    // attach the most recent inbound images so Claude can actually SEE them (vision)
    const sinceTs = input.consumedUpToTs ?? Date.now() - 10 * 60_000;
    const imageRows = this.repo.getRecentImageMessages(input.chatJid, sinceTs, VISION.MAX_IMAGES_PER_CALL);
    const imageBlocks: any[] = [];
    for (const row of imageRows.reverse()) {
      try {
        const data = fs.readFileSync(row.media_path).toString('base64');
        imageBlocks.push({ type: 'text', text: `Image in message #${row.short_id}:` });
        imageBlocks.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } });
      } catch { /* file gone — skip */ }
    }

    const userContent: any = imageBlocks.length
      ? [{ type: 'text', text: parts.join('\n\n') }, ...imageBlocks]
      : parts.join('\n\n');

    try {
      const response = await this.ai.client.messages.parse({
        model: this.ai.generationModel,
        max_tokens: 2000,
        system: this.prompts.buildSystemBlocks(input.chatJid) as any,
        messages: [{ role: 'user', content: userContent }],
        output_config: {
          format: zodOutputFormat(ActionPlanSchema),
          effort: this.ai.effort,
        },
      });

      this.ai.recordUsage(this.ai.generationModel, response.usage, 't2', input.chatJid);

      const parsed = response.parsed_output;
      if (!parsed) {
        logger.warn({ stop: response.stop_reason }, 'generator returned unparseable output — staying silent');
        return null;
      }
      // private observation for the weekly member report (never shown in chat) — resolve the
      // target message's sender and store it against that person.
      const obs = parsed.observation;
      if (obs?.note?.trim() && obs.about_message_id) {
        const target = this.repo.getMessageByShortId(obs.about_message_id);
        if (target?.sender_jid && !target.is_bot && !target.is_owner) {
          this.repo.insertMemberObservation(target.sender_jid, input.chatJid, obs.note.trim());
        }
      }

      // enforce action cap
      const actions = parsed.actions.slice(0, ARBITER.MAX_ACTIONS);
      return { actions, note: parsed.note };
    } catch (err) {
      logger.error({ err }, 'generator call failed — staying silent');
      return null;
    }
  }
}
