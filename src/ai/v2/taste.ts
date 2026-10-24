import { z } from 'zod';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { BOT_NAME, BRAIN_V2, DEFAULT_MSG_PREFIX, DEFAULT_MSG_SUFFIX } from '../../config.js';
import { logger } from '../../logger.js';
import type { Repo } from '../../memory/repo.js';
import type { AiClient } from '../client.js';
import { parseDecisionLine, stripMarker } from './signals.js';

/**
 * Brain v2 learning loop: the owner's 👍 / 👎 on lines and decisions in a group are distilled into a
 * few short "house rules" for that group (one cheap call every BRAIN_V2.TASTE_EVERY new ratings). Both
 * v2 stages see the rules. Rules are phrased as what to do, never quoting a line, so nothing gets planted.
 * Stored per group in config (`v2_taste_rules_<jid>`, `v2_taste_at_<jid>`); a fresh start wipes them.
 */

export const TasteSchema = z.object({
  rules: z.array(z.string().describe('One house rule, under 15 words, phrased as what to do.'))
    .describe('3 to 6 rules for this group, most important first.'),
});

export const TASTE_SYSTEM = `You help ${BOT_NAME}, an AI member of a WhatsApp friend group, learn its owner's taste. You get the owner's ratings from ONE group: lines of ${BOT_NAME}'s they liked or disliked, and its decisions to speak, react or stay quiet that they marked as right or wrong. You also get the current house rules, if any.

Write 3 to 6 short house rules for this group:
- About timing (when to talk, stay quiet or just react) and style (length, kind of humor, who to tease and how hard, language mix).
- Phrased as what to do, in plain words, under 15 words each. Never quote a rated line and never write example lines.
- Keep current rules that still fit, sharpen them, drop ones the new ratings contradict. Most important first.
- Only what the ratings actually show. With few ratings, write fewer rules.`;

export interface TasteState {
  rules: string[];
  at: number | null;
  newRatings: number;
  every: number;
}

export class TasteLearner {
  private running = new Set<string>();
  /** bumped by clear(): a learn that started before a clear must not write its rules back */
  private generation = new Map<string, number>();

  constructor(private repo: Repo, private ai: AiClient, private onLearned: (chatJid: string, rules: string[]) => void) {}

  /** True while a learn call is in flight (fresh start waits for it). */
  get working(): boolean {
    return this.running.size > 0;
  }

  rules(chatJid: string): string[] {
    return readTasteRules(this.repo, chatJid);
  }

  state(chatJid: string): TasteState {
    const at = Number(this.repo.getConfig(`v2_taste_at_${chatJid}`) ?? 0) || null;
    return { rules: this.rules(chatJid), at, newRatings: this.repo.countRatingsSince(chatJid, at ?? 0), every: BRAIN_V2.TASTE_EVERY };
  }

  /**
   * After a rating: learn when enough new ones piled up (only where v2 runs or shadows). After a failed
   * learn it waits TASTE_RETRY_MS, so a broken call is not retried (and paid for) on every rating.
   */
  maybeAuto(chatJid: string): void {
    if (this.repo.getBrainMode(chatJid) === 'v1' || this.running.has(chatJid)) return;
    const failedAt = Number(this.repo.getConfig(`v2_taste_fail_${chatJid}`) ?? 0);
    if (Date.now() - failedAt < BRAIN_V2.TASTE_RETRY_MS) return;
    if (this.state(chatJid).newRatings >= BRAIN_V2.TASTE_EVERY) void this.run(chatJid);
  }

  clear(chatJid: string): void {
    this.generation.set(chatJid, (this.generation.get(chatJid) ?? 0) + 1);
    this.repo.setConfig(`v2_taste_rules_${chatJid}`, '[]');
    this.repo.setConfig(`v2_taste_at_${chatJid}`, String(Date.now()));
    this.onLearned(chatJid, []);
  }

  async run(chatJid: string): Promise<{ status: 'ok' | 'busy' | 'budget' | 'empty' | 'error'; rules: string[] }> {
    if (this.running.has(chatJid)) return { status: 'busy', rules: this.rules(chatJid) };
    if (this.ai.isOverBudget()) return { status: 'budget', rules: this.rules(chatJid) };
    const liked = this.repo.getFeedbackLines(chatJid, 1, BRAIN_V2.TASTE_LEARN_LINES);
    const disliked = this.repo.getFeedbackLines(chatJid, -1, BRAIN_V2.TASTE_LEARN_LINES);
    const calls = this.repo.getDecisionFeedback(chatJid, BRAIN_V2.TASTE_LEARN_LINES);
    if (liked.length + disliked.length + calls.length === 0) return { status: 'empty', rules: this.rules(chatJid) };
    this.running.add(chatJid);
    const startedAt = Date.now();
    const gen = this.generation.get(chatJid) ?? 0;
    const prefix = this.repo.getConfig('msg_prefix') ?? DEFAULT_MSG_PREFIX;
    const suffix = this.repo.getConfig('msg_suffix') ?? DEFAULT_MSG_SUFFIX;
    const strip = (t: string) => stripMarker(t, prefix, suffix);
    const WHAT: Record<string, string> = { IGNORE: 'stay quiet', REACT: 'react', WAIT: 'wait for them to finish', PAUSE: 'offer a saved thought at a pause', RESPOND: 'speak' };
    try {
      const current = this.rules(chatJid);
      const decisions = calls.map(c => {
        const { reason, thought } = parseDecisionLine(c.reason);
        return `- ${c.verdict === 'good' ? 'RIGHT' : 'WRONG'} to ${WHAT[c.decision] ?? 'speak'}: ${reason}${thought ? ` (its idea: ${thought})` : ''}`.slice(0, 220);
      });
      const content = [
        `CURRENT HOUSE RULES:\n${current.length ? current.map(r => `- ${r}`).join('\n') : '(none yet)'}`,
        `LINES THE OWNER LIKED:\n${liked.length ? liked.map(t => `- ${strip(t).slice(0, 160)}`).join('\n') : '(none)'}`,
        `LINES THE OWNER DISLIKED:\n${disliked.length ? disliked.map(t => `- ${strip(t).slice(0, 160)}`).join('\n') : '(none)'}`,
        `DECISIONS THE OWNER JUDGED:\n${decisions.length ? decisions.join('\n') : '(none)'}`,
      ].join('\n\n');
      const model = this.ai.gatekeeperModel;
      const { max_tokens, effort } = this.ai.tuning(model, 800, 'quick');
      const response = await this.ai.client.messages.parse({
        model,
        max_tokens,
        system: TASTE_SYSTEM,
        messages: [{ role: 'user', content }],
        output_config: { format: zodOutputFormat(TasteSchema), ...(effort ? { effort } : {}) },
      });
      this.ai.recordUsage(model, response.usage, 'taste', chatJid);
      if (!response.parsed_output) {
        this.repo.setConfig(`v2_taste_fail_${chatJid}`, String(Date.now()));
        return { status: 'error', rules: current };
      }
      // the owner cleared the rules while this was running: their clear wins
      if ((this.generation.get(chatJid) ?? 0) !== gen) return { status: 'ok', rules: this.rules(chatJid) };
      const rules = response.parsed_output.rules.map(r => r.trim()).filter(Boolean).slice(0, 6);
      this.repo.setConfig(`v2_taste_rules_${chatJid}`, JSON.stringify(rules));
      this.repo.setConfig(`v2_taste_at_${chatJid}`, String(startedAt));
      this.onLearned(chatJid, rules);
      logger.info({ chatJid, rules: rules.length }, 'brain v2 house rules learned');
      return { status: 'ok', rules };
    } catch (err) {
      logger.warn({ err }, 'brain v2 taste learning failed');
      this.repo.setConfig(`v2_taste_fail_${chatJid}`, String(Date.now()));
      return { status: 'error', rules: this.rules(chatJid) };
    } finally {
      this.running.delete(chatJid);
    }
  }
}

/** The learned house rules of one group (empty when none or unreadable). */
export function readTasteRules(repo: Repo, chatJid: string): string[] {
  try {
    const v = JSON.parse(repo.getConfig(`v2_taste_rules_${chatJid}`) ?? '[]');
    return Array.isArray(v) ? v.filter((r): r is string => typeof r === 'string') : [];
  } catch {
    return [];
  }
}

export function formatTasteRules(rules: string[]): string | null {
  if (rules.length === 0) return null;
  return `YOUR OWNER'S HOUSE RULES FOR THIS GROUP (learned from their ratings; follow them, but their boundaries and usage dials still win):\n${rules.map(r => `- ${r}`).join('\n')}`;
}
