import type { GateV2Out } from './schemas.js';
import { ignoredStreak, type Dynamics, type Participation, type Reception } from './signals.js';

/**
 * Brain v2 turn-taking, in code (the "Inner Thoughts" idea: an agent keeps forming thoughts while it
 * reads along, and speaks when a thought's intrinsic motivation is high enough). The model scores its
 * own thought; this policy turns the scores into a decision with a threshold that rises when the bot
 * has been talking a lot and falls when it has been quiet. Addressed messages always get an answer.
 */

export const POLICY = {
  BASE_THRESHOLD: 6.5,       // motivation (0-10) a thought needs to be said unprompted
  UPGRADE_MARGIN: 1.0,       // model said IGNORE but the thought clears threshold by this much: speak
  SAVE_MIN_RELEVANCE: 6,     // a good thought at a bad moment is saved for the next lull
  SAVE_MIN_HUMOR: 6,
  SILENCE_STEP: 0.04,        // each human message since the bot last spoke lowers the bar a little...
  SILENCE_MAX: 1.0,          // ...up to this much
  HARD_SHARE_CAP: 0.45,      // above this share of recent messages: no unprompted lines at all
  MIN_SPARK: 6,              // an unprompted line must be funny or new (humor or novelty at least this)
  PRIVATE_PAIR: 0.8,         // two people in a back-and-forth: jumping in needs more
  STORYTELLER: 0.5,          // someone mid-story: let them finish
  HANGING_QUESTION: -0.5,    // a question nobody answered: a natural moment to come in
  IGNORED_STEP: 0.5,         // each ignored unprompted line after the first raises the bar...
  IGNORED_MAX: 1.0,          // ...up to this much
  LAUGHED: -0.3,             // two recent unprompted lines got laughs: the room is with it
} as const;

/** Measured room signals (signals.ts) that move the bar for unprompted lines. */
export interface Room {
  dyn?: Dynamics;
  rec?: Reception[];
}

const LAUGHING = /[😂🤣💀😭😹]/u;

/** How the room moves the bar, with short notes for the live feed. */
export function roomShift(room: Room): { delta: number; notes: string[] } {
  let delta = 0;
  const notes: string[] = [];
  const add = (d: number, note: string) => { delta += d; notes.push(`${note} ${d > 0 ? '+' : ''}${d}`); };
  if (room.dyn?.privatePair) add(POLICY.PRIVATE_PAIR, 'pair talking');
  if (room.dyn?.storyteller) add(POLICY.STORYTELLER, 'mid-story');
  if (room.dyn?.hangingQuestion) add(POLICY.HANGING_QUESTION, 'open question');
  const streak = ignoredStreak(room.rec ?? []);
  if (streak >= 2) add(Math.min(POLICY.IGNORED_MAX, POLICY.IGNORED_STEP * (streak - 1)), `${streak} ignored`);
  else if ((room.rec ?? []).filter(r => r === 'laughed').length >= 2) add(POLICY.LAUGHED, 'landing');
  return { delta: Math.round(delta * 10) / 10, notes };
}

export type FinalDecision = 'RESPOND' | 'WAIT' | 'IGNORE' | 'REACT';

export interface PolicyResult {
  decision: FinalDecision;
  motivation: number;
  threshold: number;
  /** a strong thought that came at the wrong moment: offer it again when the chat pauses */
  saveThought: boolean;
  why: string;
  /** what moved the bar (for the live feed), e.g. "pair talking +0.8" */
  room?: string[];
}

export function motivation(s: GateV2Out['scores']): number {
  const clamp = (x: number) => Math.max(0, Math.min(10, Number.isFinite(x) ? x : 0));
  return 0.25 * clamp(s.relevance) + 0.2 * clamp(s.novelty) + 0.25 * clamp(s.humor) + 0.2 * clamp(s.timing) + 0.1 * clamp(s.fit);
}

/** Settings "Brain v2 chattiness": moves the bar for unprompted lines. Answers when addressed are unaffected. */
export const CHATTINESS_SHIFT: Record<string, number> = { quiet: 1, balanced: 0, chatty: -1 };

export function threshold(p: Participation, vibe: GateV2Out['scene']['vibe'], shift = 0): number {
  let t = POLICY.BASE_THRESHOLD + shift;
  if (p.botShare >= 0.35) t += 1.5;
  else if (p.botShare >= 0.2) t += 0.7;
  if (p.secondsSinceBot !== null && p.secondsSinceBot < 45) t += 1;
  t -= Math.min(POLICY.SILENCE_MAX, p.humansSinceBot * POLICY.SILENCE_STEP); // quiet for a while: a good line is welcome
  if (vibe === 'serious') t += 1;
  return Math.round(t * 10) / 10;
}

export function decide(out: GateV2Out, p: Participation, forceDecide: boolean, shift = 0, room: Room = {}): PolicyResult {
  const m = out.thought ? Math.round(motivation(out.scores) * 10) / 10 : 0;
  // bad news spotted in code counts as a serious moment even if the model read it as banter
  const vibe = room.dyn?.serious ? 'serious' : out.scene.vibe;
  const adj = roomShift(room);
  const t = Math.round((threshold(p, vibe, shift) + adj.delta) * 10) / 10;
  // talk-share cap (Time to Talk, arXiv 2506.05309): past it, only answer when addressed
  // and on-topic-but-flat is not enough: it has to be funny or add something new
  const spark = Math.max(out.scores.humor, out.scores.novelty) >= POLICY.MIN_SPARK;
  const strong = !!out.thought && m >= t && spark && p.botShare < POLICY.HARD_SHARE_CAP;
  const saveThought = !!out.thought && out.scores.timing < 6
    && out.scores.relevance >= POLICY.SAVE_MIN_RELEVANCE && out.scores.humor >= POLICY.SAVE_MIN_HUMOR;
  // never a laughing reaction in a serious moment
  const react = out.react && out.react.target_message_id && out.react.emoji && !(vibe === 'serious' && LAUGHING.test(out.react.emoji));
  const base = { motivation: m, threshold: t, room: adj.notes };

  if (out.addressed) {
    // talked to: answer (or keep waiting if they are clearly still typing)
    if (out.decision === 'WAIT' && !forceDecide) return { ...base, decision: 'WAIT', saveThought: false, why: 'addressed, but they are mid-thought' };
    return { ...base, decision: 'RESPOND', saveThought: false, why: 'addressed' };
  }

  switch (out.decision) {
    case 'WAIT':
      if (!forceDecide) return { ...base, decision: 'WAIT', saveThought: false, why: 'mid-thought' };
      return strong
        ? { ...base, decision: 'RESPOND', saveThought: false, why: 'waited enough, thought is strong' }
        : { ...base, decision: react ? 'REACT' : 'IGNORE', saveThought, why: 'waited enough, thought too weak' };
    case 'RESPOND':
      if (strong) return { ...base, decision: 'RESPOND', saveThought: false, why: 'strong thought, good moment' };
      // the model wanted to talk but the thought is not good enough for an unprompted line
      return { ...base, decision: react ? 'REACT' : 'IGNORE', saveThought, why: 'unprompted line not strong enough' };
    case 'REACT':
      if (react) return { ...base, decision: 'REACT', saveThought, why: 'a reaction is enough' };
      return { ...base, decision: 'IGNORE', saveThought, why: vibe === 'serious' ? 'no laughing reaction in a serious moment' : 'react without a target' };
    case 'IGNORE':
    default:
      if (strong && m >= t + POLICY.UPGRADE_MARGIN && out.scores.timing >= 6) {
        return { ...base, decision: 'RESPOND', saveThought: false, why: 'thought too good to keep' };
      }
      return { ...base, decision: 'IGNORE', saveThought, why: 'nothing worth adding' };
  }
}
