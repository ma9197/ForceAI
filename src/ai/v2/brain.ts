import fs from 'node:fs';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { ARBITER, BRAIN_V2, DEFAULT_MSG_PREFIX, DEFAULT_MSG_SUFFIX, VISION, formatCityTimes } from '../../config.js';
import { logger } from '../../logger.js';
import type { Repo } from '../../memory/repo.js';
import type { ActionPlan, BotAction } from '../../types.js';
import type { AiClient } from '../client.js';
import type { GenerateInput } from '../generator.js';
import type { PromptBuilder } from '../prompts.js';
import { lintPlan, type LintResult } from './lint.js';
import { decide, type PolicyResult } from './policy.js';
import { GATEKEEPER_V2_SYSTEM, REWRITE_SYSTEM } from './prompts.js';
import { GateV2Schema, PlanV2Schema, RewriteSchema, type GateV2Out, type PlanV2Out } from './schemas.js';
import {
  botTics, callbackKeywords, formatCallbacks, formatLanded, formatParticipation, formatStyleStats, formatTics,
  landedLines, participation, stripMarker, styleStats, type MsgRow,
} from './signals.js';

export interface GateV2Result {
  out: GateV2Out;
  policy: PolicyResult;
}

export interface GenerateV2Input extends GenerateInput {
  /** a thought saved from an earlier read, offered again at a pause in the chat */
  thought?: string | null;
  /** preview: no observations saved, nothing recorded besides token usage */
  dryRun?: boolean;
}

export interface GenerateV2Result {
  plan: ActionPlan;
  out: PlanV2Out;
  lint: LintResult;
  rewritten: number;
}

/** A thought that came at the wrong moment, kept for the next pause. */
export interface SavedThought {
  text: string;
  at: number;
}

/**
 * Brain v2: a gatekeeper that keeps an "inner thought" with self-scores (turned into a decision by
 * code, see policy.ts), and a generator that reads the room first, considers several angles, gets
 * measured signals about the chat and its own tics, and passes an anti-cringe linter before sending.
 * Stateless apart from the last scene and saved thought per group (lost on restart, by design).
 */
export class BrainV2 {
  private scenes = new Map<string, GateV2Out['scene']>();
  private thoughts = new Map<string, SavedThought>();
  private contextCache = new Map<string, { text: string; version: number; at: number }>();

  constructor(private ai: AiClient, private repo: Repo, private prompts: PromptBuilder) {}

  lastScene(chatJid: string): GateV2Out['scene'] | null {
    return this.scenes.get(chatJid) ?? null;
  }

  /** A saved thought that is still fresh, taken (so it is offered once). */
  takeThought(chatJid: string): SavedThought | null {
    const t = this.thoughts.get(chatJid) ?? null;
    this.thoughts.delete(chatJid);
    return t && Date.now() - t.at < BRAIN_V2.THOUGHT_TTL_MS ? t : null;
  }

  hasThought(chatJid: string): boolean {
    const t = this.thoughts.get(chatJid);
    return !!t && Date.now() - t.at < BRAIN_V2.THOUGHT_TTL_MS;
  }

  private marker(): { prefix: string; suffix: string } {
    return {
      prefix: this.repo.getConfig('msg_prefix') ?? DEFAULT_MSG_PREFIX,
      suffix: this.repo.getConfig('msg_suffix') ?? DEFAULT_MSG_SUFFIX,
    };
  }

  /** Compact, slow-changing group context for the gatekeeper (who is here, what is going on lately). */
  private gateContext(chatJid: string): string {
    const cached = this.contextCache.get(chatJid);
    if (cached && cached.version === this.prompts.memoryVersion && Date.now() - cached.at < 5 * 60_000) return cached.text;
    const members = this.repo.getMembersForChat(chatJid);
    const who = members.map(m => {
      const name = m.display_name ?? m.jid.split('@')[0];
      const rep = this.repo.getLatestReport(m.jid);
      const gist = rep?.talking_style || rep?.bio?.split(/(?<=[.!?])\s/)[0] || '';
      return `- ${name}${gist ? `: ${gist}` : ''}`;
    }).join('\n');
    const protectedPeople = this.repo.getBoundariesForChat(chatJid).map(b => `- ${b.name}: ${b.instructions}`).join('\n');
    const bits = this.repo.getVoiceItems(chatJid)
      .filter(i => i.category === 'joke' || i.category === 'reference')
      .slice(0, 15).map(i => `- ${i.content}`).join('\n');
    const summary = this.repo.getSummary(chatJid)?.summary;
    const text = [
      `PEOPLE IN THIS CHAT:\n${who || '(nobody known yet)'}`,
      protectedPeople ? `PROTECTED PEOPLE (owner's absolute boundaries; never plan a joke that crosses them):\n${protectedPeople}` : '',
      bits ? `RUNNING JOKES AND REFERENCES OF THIS GROUP:\n${bits}` : '',
      summary ? `WHAT HAS BEEN GOING ON LATELY:\n${summary}` : '',
    ].filter(Boolean).join('\n\n');
    this.contextCache.set(chatJid, { text, version: this.prompts.memoryVersion, at: Date.now() });
    return text;
  }

  /** T1: read the chat, form a thought, score it; the policy turns that into a decision. */
  async gate(chatJid: string, consumedUpToTs: number, forceDecide: boolean, opts: { dryRun?: boolean } = {}): Promise<GateV2Result | null> {
    const rows = this.repo.getRecentMessages(chatJid, BRAIN_V2.GATE_LINES) as MsgRow[];
    const transcript = this.prompts.formatTranscript(rows, consumedUpToTs);
    const part = participation(rows);
    const lastScene = this.scenes.get(chatJid);
    const content = [
      transcript || '(chat is empty so far)',
      formatCityTimes(this.repo.getClockCities()),
      formatParticipation(part),
      part.secondsSinceBot !== null && part.secondsSinceBot < 60 ? `(You last spoke ${part.secondsSinceBot}s ago.)` : '',
      lastScene ? `Your previous read of the scene: ${lastScene.topic} / ${lastScene.vibe}${lastScene.running_bit ? ` / bit: ${lastScene.running_bit}` : ''}` : '',
      forceDecide ? 'You have already waited the maximum amount of time. Decide RESPOND, REACT or IGNORE now: WAIT is not allowed.' : '',
    ].filter(Boolean).join('\n');

    try {
      const { max_tokens, effort } = this.ai.tuning(this.ai.gatekeeperModel, 1500, 'quick');
      const response = await this.ai.client.messages.parse({
        model: this.ai.gatekeeperModel,
        max_tokens,
        system: [
          { type: 'text', text: GATEKEEPER_V2_SYSTEM, cache_control: { type: 'ephemeral', ttl: '1h' } },
          { type: 'text', text: this.gateContext(chatJid), cache_control: { type: 'ephemeral' } },
        ] as any,
        messages: [{ role: 'user', content }],
        output_config: { format: zodOutputFormat(GateV2Schema), ...(effort ? { effort } : {}) },
      });
      this.ai.recordUsage(this.ai.gatekeeperModel, response.usage, 't1', chatJid);
      const out = response.parsed_output;
      if (!out) {
        logger.warn({ stop: response.stop_reason }, 'brain v2 gatekeeper returned unparseable output');
        return null;
      }
      const policy = decide(out, part, forceDecide);
      if (!opts.dryRun) {
        this.scenes.set(chatJid, out.scene);
        if (policy.saveThought && out.thought) this.thoughts.set(chatJid, { text: out.thought.text, at: Date.now() });
        if (policy.decision === 'RESPOND') this.thoughts.delete(chatJid);
      }
      return { out, policy };
    } catch (err) {
      logger.error({ err }, 'brain v2 gatekeeper call failed');
      return null;
    }
  }

  /** The measured context block for the generator: scene, style numbers, own tics, share, callbacks. */
  private signalsBlock(chatJid: string, rows: MsgRow[], consumedUpToTs: number | null): { text: string; medianLen: number; lowercaseShare: number; botTexts: string[]; humanTexts: string[] } {
    const marker = this.marker();
    const history = this.repo.getRecentMessages(chatJid, BRAIN_V2.SIGNAL_LINES) as MsgRow[];
    const botTexts = history.filter(r => r.is_bot && r.type === 'text').map(r => stripMarker(r.text ?? '', marker.prefix, marker.suffix));
    const humanTexts = history.filter(r => !r.is_bot && r.type === 'text').map(r => r.text ?? '');
    const style = styleStats(history);
    const tics = botTics(botTexts.slice(-BRAIN_V2.TICS_WINDOW));
    const part = participation(history);
    const scene = this.scenes.get(chatJid);

    const newRows = consumedUpToTs === null ? rows.slice(-6) : rows.filter(r => r.ts > consumedUpToTs);
    const oldest = rows.length ? rows[0].ts : Date.now();
    const callbacks = formatCallbacks(this.repo.searchOlderMessages(chatJid, oldest, callbackKeywords(newRows), BRAIN_V2.CALLBACKS) as MsgRow[]);

    const parts = [
      scene ? `SCENE RIGHT NOW: ${scene.topic}. ${scene.threads}. vibe: ${scene.vibe}.${scene.running_bit ? ` running bit: ${scene.running_bit}${scene.bit_played_out ? ' (played out, let it go)' : ''}.` : ''}` : '',
      style ? formatStyleStats(style) : '',
      tics ? formatTics(tics) : '',
      formatLanded(landedLines(history, t => stripMarker(t, marker.prefix, marker.suffix))) ?? '',
      formatParticipation(part),
      callbacks ?? '',
    ].filter(Boolean);
    return { text: parts.join('\n\n'), medianLen: style?.medianLen ?? 0, lowercaseShare: style?.lowercaseShare ?? 0, botTexts, humanTexts };
  }

  /** T2: read, consider angles, write; then lint and (only if needed) one cheap rewrite. */
  async generate(input: GenerateV2Input): Promise<GenerateV2Result | null> {
    const rows = this.repo.getRecentMessages(input.chatJid, input.transcriptLines ?? ARBITER.TRANSCRIPT_LINES) as MsgRow[];
    const transcript = this.prompts.formatTranscript(rows, input.consumedUpToTs);
    const signals = this.signalsBlock(input.chatJid, rows, input.consumedUpToTs);

    const parts: string[] = [`Current group chat transcript:`, transcript || '(chat is empty so far)', signals.text];
    if (input.addressIds?.length) {
      parts.push(`HINT: address ${input.addressIds.map(i => '#' + i).join(', ')}${input.gatekeeperReason ? ` (${input.gatekeeperReason})` : ''}`);
    }
    if (input.thought) {
      parts.push(`A THOUGHT YOU HAD A MOMENT AGO (the chat has just paused): "${input.thought}". If it still lands, say it now in your own words, like it just came to you. If the moment has passed, send nothing.`);
    }
    if (input.operatorInstruction) {
      parts.push(`<operator_instruction>${input.operatorInstruction}</operator_instruction>`);
      parts.push('(An operator instruction is present: you MUST act on it, EXCEPT where it would cross an ABSOLUTE PER-PERSON BOUNDARY from the control panel. Those always win, even over this. "nothing" is not an acceptable plan here.)');
    }
    parts.push(`Read the room, pick your angle, then decide your actions.\n\n${formatCityTimes(this.repo.getClockCities())}`);

    const sinceTs = input.consumedUpToTs ?? Date.now() - 10 * 60_000;
    const imageBlocks: any[] = [];
    for (const row of (this.repo.getRecentImageMessages(input.chatJid, sinceTs, VISION.MAX_IMAGES_PER_CALL) as any[]).reverse()) {
      try {
        const data = fs.readFileSync(row.media_path).toString('base64');
        imageBlocks.push({ type: 'text', text: `Image in message #${row.short_id}:` });
        imageBlocks.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } });
      } catch { /* file gone: skip */ }
    }
    const userContent: any = imageBlocks.length ? [{ type: 'text', text: parts.join('\n\n') }, ...imageBlocks] : parts.join('\n\n');

    try {
      const { max_tokens, effort } = this.ai.tuning(this.ai.generationModel, BRAIN_V2.GEN_MAX_TOKENS, 'reply');
      const response = await this.ai.client.messages.parse({
        model: this.ai.generationModel,
        max_tokens,
        system: this.prompts.buildSystemBlocksV2(input.chatJid) as any,
        messages: [{ role: 'user', content: userContent }],
        output_config: { format: zodOutputFormat(PlanV2Schema), ...(effort ? { effort } : {}) },
      });
      this.ai.recordUsage(this.ai.generationModel, response.usage, 't2', input.chatJid);
      const out = response.parsed_output;
      if (!out) {
        logger.warn({ stop: response.stop_reason }, 'brain v2 generator returned unparseable output, staying silent');
        return null;
      }

      if (!input.dryRun) {
        const obs = out.observation;
        if (obs?.note?.trim() && obs.about_message_id) {
          const target = this.repo.getMessageByShortId(obs.about_message_id);
          if (target?.sender_jid && !target.is_bot && !target.is_owner) {
            this.repo.insertMemberObservation(target.sender_jid, input.chatJid, obs.note.trim());
          }
        }
      }

      let actions = (out.actions as BotAction[]).slice(0, ARBITER.MAX_ACTIONS);
      const serious = out.read.sincere || out.read.vibe === 'serious';
      const lintCtx = { medianLen: signals.medianLen, lowercaseShare: signals.lowercaseShare, serious, marker: this.marker() };
      let lint = lintPlan(actions, { ...lintCtx, recentBotTexts: signals.botTexts.slice(-30), recentHumanTexts: signals.humanTexts.slice(-40) });
      let rewritten = 0;
      if (lint.issues.length > 0) {
        const fixed = await this.rewrite(input.chatJid, lint);
        if (fixed) {
          rewritten = fixed.count;
          lint = { ...lintPlan(fixed.actions, { ...lintCtx, recentBotTexts: [], recentHumanTexts: [] }), dropped: lint.dropped };
        }
      }
      actions = lint.actions;
      const angle = out.angles[out.pick] ?? out.angles[0];
      const note = [
        out.note,
        angle ? `angle: ${angle.device}` : '',
        out.read.sincere ? 'sincere moment' : '',
        lint.dropped.length ? `dropped ${lint.dropped.length}` : '',
        rewritten ? `rewrote ${rewritten}` : '',
      ].filter(Boolean).join(' | ');
      return { plan: { actions, note }, out, lint, rewritten };
    } catch (err) {
      logger.error({ err }, 'brain v2 generator call failed, staying silent');
      return null;
    }
  }

  /** One cheap pass that fixes only the flagged messages. Returns null if it fails (plan kept as is). */
  private async rewrite(chatJid: string, lint: LintResult): Promise<{ actions: BotAction[]; count: number } | null> {
    const byIndex = new Map<number, string[]>();
    for (const i of lint.issues) byIndex.set(i.index, [...(byIndex.get(i.index) ?? []), i.problem]);
    const items = [...byIndex.entries()].map(([index, problems]) => {
      const a = lint.actions[index] as any;
      return `[${index}] (${a?.type}) ${a?.text ?? ''}\n    problems: ${problems.join('; ')}`;
    }).join('\n');
    try {
      const model = this.ai.gatekeeperModel;
      const { max_tokens, effort } = this.ai.tuning(model, 1000, 'quick');
      const response = await this.ai.client.messages.parse({
        model,
        max_tokens,
        system: REWRITE_SYSTEM,
        messages: [{ role: 'user', content: `MESSAGES TO FIX:\n${items}` }],
        output_config: { format: zodOutputFormat(RewriteSchema), ...(effort ? { effort } : {}) },
      });
      this.ai.recordUsage(model, response.usage, 't2', chatJid);
      const parsed = response.parsed_output;
      if (!parsed) return null;
      let count = 0;
      const actions = lint.actions.map((a, i) => {
        const fix = parsed.fixes.find(f => f.index === i)?.text?.trim();
        if (!fix || !byIndex.has(i) || !('text' in a)) return a;
        count += 1;
        return { ...a, text: fix } as BotAction;
      });
      return { actions, count };
    } catch (err) {
      logger.warn({ err }, 'brain v2 rewrite failed, sending the plan as linted');
      return null;
    }
  }
}
