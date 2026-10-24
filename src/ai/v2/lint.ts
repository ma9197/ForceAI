import type { BotAction } from '../../types.js';
import { azOrTr } from './language.js';

/**
 * Brain v2 anti-cringe linter: free, deterministic checks on a plan before it is sent.
 * - auto-fixes small tells (em dashes, wrapping quotes, the bot writing its own marker)
 * - drops actions that repeat the bot's recent messages or parrot a human word for word
 * - reports "hard" AI tells (assistant phrases, essays, hashtags) so the generator can rewrite once
 */

/** Phrases that instantly read as an AI assistant, not a friend in a group chat. */
const AI_TELLS: { re: RegExp; label: string }[] = [
  { re: /\bas an ai\b|\blanguage model\b|\bi'?m (just )?an? (ai|bot|assistant)\b/i, label: 'talks like an AI assistant about being an AI' },
  { re: /\b(great|good|interesting) question\b/i, label: 'assistant phrase "great question"' },
  { re: /\bi (totally |completely )?understand (your|how|that you)\b/i, label: 'assistant empathy phrase' },
  { re: /\bi apologi[sz]e\b/i, label: 'formal apology' },
  { re: /\b(feel free to|let me know if|happy to help|here to help|hope (this|that) helps|rest assured)\b/i, label: 'customer-support phrase' },
  { re: /\b(it'?s|it is) (important|worth noting|crucial) to\b/i, label: 'lecture phrase' },
  { re: /\b(in conclusion|to summari[sz]e|overall,|in summary)\b/i, label: 'essay phrase' },
  { re: /\b(delve|foster|navigate the|tapestry|testament to|multifaceted)\b/i, label: 'classic AI vocabulary' },
  { re: /\b(certainly|absolutely)!/i, label: 'assistant enthusiasm' },
  { re: /\((just kidding|joking|jk|sarcasm)\)|\s\/s\b/i, label: 'explains its own joke' },
  { re: /(^|\s)#[\p{L}_]{3,}/u, label: 'hashtag' },
  // the contrast templates Antislop (arXiv 2510.15061) found far more often in model text than in human text
  { re: /\bnot (just|only|merely) [^.!?]{1,40}?(,\s*)?\b(but|it'?s|it is)\b/i, label: '"not just X but Y" template' },
  { re: /\b(it'?s|it is|this is|that'?s|that is) not (about |just |only )?[^.!?]{1,30}?,\s*(it'?s|it is|this is|that'?s|that is)\b/i, label: '"it is not X, it is Y" template' },
  { re: /;/, label: 'semicolon (nobody texts with semicolons)' },
  { re: /^(haha|lol|lmao)[ ,.!]+(true|fair|facts|exactly|so true)\b/i, label: 'stock opener' },
  { re: /^ah+,?\s+(the|yes)\b/i, label: 'stock opener "ah, the..."' },
  // ending on a question to the room just to keep the chat going: an assistant habit, not a friend's
  {
    re: new RegExp('(?<!\\p{L})(?:' + [
      "what do (?:you|y['’]?all|u) (?:guys |all )?think", 'wdyt', 'thoughts', "who['’]?s with me", 'am i right', 'anyone else', 'agree or disagree', 'right guys', 'change my mind',
      'а вы как думаете', 'что думаете', 'как думаете', 'кто со мной', 'согласны', 'kak dumaete', 'chto dumaete',
      'siz n[əe] d[üu][şs][üu]n[üu]rs[üu]n[üu]z', 'n[əe] fikirl[əe][şs]irsi(?:ni)?z', 'n[əe] deyirsi(?:ni)?z',
      'ne d[üu][şs][üu]n[üu]yorsunuz', 'sizce', 'ne diyorsunuz', 'ne dersiniz', 'kat[ıi]l[ıi]yor musunuz',
    ].join('|') + ')\\s*\\?+[\\s\\p{Extended_Pictographic}\\u{1F3FB}-\\u{1F3FF}\\u200d\\ufe0f]*$', 'iu'),
    label: 'ends on a question to the room just to keep the chat going (end where the thought ends)',
  },
];

/** Joke phrases language models lean on; flagged unless this group uses them itself. */
const STOCK_JOKES = /(?<!\p{L})(?:plot twist|the audacity|rent[- ]free|understood the assignment|chef['’]?s kiss|main character energy)(?!\p{L})/iu;

/** A laugh at the end of a message ("lol", "hahaha", "ахах", 😂). No "kek" (Turkish cake) and no "хахаль". */
const LAUGH_WORD = String.raw`(?:lol|lmao|lmfao|a?(?:ha){2,}h*|(?:ah){2,}|(?:xa){2,}|ахах[ах]*|(?:ха){2,}х*)`;
const LAUGH_END = new RegExp(String.raw`(?:(?<!\p{L})${LAUGH_WORD}|😂|🤣|💀|😭)[\s!.]*$`, 'iu');
/** The same, typed out only (an emoji there is the owner's emoji dial's business, so it is never cut). The
 * lookbehind keeps the separator run whole, so a long run of spaces is not re-scanned from every position. */
const TEXT_LAUGH_END = new RegExp(String.raw`(?<![\s,])[\s,]+${LAUGH_WORD}[!.]*$`, 'iu');

/**
 * Share of the group's own lines that end on a laugh ("X happened lol"). Lines that are only a laugh
 * ("ахахах", "😂") are replies, not lines, so they are left out. Undefined under 8 lines: not enough to say.
 */
export function laughEndShare(texts: string[]): number | undefined {
  const lines = texts.map(x => x.trim()).filter(x => (x.replace(LAUGH_END, '').match(/\p{L}+/gu) ?? []).length >= 2);
  if (lines.length < 8) return undefined;
  return lines.filter(x => LAUGH_END.test(x)).length / lines.length;
}

const EMOJI = /\p{Extended_Pictographic}/gu;
const LAUGHING = /😂|🤣|💀|😭|😹/u;

function textOf(a: BotAction): string | null {
  switch (a.type) {
    case 'message':
    case 'reply':
    case 'voice':
      return a.text;
    default:
      return null;
  }
}

function withText(a: BotAction, text: string): BotAction {
  return a.type === 'message' || a.type === 'reply' || a.type === 'voice' ? { ...a, text } : a;
}

export function normalize(t: string): string {
  return t.toLowerCase().replace(EMOJI, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/** The content words of a text (3+ letters), for near-repeat checks. */
function contentWords(t: string): Set<string> {
  return new Set(normalize(t).split(' ').filter(w => w.length >= 3));
}

/** Share of words two texts have in common (Jaccard). Only counted when both have 4+ content words. */
export function overlap(a: Set<string>, b: Set<string>): number {
  if (a.size < 4 || b.size < 4) return 0;
  let common = 0;
  for (const w of a) if (b.has(w)) common += 1;
  return common / (a.size + b.size - common);
}

/** Small tells fixed in place. */
export function autoFix(text: string, marker: { prefix: string; suffix: string }): string {
  let t = text.trim();
  if (marker.prefix.trim() && t.startsWith(marker.prefix.trim())) t = t.slice(marker.prefix.trim().length).trim();
  if (marker.suffix.trim() && t.endsWith(marker.suffix.trim())) t = t.slice(0, t.length - marker.suffix.trim().length).trim();
  // the em/en dash is the most recognised AI punctuation tell (and the owner bans it everywhere);
  // between numbers it is a score or a range ("3–1"), which keeps a plain hyphen
  t = t.replace(/(\d)\s*[\u2014\u2013]\s*(?=\d)/g, '$1-');
  t = t.replace(/\s*[\u2014\u2013]\s*/g, ', ').replace(/,\s*,/g, ',').replace(/^,\s*/, '');
  // a whole message wrapped in quotes reads like a script line
  if (/^["“].+["”]$/s.test(t) && !t.slice(1, -1).includes('"')) t = t.slice(1, -1).trim();
  return t;
}

/** 'cyrillic' / 'latin' when one script clearly dominates the letters, else null (mixed or too short). */
export function scriptOf(text: string, minLetters = 8): 'cyrillic' | 'latin' | null {
  const letters = text.replace(EMOJI, '').match(/\p{L}/gu) ?? [];
  if (letters.length < minLetters) return null;
  const cyr = letters.filter(c => /[\u0400-\u04FF]/.test(c)).length / letters.length;
  if (cyr >= 0.6) return 'cyrillic';
  if (cyr <= 0.05) return 'latin';
  return null;
}

export interface LintContext {
  recentBotTexts: string[];   // bot's recent messages, marker stripped
  recentHumanTexts: string[]; // humans' recent messages
  medianLen: number;          // humans' typical message length (0 = unknown)
  marker: { prefix: string; suffix: string };
  /** share of human messages that start lowercase; above 0.7 the bot's texts are lowercased too */
  lowercaseShare?: number;
  /** a genuinely serious moment: stickers, voice notes, polls, images and laughing reactions are held back */
  serious?: boolean;
  /** nobody asked: a repeat is dropped. When answering someone, a repeat is rewritten instead (never left unanswered) */
  unprompted?: boolean;
  /** lines the owner disliked: a close copy is treated like a repeat */
  avoidTexts?: string[];
  /** text of a message by short id (to check a reply is in the language of the message it answers) */
  textOf?: (shortId: string) => string | null;
  /** the last few human texts, newest last (the language the room is in right now) */
  lastHumanTexts?: string[];
  /** share of human messages sent as quote-replies; under 0.15 a quote of the newest message is dropped */
  replyShare?: number;
  /** short id of the newest message in the chat */
  newestShortId?: string | null;
  /** average run of messages one person sends in a row; 1.5+ means this group texts in bursts */
  burstiness?: number;
  /** 80% of human messages are shorter than this */
  p80Len?: number;
  /** share of human texts that end on a laugh; under 0.1 the bot does not laugh at its own line either */
  laughEndShare?: number;
  /** older lines shown as callbacks: copying one word for word is a repeat, not a callback */
  callbackTexts?: string[];
  /** 2+ people are shouting right now (a goal, big news) and nobody asked it anything: a long line reads like a bot */
  hype?: boolean;
}

/**
 * Phone-style typing, applied in code like LLMafia (arXiv 2506.05309) does: when the group mostly
 * types lowercase, lowercase the first letter and drop a lone final period. Keeps "?" "!" and "...".
 */
export function phoneStyle(text: string): string {
  let t = text;
  const first = t.match(/^\p{Lu}(?!\p{Lu})/u); // a capital not followed by another one (keep "LMAO", "UCL")
  // Turkish / Azerbaijani dotted "İ" lowercases to "i" (plain toLowerCase adds a combining dot)
  if (first) t = (t[0] === 'İ' ? 'i' : t.charAt(0).toLowerCase()) + t.slice(1);
  if (/[^.]\.$/.test(t)) t = t.slice(0, -1);
  return t;
}

/**
 * A reply in another language than the person it answers. Script first: they wrote Russian, it answers in
 * Latin letters, or the other way round. Then Azerbaijani answered in Turkish (both Latin; models drift
 * from Azerbaijani into Turkish), only when both sides are clear. For a plain message the room decides: the
 * last three human texts (script) or the last four with a clear verdict, at least two (Azerbaijani/Turkish).
 * English mixed with either is left alone.
 */
function languageMismatch(a: BotAction, text: string, ctx: LintContext): string | null {
  if (a.type !== 'message' && a.type !== 'reply') return null;
  const target = a.type === 'reply' && a.target_message_id && ctx.textOf ? ctx.textOf(a.target_message_id) ?? '' : null;
  const mine = scriptOf(text, 12);
  if (mine) {
    let theirs: 'cyrillic' | 'latin' | null = null;
    if (target !== null) theirs = scriptOf(target);
    else {
      const last = (ctx.lastHumanTexts ?? []).slice(-3).map(t => scriptOf(t));
      if (last.length === 3 && last.every(x => x && x === last[0])) theirs = last[0];
    }
    if (theirs && theirs !== mine) {
      return theirs === 'cyrillic'
        ? 'they wrote in Russian (Cyrillic) but this answers in another language: answer in their language and mix'
        : 'they wrote in Latin letters (English/Azerbaijani/Turkish) but this answers in Russian: answer in their language and mix';
    }
  }
  if (mine === 'cyrillic') return null;
  // only the drift models have: Azerbaijani answered in Turkish. A Turkish-looking room of Azerbaijani friends
  // is usually borrowed slang ("aynen kanka"), so the other direction is never flagged.
  if (azOrTr(text, 4) !== 'tr') return null;
  let theirs: 'az' | 'tr' | null = null;
  if (target !== null) theirs = azOrTr(target);
  else {
    const clear = (ctx.lastHumanTexts ?? []).slice(-4).map(t => azOrTr(t)).filter((x): x is 'az' | 'tr' => !!x);
    if (clear.length >= 2 && clear.every(x => x === clear[0])) theirs = clear[0];
  }
  return theirs === 'az' ? 'they write Azerbaijani but this reads Turkish: write it in Azerbaijani, the way they type it' : null;
}

export interface LintResult {
  actions: BotAction[];
  issues: { index: number; problem: string }[];
  dropped: string[];
  /** one text was split into two short ones */
  split?: boolean;
}

export function lintPlan(actions: BotAction[], ctx: LintContext): LintResult {
  const issues: { index: number; problem: string }[] = [];
  const dropped: string[] = [];
  const botSeen = new Set(ctx.recentBotTexts.map(normalize).filter(s => s.length > 3));
  const botWords = ctx.recentBotTexts.map(contentWords);
  const avoidSeen = new Set((ctx.avoidTexts ?? []).map(normalize).filter(s => s.length > 3));
  const avoidWords = (ctx.avoidTexts ?? []).map(contentWords);
  const humanSeen = new Set(ctx.recentHumanTexts.map(normalize).filter(s => s.length > 8));
  const oldSeen = new Set((ctx.callbackTexts ?? []).map(normalize).filter(s => s.length > 8));
  const out: BotAction[] = [];

  for (const a of actions) {
    if (ctx.serious && (a.type === 'sticker' || a.type === 'voice' || a.type === 'poll' || a.type === 'image')) {
      dropped.push(`${a.type} held back in a serious moment`);
      continue;
    }
    if (ctx.serious && a.type === 'reaction' && LAUGHING.test(a.emoji)) {
      dropped.push(`${a.emoji} held back in a serious moment`);
      continue;
    }
    const raw = textOf(a);
    if (raw === null) { out.push(a); continue; }
    let fixed = autoFix(raw, ctx.marker);
    // laughing at its own line in a group where nobody does that reads like a bot selling its joke
    // (before the phone-style pass, so "... again. lol" loses its lone period too)
    if (a.type !== 'voice' && ctx.laughEndShare !== undefined && ctx.laughEndShare < 0.1) {
      const cut = fixed.replace(TEXT_LAUGH_END, '').trim();
      if (cut !== fixed && cut.split(/\s+/).length >= 2) fixed = cut;
    }
    if (a.type !== 'voice' && (ctx.lowercaseShare ?? 0) > 0.7) fixed = phoneStyle(fixed);
    const norm = normalize(fixed);
    if (!norm && a.type !== 'voice' && !(fixed.match(EMOJI) ?? []).length) { dropped.push('empty text'); continue; }
    // the same joke in new words is still a repeat (LLMs recycle jokes, arXiv 2306.04563)
    const mine = contentWords(fixed);
    const repeat = norm && botSeen.has(norm) ? 'repeats something you already said'
      : botWords.some(w => overlap(mine, w) >= 0.6) ? 'too close to something you already said'
        : (norm && avoidSeen.has(norm)) || avoidWords.some(w => overlap(mine, w) >= 0.6) ? 'too close to a line your owner disliked'
          : norm && oldSeen.has(norm) ? 'repeats an old line from this chat word for word' : null;
    if (repeat && ctx.unprompted) { dropped.push(`${repeat}: "${fixed.slice(0, 60)}"`); continue; }
    if (norm && humanSeen.has(norm)) { dropped.push(`parrots a member word for word: "${fixed.slice(0, 60)}"`); continue; }

    const index = out.length;
    out.push(withText(a, fixed));
    if (repeat) issues.push({ index, problem: `${repeat}: say it in new words` });
    for (const tell of AI_TELLS) if (tell.re.test(fixed)) issues.push({ index, problem: tell.label });
    const stock = fixed.match(STOCK_JOKES);
    if (stock && !ctx.recentHumanTexts.some(t => normalize(t).includes(normalize(stock[0])))) {
      issues.push({ index, problem: `stock AI joke phrase ("${stock[0]}"): say it the way this group would` });
    }
    const limit = Math.max(220, ctx.medianLen * 6);
    if (a.type !== 'voice' && fixed.length > limit) {
      issues.push({ index, problem: `too long for this chat (${fixed.length} characters, people here write about ${ctx.medianLen || 'short'})` });
    } else if (ctx.hype && a.type !== 'voice' && fixed.length > Math.max(60, ctx.p80Len ?? 0)) {
      issues.push({ index, problem: `too long for a hype moment (${fixed.length} characters): people are shouting, say it in a few words` });
    }
    const emojis = (fixed.match(EMOJI) ?? []).length;
    if (emojis > 5) issues.push({ index, problem: `${emojis} emojis in one message` });
    const lang = languageMismatch(a, fixed, ctx);
    if (lang) issues.push({ index, problem: lang });
  }

  // more than two text messages in one go reads like a bot dumping a plan: keep the first two
  let texts = 0;
  const kept = out.filter(a => {
    if (a.type !== 'message' && a.type !== 'reply') return true;
    texts += 1;
    if (texts <= 2) return true;
    dropped.push('third text in one burst');
    return false;
  });
  const remap = new Map(out.map((a, i) => [i, kept.indexOf(a)]));
  let keptIssues = issues.map(i => ({ ...i, index: remap.get(i.index) ?? -1 })).filter(i => i.index >= 0);

  // nobody in this group quotes the message right above: a quote-reply to the newest one reads like a bot
  let final = kept.map(a => (a.type === 'reply' && ctx.replyShare !== undefined && ctx.replyShare < 0.15 && ctx.newestShortId && a.target_message_id === ctx.newestShortId
    ? { type: 'message' as const, text: a.text } : a));

  // a group that texts in bursts: one longer clean text becomes two short ones, like people send them
  const textIdx = final.flatMap((a, i) => (a.type === 'message' || a.type === 'reply' ? [i] : []));
  let split = false;
  if (textIdx.length === 1 && !keptIssues.some(i => i.index === textIdx[0]) && (ctx.burstiness ?? 1) >= 1.5) {
    const i = textIdx[0];
    const parts = splitInTwo((final[i] as { text: string }).text, Math.max(50, ctx.p80Len ?? 0));
    if (parts) {
      const tidy = (t: string) => ((ctx.lowercaseShare ?? 0) > 0.7 ? phoneStyle(t) : t);
      final = [...final.slice(0, i), withText(final[i], tidy(parts[0])), { type: 'message', text: tidy(parts[1]) }, ...final.slice(i + 1)];
      keptIssues = keptIssues.map(x => (x.index > i ? { ...x, index: x.index + 1 } : x));
      split = true;
    }
  }

  return { actions: final, issues: keptIssues, dropped, split };
}

/**
 * Two sentences, together longer than people here usually write: split at the sentence break nearest
 * the middle. Null when it should stay one message (one sentence, too short, too long, a tiny half).
 */
export function splitInTwo(text: string, minLen: number): [string, string] | null {
  const t = text.trim();
  if (t.length <= minLen || t.length > 280 || t.includes('\n')) return null;
  const breaks = [...t.matchAll(/[.!?…]+(?=\s+\S)/g)].map(m => m.index! + m[0].length);
  if (breaks.length === 0 || breaks.length > 2) return null;
  const at = breaks.sort((a, b) => Math.abs(a - t.length / 2) - Math.abs(b - t.length / 2))[0];
  const first = t.slice(0, at).trim();
  const second = t.slice(at).trim();
  if (first.length < 8 || second.length < 8) return null;
  return [first, second];
}
