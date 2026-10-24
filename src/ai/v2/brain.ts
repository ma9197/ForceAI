import fs from 'node:fs';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { ARBITER, BOT_NAME, BRAIN_V2, DEFAULT_MSG_PREFIX, DEFAULT_MSG_SUFFIX, VISION } from '../../config.js';
import { logger } from '../../logger.js';
import type { Repo } from '../../memory/repo.js';
import type { ActionPlan, BotAction } from '../../types.js';
import type { AiClient } from '../client.js';
import type { GenerateInput } from '../generator.js';
import type { PromptBuilder } from '../prompts.js';
import { laughEndShare, lintPlan, type LintResult } from './lint.js';
import { CHATTINESS_SHIFT, decide, type PolicyResult } from './policy.js';
import { CRITIC_SYSTEM, GATEKEEPER_V2_SYSTEM, REWRITE_SYSTEM } from './prompts.js';
import { formatTasteRules, readTasteRules } from './taste.js';
import { CriticSchema, GateV2Schema, PlanV2Schema, RewriteSchema, type GateV2Out, type PlanV2Out } from './schemas.js';
import {
  botTargets, botTics, callbackKeywords, dynamics, formatBits, formatCallbacks, rankCallbacks, formatClockLine, formatDecisionFeedback, formatLinesThatWorked,
  formatReactionHabit, formatRoomNow, formatStyleStats, formatTakes, formatTeasing, formatTics, groupLaughs, ironyCues, landedLines, ownTakes,
  participation, reception, roomMap, runningBits, stripMarker, styleStats, teaseReception, type Bit, type Dynamics, type MsgRow, type StyleStats,
} from './signals.js';

export interface GateV2Result {
  out: GateV2Out;
  policy: PolicyResult;
}

export interface GenerateV2Input extends GenerateInput {
  /** the gatekeeper's inner thought: 'now' = the reason it decided to talk, 'pause' = saved earlier, offered at a pause */
  thought?: string | null;
  thoughtWhen?: 'now' | 'pause';
  /** nobody asked: the text gets a second opinion before it is sent (Settings, on by default) */
  unprompted?: boolean;
  /** preview: no observations saved, nothing recorded besides token usage */
  dryRun?: boolean;
  /** shadow mode: read the shadow's own scene (the live v2 scene does not exist in a v1 group) */
  shadow?: boolean;
  /** replay: write as if it were this moment (the chat up to then only); implies a dry run */
  untilTs?: number;
  /** the scene the thinking stage read for this moment (replay passes the one it just got) */
  scene?: GateV2Out['scene'];
}

export interface GenerateV2Result {
  plan: ActionPlan;
  out: PlanV2Out;
  lint: LintResult;
  rewritten: number;
  /** set when the second opinion vetoed an unprompted line */
  vetoed?: string;
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
  /** shadow mode keeps its own scene from call to call, like real v2 does, without touching v2's state */
  private shadowScenes = new Map<string, GateV2Out['scene']>();
  private bitsCache = new Map<string, { bits: Bit[]; at: number }>();

  constructor(private ai: AiClient, private repo: Repo, private prompts: PromptBuilder) {}

  lastScene(chatJid: string): GateV2Out['scene'] | null {
    return this.scenes.get(chatJid) ?? null;
  }

  /** The owner switched brains: drop this group's scenes and saved thought (no read from another mode). */
  forget(chatJid: string): void {
    this.scenes.delete(chatJid);
    this.shadowScenes.delete(chatJid);
    this.thoughts.delete(chatJid);
  }

  /** The owner rated something or new house rules came in: rebuild this group's gate context (only v2's, only this group). */
  invalidate(chatJid: string): void {
    this.contextCache.delete(chatJid);
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

  /**
   * Compact, slow-changing group context for the gatekeeper (who is here, what is going on lately). A
   * replay (untilTs) gets it as it was then: no owner calls (their reasons quote later chat), no house
   * rules learned later, phrases counted up to that moment. Never cached.
   */
  private gateContext(chatJid: string, untilTs?: number): string {
    const replay = untilTs !== undefined;
    const cached = this.contextCache.get(chatJid);
    if (!replay && cached && cached.version === this.prompts.memoryVersion && Date.now() - cached.at < 5 * 60_000) return cached.text;
    const members = this.repo.getMembersForChat(chatJid);
    const who = members.map(m => {
      const name = m.display_name ?? m.jid.split('@')[0];
      const rep = this.repo.getLatestReport(m.jid);
      const gist = rep?.talking_style || rep?.bio?.split(/(?<=[.!?])\s/)[0] || '';
      return `- ${name}${gist ? `: ${gist}` : ''}`;
    }).join('\n');
    const protectedPeople = this.repo.getBoundariesForChat(chatJid).map(b => `- ${b.name}: ${b.instructions}`).join('\n');
    // the newest 15 (a replay: only ones learned by then)
    const jokes = this.repo.getVoiceItems(chatJid).filter(i => (i.category === 'joke' || i.category === 'reference') && (!replay || i.created_at <= untilTs!))
      .sort((a, b) => b.created_at - a.created_at).slice(0, 15);
    const bits = jokes.map(i => `- ${i.content}`).join('\n');
    const summary = this.repo.getSummary(chatJid)?.summary;
    const calls = replay ? null : formatDecisionFeedback(this.repo.getDecisionFeedback(chatJid, BRAIN_V2.DECISION_EXAMPLES));
    // measured phrases the running-jokes list does not already cover
    const jokeText = jokes.map(i => i.content.toLowerCase()).join(' | ');
    const phrases = formatBits(this.bits(chatJid, untilTs).filter(b => !jokeText.includes(b.phrase)).slice(0, 4), untilTs);
    const text = [
      `PEOPLE IN THIS CHAT:\n${who || '(nobody known yet)'}`,
      protectedPeople ? `PROTECTED PEOPLE (owner's absolute boundaries; never plan a joke that crosses them):\n${protectedPeople}` : '',
      bits ? `RUNNING JOKES AND REFERENCES OF THIS GROUP:\n${bits}` : '',
      summary ? `WHAT HAS BEEN GOING ON LATELY:\n${summary}` : '',
      phrases ?? '',
      formatTasteRules(this.tasteRules(chatJid, untilTs)) ?? '',
      calls ?? '',
    ].filter(Boolean).join('\n\n');
    if (!replay) this.contextCache.set(chatJid, { text, version: this.prompts.memoryVersion, at: Date.now() });
    return text;
  }

  /**
   * T1: read the chat, form a thought, score it; the policy turns that into a decision.
   * `untilTs` (replay) reads the chat as it was at that moment; it implies a dry run.
   */
  async gate(chatJid: string, consumedUpToTs: number, forceDecide: boolean, opts: { dryRun?: boolean; untilTs?: number; shadow?: boolean } = {}): Promise<GateV2Result | null> {
    const replay = opts.untilTs !== undefined;
    const now = opts.untilTs ?? Date.now();
    const recent = (n: number) => (replay ? this.repo.getRecentMessagesBefore(chatJid, now, n) : this.repo.getRecentMessages(chatJid, n)) as MsgRow[];
    const rows = recent(BRAIN_V2.GATE_LINES);
    const history = recent(BRAIN_V2.SIGNAL_LINES);
    const transcript = this.prompts.formatTranscript(rows, consumedUpToTs);
    const part = participation(rows, now);
    const dyn = dynamics(rows, BOT_NAME, now);
    const rec = reception(history, BOT_NAME, now);
    const lastScene = replay ? undefined : opts.shadow ? this.shadowScenes.get(chatJid) : this.scenes.get(chatJid);
    const content = [
      transcript || '(chat is empty so far)',
      replay ? '' : formatClockLine(this.repo.getClockCities()),
      formatRoomNow({ dyn, rec, part, map: roomMap(rows, this.memberNames(chatJid), BOT_NAME, now), cues: ironyCues(history, now) }, 'gate') ?? '',
      formatReactionHabit(history) ?? '',
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
          { type: 'text', text: replay ? this.withoutLaterSummary([{ type: 'text', text: this.gateContext(chatJid, now) }], chatJid, now)[0].text : this.gateContext(chatJid), cache_control: { type: 'ephemeral' } },
        ] as any,
        messages: [{ role: 'user', content }],
        output_config: { format: zodOutputFormat(GateV2Schema), ...(effort ? { effort } : {}) },
      });
      this.ai.recordUsage(this.ai.gatekeeperModel, response.usage, opts.shadow ? 'shadow' : 't1', chatJid);
      const out = response.parsed_output;
      if (!out) {
        logger.warn({ stop: response.stop_reason }, 'brain v2 gatekeeper returned unparseable output');
        return null;
      }
      const policy = decide(out, part, forceDecide, CHATTINESS_SHIFT[this.repo.getV2Chattiness(chatJid)] ?? 0, { dyn, rec });
      if (opts.shadow) this.shadowScenes.set(chatJid, out.scene);
      if (!opts.dryRun && !replay) {
        this.scenes.set(chatJid, out.scene);
        // a saved thought belongs to the moment it came from: a new read replaces it or lets it go
        // (kept only while someone is still mid-thought), and bad news always drops it
        if (dyn.serious || out.scene.vibe === 'serious' || policy.decision === 'RESPOND') this.thoughts.delete(chatJid);
        else if (policy.saveThought && out.thought) this.thoughts.set(chatJid, { text: out.thought.text, at: Date.now() });
        else if (policy.decision !== 'WAIT') this.thoughts.delete(chatJid);
      }
      return { out, policy };
    } catch (err) {
      logger.error({ err }, 'brain v2 gatekeeper call failed');
      return null;
    }
  }

  private memberNames(chatJid: string): string[] {
    return this.repo.getMembersForChat(chatJid).map(m => m.display_name ?? '').filter(Boolean);
  }

  /**
   * Replay: the running summary is rewritten every few dozen messages, so it usually describes events
   * after the replayed moment. Leave it out then, so v2 cannot "know" what had not happened yet.
   */
  private laterSummary(chatJid: string, untilTs: number): string | null {
    const s = this.repo.getSummary(chatJid);
    return s?.summary && (s.last_message_ts ?? 0) > untilTs ? s.summary : null;
  }

  private withoutLaterSummary(blocks: { type: string; text: string }[], chatJid: string, untilTs: number): { type: string; text: string }[] {
    const later = this.laterSummary(chatJid, untilTs);
    return later ? blocks.map(b => ({ ...b, text: b.text.split(later).join('(left out in a replay: it describes later events)') })) : blocks;
  }

  /** House rules, minus ones learned after a replayed moment. */
  private tasteRules(chatJid: string, untilTs?: number): string[] {
    if (untilTs !== undefined && Number(this.repo.getConfig(`v2_taste_at_${chatJid}`) ?? 0) > untilTs) return [];
    return readTasteRules(this.repo, chatJid);
  }

  /** The group's running phrases over the last days (a heavier query, so cached per group; a replay counts them as they were then). */
  private bits(chatJid: string, untilTs?: number): Bit[] {
    if (untilTs !== undefined) {
      const rows = (this.repo.getTextMessagesSince(chatJid, untilTs - BRAIN_V2.BITS_DAYS * 86_400_000, BRAIN_V2.BITS_MAX_ROWS, false) as MsgRow[]).filter(r => r.ts <= untilTs);
      return runningBits(rows, BOT_NAME);
    }
    const cached = this.bitsCache.get(chatJid);
    if (cached && Date.now() - cached.at < BRAIN_V2.BITS_CACHE_MS) return cached.bits;
    const rows = this.repo.getTextMessagesSince(chatJid, Date.now() - BRAIN_V2.BITS_DAYS * 86_400_000, BRAIN_V2.BITS_MAX_ROWS, false) as MsgRow[];
    const bits = runningBits(rows, BOT_NAME);
    this.bitsCache.set(chatJid, { bits, at: Date.now() });
    return bits;
  }

  /** The measured context block for the generator: scene, style numbers, own tics, share, callbacks. */
  private signalsBlock(chatJid: string, rows: MsgRow[], consumedUpToTs: number | null, asked: boolean, shadow = false, untilTs?: number, sceneNow?: GateV2Out['scene']): { text: string; medianLen: number; lowercaseShare: number; botTexts: string[]; humanTexts: string[]; dyn: Dynamics; style: StyleStats | null; disliked: string[]; callbackTexts: string[] } {
    const replay = untilTs !== undefined;
    const now = untilTs ?? Date.now();
    const marker = this.marker();
    const strip = (t: string) => stripMarker(t, marker.prefix, marker.suffix);
    const names = this.memberNames(chatJid);
    // the owner's 👎 lines: kept out of what it learns from, and close copies are blocked by the linter
    const disliked = this.repo.getFeedbackLines(chatJid, -1, BRAIN_V2.TASTE_LINES * 4).map(strip);
    const notDisliked = (t: string) => !disliked.includes(t);
    const history = (replay ? this.repo.getRecentMessagesBefore(chatJid, now, BRAIN_V2.SIGNAL_LINES) : this.repo.getRecentMessages(chatJid, BRAIN_V2.SIGNAL_LINES)) as MsgRow[];
    const botTexts = history.filter(r => r.is_bot && r.type === 'text').map(r => stripMarker(r.text ?? '', marker.prefix, marker.suffix));
    const humanTexts = history.filter(r => !r.is_bot && r.type === 'text').map(r => r.text ?? '');
    const style = styleStats(history);
    const tics = botTics(botTexts.slice(-BRAIN_V2.TICS_WINDOW), names);
    const part = participation(history, now);
    const scene = sceneNow ?? (replay ? undefined : shadow ? this.shadowScenes.get(chatJid) : this.scenes.get(chatJid));
    const dyn = dynamics(rows, BOT_NAME, now);

    const newRows = consumedUpToTs === null ? rows.slice(-6) : rows.filter(r => r.ts > consumedUpToTs);
    // callbacks come from before the transcript and at least an hour back (not the last few minutes)
    const before = Math.min(rows.length ? rows[0].ts : now, now - 3_600_000);
    // three times the candidates, so the moments that got laughs back then can rise to the top
    const cands = this.repo.searchOlderMessages(chatJid, before, callbackKeywords(newRows), BRAIN_V2.CALLBACKS * 3, now - BRAIN_V2.CALLBACK_DAYS * 86_400_000) as (MsgRow & { hits: number })[];
    const replies = this.repo.getRepliesTo(chatJid, cands.flatMap(c => (c.id ? [c.id] : [])), now) as MsgRow[]; // a replay never sees later laughs
    const shownCallbacks = rankCallbacks(cands, replies, BRAIN_V2.CALLBACKS)
      .map(r => (r.is_bot ? { ...r, text: strip(r.text ?? '') } : r))
      .filter(r => !r.is_bot || notDisliked(r.text ?? ''));
    const callbacks = formatCallbacks(shownCallbacks);
    const callbackTexts = shownCallbacks.map(r => r.text ?? '');

    const targets = botTargets(history.filter(r => r.is_bot).slice(-BRAIN_V2.TARGET_WINDOW), names, id => this.repo.getMessageById(id)?.sender_name ?? null);
    const easyOn = targets.filter(t => t.count >= BRAIN_V2.TARGET_MIN).map(t => t.name);
    const easyFirst = easyOn.map(n => n.trim().split(/\s+/)[0].toLowerCase());
    // the group's phrases, minus a bit the scene calls played out and phrases about someone to go easy on
    const playedOut = scene?.bit_played_out && scene.running_bit ? scene.running_bit.toLowerCase() : '';
    const phrases = this.bits(chatJid, untilTs).filter(b => !(playedOut && playedOut.includes(b.phrase)) && !easyFirst.some(n => b.phrase.split(' ').includes(n)));

    const parts = [
      scene ? `SCENE RIGHT NOW: ${scene.topic}. ${scene.threads}. vibe: ${scene.vibe}.${scene.running_bit ? ` running bit: ${scene.running_bit}${scene.bit_played_out ? ' (played out, let it go)' : ''}.` : ''}` : '',
      style ? formatStyleStats(style) : '',
      tics ? formatTics(tics) : '',
      formatRoomNow({ dyn, part, asked, map: roomMap(rows, names, BOT_NAME, now), cues: ironyCues(history, now) }, 'writer') ?? '',
      formatTasteRules(this.tasteRules(chatJid, untilTs)) ?? '',
      formatLinesThatWorked(
        this.repo.getFeedbackLines(chatJid, 1, BRAIN_V2.TASTE_LINES, now).map(strip), // a replay never sees lines liked later
        landedLines(history, strip).filter(l => notDisliked(l.text)),
        groupLaughs(history),
        { emojis: tics?.emojis.map(e => e.emoji), names: easyOn },
      ) ?? '',
      formatTeasing(targets, teaseReception(history, names), BRAIN_V2.TARGET_MIN, BRAIN_V2.TARGET_WINDOW) ?? '',
      callbacks ?? '',
      formatBits(phrases, now) ?? '',
      formatTakes(ownTakes((this.repo.getTextMessagesSince(chatJid, now - 7 * 86_400_000, 200, true) as MsgRow[]).filter(r => r.ts <= now), strip, now).filter(x => notDisliked(x.text)), now) ?? '',
    ].filter(Boolean);
    return { text: parts.join('\n\n'), medianLen: style?.medianLen ?? 0, lowercaseShare: style?.lowercaseShare ?? 0, botTexts, humanTexts, dyn, style, disliked, callbackTexts };
  }

  /** T2: read, consider angles, write; then lint and (only if needed) one cheap rewrite. */
  async generate(input: GenerateV2Input): Promise<GenerateV2Result | null> {
    const replay = input.untilTs !== undefined;
    const lines = input.transcriptLines ?? ARBITER.TRANSCRIPT_LINES;
    const rows = (replay ? this.repo.getRecentMessagesBefore(input.chatJid, input.untilTs!, lines) : this.repo.getRecentMessages(input.chatJid, lines)) as MsgRow[];
    const transcript = this.prompts.formatTranscript(rows, input.consumedUpToTs);
    // someone talked to it (a mention, a reply, an owner instruction): it answers, no second opinion
    const asked = !input.unprompted || !!input.operatorInstruction;
    const tier = input.shadow ? 'shadow' as const : 't2' as const; // shadow lines are never sent: counted apart from real replies
    const signals = this.signalsBlock(input.chatJid, rows, input.consumedUpToTs, asked, !!input.shadow, input.untilTs, input.scene);

    const parts: string[] = [`Current group chat transcript:`, transcript || '(chat is empty so far)', signals.text];
    if (input.addressIds?.length) {
      parts.push(`HINT: address ${input.addressIds.map(i => '#' + i).join(', ')}${input.gatekeeperReason ? ` (${input.gatekeeperReason})` : ''}`);
    }
    if (asked && !input.operatorInstruction) {
      parts.push('Someone talked to you: answer them (if they only laughed at your line, a reaction is enough). "nothing" is not an option here.');
    }
    if (input.thought && input.thoughtWhen === 'now' && asked) {
      parts.push(`AN IDEA YOU HAD WHILE READING: "${input.thought}". Use it only if it fits your answer.`);
    } else if (input.thought && input.thoughtWhen === 'now') {
      parts.push(`YOUR INNER THOUGHT WHILE READING (why you are speaking now): "${input.thought}". It is a rough idea, not the final text: keep it if it is the best angle, sharpen it, or beat it.`);
    } else if (input.thought) {
      parts.push(`A THOUGHT YOU HAD A MOMENT AGO (the chat has just paused): "${input.thought}". If it still lands, say it now in your own words, like it just came to you. If the moment has passed, send nothing.`);
    }
    if (input.operatorInstruction) {
      parts.push(`<operator_instruction>${input.operatorInstruction}</operator_instruction>`);
      parts.push('(An operator instruction is present: you MUST act on it, EXCEPT where it would cross an ABSOLUTE PER-PERSON BOUNDARY from the control panel. Those always win, even over this. "nothing" is not an acceptable plan here.)');
    }
    parts.push(replay ? 'Read the room, pick your angle, then decide your actions.' : `Read the room, pick your angle, then decide your actions.\n\n${formatClockLine(this.repo.getClockCities())}`);

    const sinceTs = input.consumedUpToTs ?? Date.now() - 10 * 60_000;
    const imageBlocks: any[] = [];
    // a replay reads text only (images of that moment are not looked up again)
    for (const row of (replay ? [] : this.repo.getRecentImageMessages(input.chatJid, sinceTs, VISION.MAX_IMAGES_PER_CALL) as any[]).reverse()) {
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
        system: (replay ? this.withoutLaterSummary(this.prompts.buildSystemBlocksV2(input.chatJid), input.chatJid, input.untilTs!) : this.prompts.buildSystemBlocksV2(input.chatJid)) as any,
        messages: [{ role: 'user', content: userContent }],
        output_config: { format: zodOutputFormat(PlanV2Schema), ...(effort ? { effort } : {}) },
      });
      this.ai.recordUsage(this.ai.generationModel, response.usage, tier, input.chatJid);
      const out = response.parsed_output;
      if (!out) {
        logger.warn({ stop: response.stop_reason }, 'brain v2 generator returned unparseable output, staying silent');
        return null;
      }

      if (!input.dryRun && !replay) {
        const obs = out.observation;
        if (obs?.note?.trim() && obs.about_message_id) {
          const target = this.repo.getMessageByShortId(obs.about_message_id);
          if (target?.sender_jid && !target.is_bot && !target.is_owner) {
            this.repo.insertMemberObservation(target.sender_jid, input.chatJid, obs.note.trim());
          }
        }
      }

      let actions = (out.actions as BotAction[]).slice(0, ARBITER.MAX_ACTIONS);
      // the model's read, or bad news spotted in code
      const serious = out.read.sincere || out.read.vibe === 'serious' || !!signals.dyn.serious;
      const lintCtx = {
        medianLen: signals.medianLen, lowercaseShare: signals.lowercaseShare, serious, marker: this.marker(), unprompted: !asked,
        avoidTexts: signals.disliked,
        textOf: (id: string) => (this.repo.getMessageByShortId(id)?.text as string | undefined) ?? null,
        lastHumanTexts: rows.filter(r => !r.is_bot && r.type === 'text').map(r => r.text ?? ''),
        replyShare: signals.style?.replyShare,
        newestShortId: rows.filter(r => r.type !== 'reaction').slice(-1)[0]?.short_id ?? null,
        burstiness: signals.style?.burstiness,
        p80Len: signals.style?.p80Len,
        laughEndShare: laughEndShare(signals.humanTexts.slice(-40)),
        callbackTexts: signals.callbackTexts,
        // only for a jump-in: someone who asked gets a real answer, and an argument or bad news is not hype
        hype: !!signals.dyn.hype && !asked && !serious && out.read.vibe !== 'heated',
      };
      let lint = lintPlan(actions, { ...lintCtx, recentBotTexts: signals.botTexts.slice(-30), recentHumanTexts: signals.humanTexts.slice(-40) });
      let rewritten = 0;
      if (lint.issues.length > 0) {
        const fixed = await this.rewrite(input.chatJid, lint, tier);
        if (fixed) {
          rewritten = fixed.count;
          const pass2 = lintPlan(fixed.actions, { ...lintCtx, recentBotTexts: [], recentHumanTexts: [] });
          lint = { ...pass2, dropped: [...lint.dropped, ...pass2.dropped] };
        }
      }
      actions = lint.actions;

      // second opinion: an unprompted text has to convince a sharp friend, or the bot stays quiet
      let vetoed: string | undefined;
      if (!asked && this.repo.getConfig('v2_second_opinion') !== '0' && actions.some(a => a.type === 'message' || a.type === 'reply' || a.type === 'voice')) {
        const verdict = await this.critic(input.chatJid, rows, actions, tier);
        if (verdict && verdict.verdict === 'skip') {
          vetoed = verdict.reason;
          actions = [];
        }
      }

      const angle = out.angles[out.pick] ?? out.angles[0];
      const note = [
        out.note,
        angle ? `angle: ${angle.device}` : '',
        out.read.sincere ? 'sincere moment' : '',
        lint.dropped.length ? `dropped ${lint.dropped.length}` : '',
        rewritten ? `rewrote ${rewritten}` : '',
        lint.split ? 'split in 2' : '',
        vetoed ? `second opinion said skip: ${vetoed}` : '',
      ].filter(Boolean).join(' | ');
      return { plan: { actions, note }, out, lint, rewritten, vetoed };
    } catch (err) {
      logger.error({ err }, 'brain v2 generator call failed, staying silent');
      return null;
    }
  }

  /** "Would a sharp friend send this right now?" One small call; null (= send) if it fails. */
  private async critic(chatJid: string, rows: MsgRow[], actions: BotAction[], tier: 't2' | 'shadow' = 't2'): Promise<{ verdict: 'send' | 'skip'; reason: string } | null> {
    // the critic plays a member of the group, so the bot's lines are labelled by name, not "(you)"
    const transcript = this.prompts.formatTranscript(rows.slice(-BRAIN_V2.CRITIC_LINES), null).split(`${BOT_NAME} (you)`).join(BOT_NAME);
    const draft = actions.map(a => ('text' in a ? `${a.type}: ${a.text}` : a.type)).join('\n');
    try {
      const model = this.ai.gatekeeperModel;
      const { max_tokens, effort } = this.ai.tuning(model, 300, 'quick');
      const response = await this.ai.client.messages.parse({
        model,
        max_tokens,
        system: CRITIC_SYSTEM,
        messages: [{ role: 'user', content: `LAST MESSAGES:\n${transcript}\n\nWHAT IT WANTS TO SEND:\n${draft}` }],
        output_config: { format: zodOutputFormat(CriticSchema), ...(effort ? { effort } : {}) },
      });
      this.ai.recordUsage(model, response.usage, tier, chatJid);
      return response.parsed_output ?? null;
    } catch (err) {
      logger.warn({ err }, 'brain v2 second opinion failed, sending as planned');
      return null;
    }
  }

  /** One cheap pass that fixes only the flagged messages. Returns null if it fails (plan kept as is). */
  private async rewrite(chatJid: string, lint: LintResult, tier: 't2' | 'shadow' = 't2'): Promise<{ actions: BotAction[]; count: number } | null> {
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
      this.ai.recordUsage(model, response.usage, tier, chatJid);
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
