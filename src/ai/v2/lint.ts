import type { BotAction } from '../../types.js';

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
];

const EMOJI = /\p{Extended_Pictographic}/gu;

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

/** Small tells fixed in place. */
export function autoFix(text: string, marker: { prefix: string; suffix: string }): string {
  let t = text.trim();
  if (marker.prefix.trim() && t.startsWith(marker.prefix.trim())) t = t.slice(marker.prefix.trim().length).trim();
  if (marker.suffix.trim() && t.endsWith(marker.suffix.trim())) t = t.slice(0, t.length - marker.suffix.trim().length).trim();
  // the em/en dash is the most recognised AI punctuation tell (and the owner bans it everywhere)
  t = t.replace(/\s*[\u2014\u2013]\s*/g, ', ').replace(/,\s*,/g, ',').replace(/^,\s*/, '');
  // a whole message wrapped in quotes reads like a script line
  if (/^["“].+["”]$/s.test(t) && !t.slice(1, -1).includes('"')) t = t.slice(1, -1).trim();
  return t;
}

export interface LintContext {
  recentBotTexts: string[];   // bot's recent messages, marker stripped
  recentHumanTexts: string[]; // humans' recent messages
  medianLen: number;          // humans' typical message length (0 = unknown)
  marker: { prefix: string; suffix: string };
  /** share of human messages that start lowercase; above 0.7 the bot's texts are lowercased too */
  lowercaseShare?: number;
  /** a genuinely serious moment: stickers, voice notes, polls and images are held back */
  serious?: boolean;
}

/**
 * Phone-style typing, applied in code like LLMafia (arXiv 2506.05309) does: when the group mostly
 * types lowercase, lowercase the first letter and drop a lone final period. Keeps "?" "!" and "...".
 */
export function phoneStyle(text: string): string {
  let t = text;
  const first = t.match(/^\p{Lu}(?!\p{Lu})/u); // a capital not followed by another one (keep "LMAO", "UCL")
  if (first) t = t.charAt(0).toLowerCase() + t.slice(1);
  if (/[^.]\.$/.test(t)) t = t.slice(0, -1);
  return t;
}

export interface LintResult {
  actions: BotAction[];
  issues: { index: number; problem: string }[];
  dropped: string[];
}

export function lintPlan(actions: BotAction[], ctx: LintContext): LintResult {
  const issues: { index: number; problem: string }[] = [];
  const dropped: string[] = [];
  const botSeen = new Set(ctx.recentBotTexts.map(normalize).filter(s => s.length > 3));
  const humanSeen = new Set(ctx.recentHumanTexts.map(normalize).filter(s => s.length > 8));
  const out: BotAction[] = [];

  for (const a of actions) {
    if (ctx.serious && (a.type === 'sticker' || a.type === 'voice' || a.type === 'poll' || a.type === 'image')) {
      dropped.push(`${a.type} held back in a serious moment`);
      continue;
    }
    const raw = textOf(a);
    if (raw === null) { out.push(a); continue; }
    let fixed = autoFix(raw, ctx.marker);
    if (a.type !== 'voice' && (ctx.lowercaseShare ?? 0) > 0.7) fixed = phoneStyle(fixed);
    const norm = normalize(fixed);
    if (!norm && a.type !== 'voice' && !(fixed.match(EMOJI) ?? []).length) { dropped.push('empty text'); continue; }
    if (norm && botSeen.has(norm)) { dropped.push(`repeats something you already said: "${fixed.slice(0, 60)}"`); continue; }
    if (norm && humanSeen.has(norm)) { dropped.push(`parrots a member word for word: "${fixed.slice(0, 60)}"`); continue; }

    const index = out.length;
    out.push(withText(a, fixed));
    for (const tell of AI_TELLS) if (tell.re.test(fixed)) issues.push({ index, problem: tell.label });
    const limit = Math.max(220, ctx.medianLen * 6);
    if (a.type !== 'voice' && fixed.length > limit) {
      issues.push({ index, problem: `too long for this chat (${fixed.length} characters, people here write about ${ctx.medianLen || 'short'})` });
    }
    const emojis = (fixed.match(EMOJI) ?? []).length;
    if (emojis > 5) issues.push({ index, problem: `${emojis} emojis in one message` });
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
  const keptIssues = issues.map(i => ({ ...i, index: remap.get(i.index) ?? -1 })).filter(i => i.index >= 0);

  return { actions: kept, issues: keptIssues, dropped };
}
