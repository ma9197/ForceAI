/**
 * Brain v2: cheap, deterministic signals measured from the chat itself (no AI call). They give the
 * generator hard numbers instead of vibes: how long people's messages really are, which of the bot's
 * own habits are getting repetitive, how much of the chat the bot already is, and older moments that
 * could make a callback joke.
 */

import { DEFAULT_CLOCK_CITIES, cityNow, type ClockCity } from '../../config.js';

/** A message row as stored in the `messages` table (only the fields used here). */
export interface MsgRow {
  id?: string;
  short_id?: string;
  sender_name?: string | null;
  sender_jid?: string | null;
  text?: string | null;
  type?: string;
  is_bot?: number;
  is_owner?: number;
  quoted_id?: string | null;
  ts: number;
}

const EMOJI = /\p{Extended_Pictographic}/gu;
/** Ends with "?", maybe followed by emoji (with skin tones, ZWJ sequences, variation selectors). */
const QUESTION_END = /\?[\s\p{Extended_Pictographic}\u{1F3FB}-\u{1F3FF}\u200d\ufe0f]*$/u;
const AZ_ONLY = /[əƏ]/;
const TR_AZ = /[ğışçöüĞİŞÇÖÜ]/;
const CYRILLIC = /[Ѐ-ӿ]/;

/** Remove the bot's own marker (e.g. "🤖 ") so its habits are measured on what it actually wrote. */
export function stripMarker(text: string, prefix: string, suffix: string): string {
  let t = text;
  if (prefix && t.startsWith(prefix)) t = t.slice(prefix.length);
  if (suffix && t.endsWith(suffix)) t = t.slice(0, t.length - suffix.length);
  return t.trim();
}

function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

function percentile(nums: number[], p: number): number {
  if (nums.length === 0) return 0;
  const s = [...nums].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
}

export interface StyleStats {
  sample: number;
  medianLen: number;
  p80Len: number;
  lowercaseShare: number;
  emojiMsgShare: number;
  avgEmojis: number;
  burstiness: number; // average run of consecutive messages by one sender
  languages: string;
  replyShare: number;  // share of human messages sent as a quote-reply
}

/**
 * The first `n` characters of a text, never splitting an emoji in half. A plain slice can leave half of a
 * surrogate pair at the end, and a prompt with a lone surrogate can be rejected by the API.
 */
export function cut(text: string, n: number): string {
  const s = text.slice(0, n);
  return /[\uD800-\uDBFF]$/.test(s) ? s.slice(0, -1) : s;
}

/** How the HUMANS in this chat text right now, from their recent text messages. */
export function styleStats(rows: MsgRow[]): StyleStats | null {
  const human = rows.filter(r => !r.is_bot && r.type === 'text' && (r.text ?? '').trim().length > 0);
  if (human.length < 8) return null;
  const lens = human.map(r => (r.text ?? '').trim().length);
  const startsLower = human.filter(r => { const c = (r.text ?? '').trim()[0] ?? ''; return c.toLowerCase() === c && c.toUpperCase() !== c; }).length;
  const emojiCounts = human.map(r => ((r.text ?? '').match(EMOJI) ?? []).length);
  const withEmoji = emojiCounts.filter(n => n > 0);

  // runs of consecutive messages by the same person (people who split thoughts into several texts)
  const runs: number[] = [];
  let run = 0;
  let last: string | null | undefined = undefined;
  for (const r of rows.filter(x => !x.is_bot && x.type === 'text')) {
    if (r.sender_jid === last) run += 1;
    else { if (run) runs.push(run); run = 1; last = r.sender_jid; }
  }
  if (run) runs.push(run);

  let az = 0, trAz = 0, ru = 0;
  for (const r of human) {
    const t = r.text ?? '';
    if (CYRILLIC.test(t)) ru += 1;
    else if (AZ_ONLY.test(t)) az += 1;
    else if (TR_AZ.test(t)) trAz += 1;
  }
  const n = human.length;
  const latinPlain = n - az - trAz - ru;
  const parts: string[] = [];
  const share = (k: number) => Math.round((k / n) * 100);
  if (az + trAz > 0) parts.push(`${share(az + trAz)}% Azerbaijani/Turkish letters`);
  if (ru > 0) parts.push(`${share(ru)}% Cyrillic (Russian)`);
  parts.push(`${share(latinPlain)}% plain Latin (English or Azerbaijani typed without special letters)`);

  return {
    sample: n,
    medianLen: median(lens),
    p80Len: percentile(lens, 0.8),
    lowercaseShare: startsLower / n,
    emojiMsgShare: withEmoji.length / n,
    avgEmojis: withEmoji.length ? withEmoji.reduce((a, b) => a + b, 0) / withEmoji.length : 0,
    burstiness: runs.length ? runs.reduce((a, b) => a + b, 0) / runs.length : 1,
    languages: parts.join(', '),
    replyShare: human.filter(r => !!r.quoted_id).length / n,
  };
}

export function formatStyleStats(s: StyleStats): string {
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  return [
    `HOW THIS CHAT TEXTS RIGHT NOW (measured from the last ${s.sample} human messages; fit inside these numbers):`,
    `- length: typical message ${s.medianLen} characters, 80% are under ${s.p80Len}. Yours should be in that range unless you are answering a real question.`,
    `- ${pct(s.lowercaseShare)} start lowercase. emojis appear in ${pct(s.emojiMsgShare)} of messages${s.avgEmojis ? `, about ${s.avgEmojis.toFixed(1)} when used` : ''}.`,
    s.burstiness >= 1.4
      ? `- people often send ${s.burstiness.toFixed(1)} short messages in a row instead of one long one: you can split a thought into two short messages too.`
      : `- people mostly send one message at a time.`,
    `- languages: ${s.languages}.`,
  ].join('\n');
}

const STOP = new Set([
  'the', 'and', 'you', 'your', 'are', 'for', 'that', 'this', 'with', 'what', 'just', 'like', 'have', 'not', 'but', 'was',
  'his', 'her', 'him', 'she', 'they', 'them', 'its', "it's", 'all', 'can', 'get', 'got', 'now', 'out', 'who', 'how',
  'why', 'when', 'from', 'about', 'then', 'than', 'there', 'their', 'here', 'too', 'very', 'really', 'even', 'still',
  'bir', 've', 'bu', 'o', 'da', 'de', 'ki', 'ne', 'nə', 'var', 'yox', 'mən', 'sən', 'biz', 'siz', 'onlar', 'amma',
  'и', 'в', 'не', 'на', 'что', 'это', 'как', 'а', 'но', 'я', 'ты', 'он', 'она', 'мы', 'вы', 'они',
]);

function words(text: string): string[] {
  return text.toLowerCase().replace(EMOJI, ' ').split(/[^\p{L}\p{N}']+/u).filter(w => w.length >= 2);
}

export interface Tics {
  sample: number;
  emojis: { emoji: string; count: number }[];
  openers: { word: string; count: number }[];
  phrases: { phrase: string; count: number }[];
  questionEndings: number;
}

/** The bot's own repetitive habits over its recent messages (what makes a bot feel like a bot). */
export function botTics(botTexts: string[], names: string[] = []): Tics | null {
  const texts = botTexts.map(t => t.trim()).filter(Boolean);
  // a friend's name is not a tic (it is who it talks to); "easy on" covers picking on one person
  const nameWords = new Set(names.flatMap(n => n.toLowerCase().split(/\s+/)).filter(w => w.length >= 2));
  if (texts.length < 6) return null;

  const emojiCount = new Map<string, number>();
  const openerCount = new Map<string, number>();
  const phraseMsgs = new Map<string, number>();
  let questionEndings = 0;
  for (const t of texts) {
    const em = new Set(t.match(EMOJI) ?? []);
    for (const e of em) emojiCount.set(e, (emojiCount.get(e) ?? 0) + 1);
    const w = words(t);
    if (w[0] && !nameWords.has(w[0])) openerCount.set(w[0], (openerCount.get(w[0]) ?? 0) + 1);
    if (QUESTION_END.test(t)) questionEndings += 1;
    const seen = new Set<string>();
    for (let n = 1; n <= 3; n++) {
      for (let i = 0; i + n <= w.length; i++) {
        const gram = w.slice(i, i + n);
        if (n === 1 && (STOP.has(gram[0]) || gram[0].length < 4)) continue;
        if (n > 1 && gram.every(g => STOP.has(g))) continue;
        if (gram.some(g => nameWords.has(g))) continue;
        seen.add(gram.join(' '));
      }
    }
    for (const g of seen) phraseMsgs.set(g, (phraseMsgs.get(g) ?? 0) + 1);
  }
  const n = texts.length;
  const often = (count: number) => count >= Math.max(3, Math.ceil(n * 0.2));
  const top = <T>(m: Map<string, number>, f: (k: string, c: number) => T) =>
    [...m.entries()].filter(([, c]) => often(c)).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, c]) => f(k, c));

  // keep the longest phrases: drop a gram that is part of a longer frequent gram with the same count
  const phrases = top(phraseMsgs, (phrase, count) => ({ phrase, count }));
  const kept = phrases.filter(p => !phrases.some(q => q !== p && q.phrase.includes(p.phrase) && q.count >= p.count));

  return {
    sample: n,
    emojis: top(emojiCount, (emoji, count) => ({ emoji, count })),
    openers: top(openerCount, (word, count) => ({ word, count })),
    phrases: kept,
    questionEndings,
  };
}

/**
 * Phrased as what to do. Emojis are named (a single character plants little); openers and phrases are
 * only counted, never quoted back, so the prompt does not plant them (the linter blocks recycled lines).
 */
export function formatTics(t: Tics): string | null {
  const lines: string[] = [];
  for (const e of t.emojis) lines.push(`- ${e.emoji} is in ${e.count} of your last ${t.sample} messages: pick a different emoji or none this time`);
  if (t.openers.length) lines.push(`- ${t.openers.reduce((a, o) => a + o.count, 0)} of your last ${t.sample} messages open the same few ways: start this one differently`);
  if (t.phrases.length) lines.push(`- you have been reusing ${t.phrases.length} pet phrase${t.phrases.length > 1 ? 's' : ''}: use fresh words`);
  if (t.questionEndings >= Math.max(3, Math.ceil(t.sample * 0.25))) lines.push(`- ${t.questionEndings} of them end on a question: end on a statement`);
  if (lines.length === 0) return null;
  return `VARY YOURSELF (measured on your own recent messages; a real person varies):\n${lines.join('\n')}`;
}

export interface Participation {
  window: number;
  botShare: number;
  humansSinceBot: number;
  secondsSinceBot: number | null;
}

/** How much of the recent chat is the bot, and how long since it last spoke. */
export function participation(rows: MsgRow[], now = Date.now()): Participation {
  const recent = rows.filter(r => r.type !== 'reaction' && !r.is_owner).slice(-30);
  const bot = recent.filter(r => r.is_bot).length;
  let humansSinceBot = 0;
  let lastBotTs: number | null = null;
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if (r.type === 'reaction') continue; // a tap is not talking, its own or anyone's
    if (r.is_bot) { lastBotTs = r.ts; break; }
    if (!r.is_owner) humansSinceBot += 1;
  }
  return {
    window: recent.length,
    botShare: recent.length ? bot / recent.length : 0,
    humansSinceBot,
    secondsSinceBot: lastBotTs ? Math.round((now - lastBotTs) / 1000) : null,
  };
}


/** Content words from the new messages, to look for older moments worth a callback. */
export function callbackKeywords(newRows: MsgRow[], max = 6): string[] {
  const counts = new Map<string, number>();
  for (const r of newRows) {
    if (r.is_bot || r.type !== 'text') continue;
    for (const w of words(r.text ?? '')) {
      if (w.length < 4 || STOP.has(w) || /^\d+$/.test(w)) continue;
      counts.set(w, (counts.get(w) ?? 0) + 1);
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length).slice(0, max).map(([w]) => w);
}

export function formatCallbacks(rows: (MsgRow & { laughs?: number })[]): string | null {
  if (rows.length === 0) return null;
  const lines = rows.map(r => {
    const d = new Date(r.ts);
    const when = `${d.toISOString().slice(0, 10)}`;
    const who = r.is_bot ? 'you' : (r.sender_name ?? '?');
    return `- [${when}] ${who}: ${cut(r.text ?? '', 160)}${r.laughs ? ` (got laughs from ${r.laughs})` : ''}`;
  });
  return `OLDER MOMENTS FROM THIS CHAT (matched on today's topic; a callback to one of these can be the funniest move, but only if it genuinely connects. never force it, and use new words: never repeat one word for word):\n${lines.join('\n')}`;
}

// alternation, not a character class: "⚰️" carries U+FE0F, which in a class would match ❤️ and ✔️ too
const LAUGH_EMOJI = /😂|🤣|💀|😭|⚰/u;
const LAUGH_TEXT = /(ha){2,}|\bxd+\b|\blmf?ao+\b|\blo+l\b|(ах){2,}|(хa){2,}|(ха){2,}|😂|🤣|💀|😭/iu;

/** A short message that is only a laugh ("hahaha", "💀💀", "lmao"), not a line of its own. */
function pureLaugh(text: string): boolean {
  const t = text.trim();
  return t.length > 0 && t.length <= 25 && LAUGH_TEXT.test(t) && words(t.replace(LAUGH_TEXT, ' ')).filter(w => !LAUGH_TEXT.test(w)).length <= 1;
}

/**
 * Laughs per message id, from three signals: laugh reactions on it, laughing replies that quote it,
 * and short unquoted laughs ("hahaha") by someone else right after it (within the next 3 messages and
 * 90 seconds), which is how most people laugh in a group chat. One laugh per person per message.
 * `nearby` false: quoted laughs only (for a list with gaps, where "right after" means nothing).
 */
export function laughCounts(rows: MsgRow[], nearby = true): Map<string, number> {
  const who = new Map<string, Set<string>>();
  const add = (id: string, by: string) => {
    if (!who.has(id)) who.set(id, new Set());
    who.get(id)!.add(by);
  };
  const authorOf = new Map(rows.filter(r => r.id).map(r => [r.id!, r.sender_jid ?? (r.is_bot ? 'bot' : '?')]));
  const chat = rows.filter(r => r.type !== 'reaction');
  for (const r of rows) {
    if (r.is_bot || !r.quoted_id) continue;
    const by = r.sender_jid ?? '?';
    if (authorOf.get(r.quoted_id) === by) continue;
    if (r.type === 'reaction' ? LAUGH_EMOJI.test(r.text ?? '') : r.type === 'text' && LAUGH_TEXT.test(r.text ?? '')) add(r.quoted_id, by);
  }
  // only on a real stretch of chat: on a gappy list "the line before" is not the one they laughed at
  for (let i = 0; nearby && i < chat.length; i++) {
    const r = chat[i];
    if (r.is_bot || r.quoted_id || r.type !== 'text' || !pureLaugh(r.text ?? '')) continue;
    // credit the nearest earlier real line by someone else
    for (let j = i - 1; j >= Math.max(0, i - 3); j--) {
      const t = chat[j];
      if (r.ts - t.ts > 90_000) break;
      if (t.type === 'text' && pureLaugh(t.text ?? '')) continue;
      if (t.id && (t.sender_jid ?? (t.is_bot ? 'bot' : '?')) !== r.sender_jid) add(t.id, r.sender_jid ?? '?');
      break;
    }
  }
  return new Map([...who.entries()].map(([id, s]) => [id, s.size]));
}

/**
 * Callbacks, best first: matched on more of today's words, then the moments that made people laugh back
 * then (laugh reactions or laughing replies quoting it: a callback to a line that landed is the one that
 * lands again), then the most recent. Returns `limit` in chat order, each with how many people laughed.
 */
export function rankCallbacks(cands: (MsgRow & { hits?: number })[], replies: MsgRow[], limit: number): (MsgRow & { laughs: number })[] {
  // quoted laughs only: candidates are spread over weeks, so "a laugh right after" would hit the wrong line
  const laughs = laughCounts([...cands, ...replies], false);
  return cands.map(c => ({ ...c, laughs: c.id ? laughs.get(c.id) ?? 0 : 0 }))
    .sort((a, b) => Math.min(b.hits ?? 1, 2) - Math.min(a.hits ?? 1, 2) || Number(b.laughs > 0) - Number(a.laughs > 0) || (b.hits ?? 1) - (a.hits ?? 1) || b.ts - a.ts)
    .slice(0, limit).sort((a, b) => a.ts - b.ts);
}

/**
 * Which of the bot's recent lines actually got laughs (laugh reactions, laughing replies, or a
 * "hahaha" right after it). Showing the bot what landed in THIS group is cheap in-context feedback.
 */
export function landedLines(rows: MsgRow[], strip: (t: string) => string, max = 3): { text: string; laughs: number }[] {
  const laughs = laughCounts(rows);
  return rows.filter(r => r.is_bot && r.type === 'text' && r.id)
    .map(b => ({ text: strip(b.text ?? ''), laughs: laughs.get(b.id!) ?? 0 }))
    .filter(x => x.laughs > 0 && x.text)
    .sort((a, b) => b.laughs - a.laughs)
    .slice(0, max);
}

/** The group's own lines that made at least two people laugh: the humor that works in this chat. */
export function groupLaughs(rows: MsgRow[], max = 4): { who: string; text: string; laughs: number }[] {
  const laughs = laughCounts(rows);
  return rows.filter(r => !r.is_bot && r.type === 'text' && r.id && !pureLaugh(r.text ?? ''))
    .map(r => ({ who: r.sender_name ?? '?', text: (r.text ?? '').trim(), laughs: laughs.get(r.id!) ?? 0 }))
    .filter(x => x.laughs >= 2 && x.text.length >= 4)
    .sort((a, b) => b.laughs - a.laughs)
    .slice(0, max);
}



/** The owner's thumbs up / down from the dashboard: their taste, shown as examples. */

/**
 * Who the bot keeps aiming at: names in its recent lines plus the senders it replied to. Picking on
 * the same friend again and again stops being banter.
 */
export function botTargets(botRows: MsgRow[], names: string[], senderOf: (id: string) => string | null): { name: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const r of botRows) {
    const hit = new Set<string>();
    const text = (r.text ?? '').toLowerCase();
    for (const name of names) {
      const first = name.trim().split(/\s+/)[0].toLowerCase();
      if (first.length >= 3 && new RegExp(`(?<![\\p{L}])${first.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}])`, 'u').test(text)) hit.add(name);
    }
    const target = r.quoted_id ? senderOf(r.quoted_id) : null;
    if (target && names.includes(target)) hit.add(target);
    for (const h of hit) counts.set(h, (counts.get(h) ?? 0) + 1);
  }
  return [...counts.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
}


/**
 * The owner's calls on past v2 decisions (rated in the dashboard feed), as examples of when to talk.
 * A "bad" on a spoken line means it should have stayed quiet, and the other way round.
 */
/**
 * Split a logged T1v2 line, "reason | why | urge X vs bar Y (room) | thought: ...", reading the fixed
 * tail from the right: the model's own reason may contain " | " itself. Other lines (PAUSE) come back
 * whole as the reason.
 */
export function parseDecisionLine(line: string): { reason: string; why: string; thought: string | null } {
  const urgeAt = line.lastIndexOf(' | urge ');
  if (urgeAt < 0) return { reason: line, why: '', thought: null };
  const head = line.slice(0, urgeAt);
  const whyAt = head.lastIndexOf(' | ');
  const tail = line.slice(urgeAt);
  const thoughtAt = tail.indexOf(' | thought: ');
  return {
    reason: whyAt >= 0 ? head.slice(0, whyAt) : head,
    why: whyAt >= 0 ? head.slice(whyAt + 3) : '',
    thought: thoughtAt >= 0 ? tail.slice(thoughtAt + ' | thought: '.length) : null,
  };
}

export function formatDecisionFeedback(rows: { decision: string; reason: string; verdict: string }[]): string | null {
  if (rows.length === 0) return null;
  const spoke = (d: string) => d === 'RESPOND' || d === 'PAUSE';
  const lines = rows.map(r => {
    const { reason, why, thought } = parseDecisionLine(r.reason);
    // the gatekeeper only knows its own reason and thought, not the code's numbers
    const what = cut([reason, thought ? `thought: ${thought}` : ''].filter(Boolean).join(' / '), 200);
    const addressed = why.startsWith('addressed');
    if (spoke(r.decision) && addressed) return r.verdict === 'good' ? `- your answer was RIGHT here: ${what}` : `- your answer MISSED here (answering was right, the line was not): ${what}`;
    if (spoke(r.decision)) return r.verdict === 'good' ? `- speaking was RIGHT here: ${what}` : `- should have STAYED QUIET here: ${what}`;
    if (r.decision === 'REACT') return r.verdict === 'good' ? `- a reaction was RIGHT here: ${what}` : `- should NOT have reacted here: ${what}`;
    return r.verdict === 'good' ? `- staying quiet was RIGHT here: ${what}` : `- should have SPOKEN here: ${what}`;
  });
  return `YOUR OWNER'S CALLS ON YOUR PAST DECISIONS (learn when to talk from these):\n${lines.join('\n')}`;
}

/**
 * Words that usually mean real bad news, in the group's languages. Conservative on purpose: slang
 * like "I'm dead", "öldüm" (died laughing) or "rip" is not here. A hit only makes the bot more careful
 * (higher bar, no laughing reactions, no stickers), so a false alarm costs little.
 */
const SERIOUS = new RegExp([
  String.raw`\bpassed away\b`, String.raw`\bfuneral\b`, String.raw`\bcondolences?\b`, String.raw`\bin (the )?hospital\b`, String.raw`\bcancer\b`,
  String.raw`\bdiagnos(ed|is)\b`, String.raw`\bpanic attacks?\b`, String.raw`\bdepress(ed|ion)\b`, String.raw`\bcar (crash|accident)\b`,
  String.raw`\bmy (mom|mum|dad|mother|father|grandma|grandpa|grandmother|grandfather|brother|sister|uncle|aunt) (died|passed)\b`,
  String.raw`\b(got|been) (fired|laid off)\b`, String.raw`\bbroke up with\b`, String.raw`\brest in peace\b`,
  // stems: they must start a word ("умер" yes, "сумерки" no)
  String.raw`(?<!\p{L})(?:умер(?:ла|ли|ло)?(?!\p{L})|скончал|похорон|соболезн|больниц|реанимац|диагноз|авари|уволили|депресс|vəfat|rəhmətə get|dəfn|başsağlığı|xəstəxana|xərçəng|qəza|vefat|cenaze|hastane|kanser|başın sağ|kaza geçir)`,
].join('|'), 'iu');

export function seriousHit(text: string): string | null {
  const m = text.match(SERIOUS);
  return m ? m[0] : null;
}

export interface Dynamics {
  /** two people in a quick back-and-forth with each other */
  privatePair: [string, string] | null;
  /** someone sending a run of messages right now (a story before its punchline) */
  storyteller: string | null;
  /** a question to the group that nobody has answered yet */
  hangingQuestion: { shortId: string; who: string } | null;
  /** the newest question is rhetorical ("who even watches that?", "кто вообще так играет?!"): not one to answer */
  rhetorical: { shortId: string; who: string } | null;
  /** a burst of shouting from 2+ people in the last 90 s (a goal, big news): who is shouting */
  hype: string[] | null;
  /** a message that looks like real bad news, who sent it, and the word that flagged it */
  serious: { shortId: string; word: string; who: string } | null;
  /** people saying bye or goodnight: the chat is winding down (the newest goodbye's short id) */
  windingDown: { who: string[]; shortId: string } | null;
}

/**
 * The shape of the conversation right now, measured in code (who talks with whom, who is mid-story,
 * what is left hanging). Models are poor at "when to speak" on their own (Speak or Stay Silent,
 * arXiv 2603.11409; MUCA, arXiv 2401.04883), so these become facts in the prompt and nudges to the bar.
 */
export function dynamics(rows: MsgRow[], botName: string, now = Date.now()): Dynamics {
  const bot = botName.toLowerCase();
  const humans = rows.filter(r => !r.is_bot && r.type !== 'reaction');
  const recentText = humans.filter(r => r.type === 'text' && now - r.ts < 3 * 60_000);
  const mentionsBot = (r: MsgRow) => (r.text ?? '').toLowerCase().includes(bot) || (!!r.quoted_id && rows.some(x => x.id === r.quoted_id && x.is_bot));

  // two people trading messages: last 6 texts from exactly two people, switching at least 3 times
  let privatePair: Dynamics['privatePair'] = null;
  const last6 = recentText.slice(-6);
  const lastRow = rows.filter(r => r.type !== 'reaction').slice(-1)[0];
  if (last6.length >= 5 && !last6.some(mentionsBot) && lastRow && !lastRow.is_bot) {
    const people = [...new Set(last6.map(r => r.sender_jid))];
    let switches = 0;
    for (let i = 1; i < last6.length; i++) if (last6[i].sender_jid !== last6[i - 1].sender_jid) switches += 1;
    if (people.length === 2 && switches >= 3) {
      const name = (jid: string | null | undefined) => last6.find(r => r.sender_jid === jid)?.sender_name ?? '?';
      privatePair = [name(people[0]), name(people[1])];
    }
  }

  // one person on a run: 3+ texts in a row, each within 40 s of the last, the latest under 30 s ago
  let storyteller: string | null = null;
  const tail = humans.slice(-4);
  const lastHuman = tail[tail.length - 1];
  if (lastHuman && lastRow === lastHuman && now - lastHuman.ts < 30_000) {
    let run = 1;
    for (let i = tail.length - 2; i >= 0; i--) {
      if (tail[i].sender_jid !== lastHuman.sender_jid || tail[i + 1].ts - tail[i].ts > 40_000) break;
      run += 1;
    }
    if (run >= 3 && !mentionsBot(lastHuman)) storyteller = lastHuman.sender_name ?? '?';
  }

  // a question to the group: ends in "?", not a reply, not from the owner, nobody else spoke since
  let hangingQuestion: Dynamics['hangingQuestion'] = null;
  let rhetorical: Dynamics['rhetorical'] = null;
  const recent = humans.filter(r => now - r.ts < 10 * 60_000);
  for (let i = recent.length - 1; i >= Math.max(0, recent.length - 3); i--) {
    const q = recent[i];
    if (q.type !== 'text' || q.is_owner || q.quoted_id || mentionsBot(q)) continue;
    if (!QUESTION_END.test(q.text ?? '')) continue;
    if (rhetoricalText(q.text ?? '')) {
      if (q.short_id && now - q.ts < 5 * 60_000) rhetorical = { shortId: q.short_id, who: q.sender_name ?? '?' };
      break;
    }
    // answered by someone else or the bot, or taken back by the asker ("nvm found it", "забей", "boş ver")
    const takenBack = (t: string) => RETRACT.test(t.trim()) || RETRACT.test(t.trim().toLocaleLowerCase('tr'));
    const answered = recent.slice(i + 1).some(r => r.sender_jid !== q.sender_jid || takenBack(r.text ?? '')) || rows.some(r => r.is_bot && r.ts > q.ts);
    if (!answered && q.short_id) hangingQuestion = { shortId: q.short_id, who: q.sender_name ?? '?' };
    break;
  }

  // real bad news in the last 10 minutes
  let serious: Dynamics['serious'] = null;
  for (const r of recent.slice(-8)) {
    const word = r.type === 'text' ? seriousHit(r.text ?? '') : null;
    if (word && r.short_id) serious = { shortId: r.short_id, word, who: r.sender_name ?? '?' };
  }

  // people saying bye / goodnight (last 15 minutes): the newest human text is a goodbye, or two people
  // said one and went quiet (someone who says "gn" and keeps talking has not left), with at most one
  // message after the last goodbye
  let windingDown: Dynamics['windingDown'] = null;
  const texts15 = humans.filter(r => r.type === 'text' && now - r.ts < 15 * 60_000);
  const closers = texts15.slice(-6).filter(r => closingText(r.text ?? ''));
  const gone = closers.filter(c => !texts15.some(r => r.ts > c.ts && r.sender_jid === c.sender_jid));
  const lastBye = closers[closers.length - 1];
  const newestText = texts15[texts15.length - 1];
  const goneWho = [...new Set(gone.map(r => (r.is_owner ? 'Said (owner)' : r.sender_name ?? '?')))];
  const afterLast = lastBye ? texts15.filter(r => r.ts > lastBye.ts).length : 0;
  if (lastBye?.short_id && (lastBye === newestText || (goneWho.length >= 2 && afterLast <= 1))) {
    windingDown = { who: goneWho.length ? goneWho : [lastBye.sender_name ?? '?'], shortId: lastBye.short_id };
  }

  // a hype moment: 3+ loud texts ("GOOOOL", "LETS GOOO!!", caps) from 2+ people in the last 90 seconds,
  // and no bad news (shouting about bad news is not hype)
  let hype: Dynamics['hype'] = null;
  // a laugh in caps ("HAHAHAHA") is laughing and "gn!!" is a goodbye: neither is shouting
  const laughOnly = (t: string) => LAUGH_TEXT.test(t) && t.length <= 60 && words(t.replace(LAUGH_TEXT, ' ')).length <= 1;
  const loud = humans.filter(r => {
    const t = r.text ?? '';
    return r.type === 'text' && now - r.ts < 90_000 && !laughOnly(t) && !closingText(t) && (loudText(t) || GOAL.test(t));
  });
  const shouting = [...new Set(loud.map(r => (r.is_owner ? 'Said (owner)' : r.sender_name ?? '?')))];
  if (!serious && loud.length >= 3 && shouting.length >= 2) hype = shouting;
  if (hype) privatePair = null; // two friends shouting at a goal together are not a private exchange

  return { privatePair, storyteller, hangingQuestion, serious, windingDown, rhetorical, hype };
}

/** A goal shout ("gooool", "goaaal", "gollll", "ГОЛЛЛ", "qooool", "GOAL", "golazo"): stretched, or in capitals. "his goal was offside" is not one. */
const GOAL = /(?<!\p{L})(?:[gGqQ]+(?:[oO]{2,}[aA]*[lL]+|[oO]+[aA]{2,}[lL]+|[oO]+[aA]*[lL]{2,})|[гГ]+(?:[оО]{2,}[лЛ]+|[оО]+[лЛ]{2,})|GOAL|GOL|QOL|ГОЛ|gola[sz]o|GOLA[SZ]O)(?!\p{L})/u;

/** The rest of the message is only punctuation or emojis: "bro what?" counts, "bro what time is it" does not. */
const END = '(?=[\\s?!.…\\p{Extended_Pictographic}\\u{1F3FB}-\\u{1F3FF}\\u200d\\ufe0f]*$)';
/** Asking for a fact (time, place, score, what happened): an honest question, never rhetorical. */
const INFO_ASK = new RegExp('(?<!\\p{L})(?:' + [
  'when', 'where', 'what time', 'which', 'how (?:many|much|long)', 'score', 'scored', 'happened', 'channel', 'link',
  'когда', 'где', 'куда', 'во сколько', 'сколько', 'сч[её]т', 'что случилось', 'забил\\p{L}*', 'канал', 'ссылк\\p{L}*',
  ...['ne zaman', 'nerede', 'nerde', 'nereye', 'kaçta', 'saat kaç', 'hangi', 'ne oldu', 'nə vaxt', 'harda', 'hara', 'neçədə', 'hansı', 'nə oldu', 'kim attı', 'kim vurdu'].map(loose),
].join('|') + ')(?!\\p{L})', 'iu');
/**
 * Questions nobody expects an answer to: venting, disbelief, sarcasm ("who even...", "what is wrong with
 * him", "кто вообще так играет", "ты серьёзно", "ne alaka", "ciddi misin", "bu nədi belə"), or one ending in
 * "!?". Answering one literally is a classic bot move. Questions that ask for a fact (time, place, score,
 * what happened) never count, and short phrases ("bro what", "как так") only when they end the message.
 */
const RHETORICAL = new RegExp('(?<!\\p{L})(?:' + [
  'who even(?! (?:is|are)\\b)', 'who tf', 'who the hell', 'who asked', 'why would (?:anyone|anybody|you|he|she|they)', "what['’]?s wrong with", 'what is wrong with',
  'how is (?:that|this|he|she|it) (?:even )?(?:allowed|legal|possible|real)', 'how (?:is|was) (?:that|this) not an? (?:pen|penalty|foul|red|card|goal|offside)',
  '(?:are|r) (?:you|u) (?:serious|kidding)', '(?:you|u) (?:serious|kidding me)', 'is this a joke', 'is (?:he|the ref|var) blind',
  'why is (?:he|she|this|it) like this', 'how (?:do|did) (?:you|u|he|they) miss', 'what was that' + END, 'bro what' + END, 'what the hell', 'wtf',
  'кто вообще (?:так|такое|это|смотрит)', 'кто так (?:играет|делает|бь[её]т)', 'что за (?:бред|дичь|херня|фигня)', 'зачем вообще', 'нафига', 'ты серь[её]зно', 'ты издеваешься', 'издеваются',
  'что (?:он|они|ты) творит', 'какого (?:хрена|ч[её]рта)', 'как так(?:\\s+можно)?' + END, 'что это было',
  "kto v[ao]+b?(?:sh|shch|sch)e (?:tak|smotrit)", "ty ser['j]?(?:yo|jo|e|io)zno", 'kak tak' + END, 'chto eto bylo',
  ...['ne alaka', 'ciddi misin', 'şaka mı', 'bu ne ya', 'ne biçim', 'olur mu böyle', 'olacak iş mi', 'kör mü bu', 'hakem kör mü', 'ne yapıyor bu', 'napıyor bu'].map(loose),
  ...['nə əlaqəsi', 'ciddisən', 'bu nədi belə', 'bu nə biabırçılıqdı', 'nə danışırsan', 'zarafat edirsən', 'dəli olmusan', 'nə edir bu', 'bu nə oyundu'].map(loose),
  loose('olar belə') + END, loose('bu nə idi') + END, 'kim(?:\\s+\\p{L}+){1,3},?\\s+ki' + END,
].join('|') + ')(?!\\p{L})', 'iu');

export function rhetoricalText(text: string): boolean {
  const t = text.trim();
  const low = t.toLocaleLowerCase('tr');
  if (INFO_ASK.test(t) || INFO_ASK.test(low)) return false;
  // only the end is checked for "!?": a long run of "?" must not be re-scanned from every position
  return RHETORICAL.test(t) || RHETORICAL.test(low) || /(?:\?!|!\?)[\s\p{Extended_Pictographic}\u{1F3FB}-\u{1F3FF}‍️]*$/u.test(t.slice(-40));
}

/**
 * Goodbyes and goodnights in the group's languages. Only short messages that are not questions ("are
 * you going to sleep?" is not a goodbye). Words that mean other things too ("пока" is also "while",
 * "later" is also "later today", "hələlik" is also "for now") count only when they are the whole message, give or take a filler
 * ("ok bye", "ну пока", "bye guys").
 */
const CLOSING_PHRASE = new RegExp('(?<!\\p{L})(?:' + [
  // English
  'gn', 'gnight', 'good ?night', 'night all', 'nighty night', 'gtg', 'g2g', 'gotta go', 'ttyl', 'cya', 'see ya', 'see you (?:tomorrow|later|all)',
  'off to bed', 'going to (?:sleep|bed)', 'heading out', 'peace out', 'bye all', 'bye guys', 'bye everyone',
  // Russian (and Latin spellings)
  'спокойной ночи', 'спокойной', 'споки', 'сладких снов', 'всем пока', 'до завтра', 'я спать', 'пошел спать', 'пошёл спать', 'всем спокойной',
  'spokoynoy nochi', 'spokoinoi nochi', 'spoki', 'vsem poka', 'do zavtra',
  // Azerbaijani
  ...['gecən xeyrə', 'gecəniz xeyrə', 'görüşərik', 'yatıram', 'yatmağa gedirəm', 'sabaha qədər', 'sabaha kimi'].map(loose),
  // Turkish
  ...['iyi geceler', 'görüşürüz', 'hoşça kal', 'hoşçakal', 'yatıyorum', 'yatıcam', 'kaçtım'].map(loose),
].join('|') + ')(?!\\p{L})', 'iu');
const CLOSING_WORD = /^(?:(?:ok(?:ay)?|okey|ну|ладно|hadi|tamam|yaxşı|yaxsi)\s+)?(?:bye+|byee+|bb|пока|poka|night|nite|later|байбай|bye bye|h[əe]l[əe]lik)(?:\s+(?:all|guys|everyone|всем|ребята|hamıya|hamiya|herkese))?$/iu;

export function closingText(text: string): boolean {
  const t = text.trim();
  if (!t || t.length > 60 || /\?\s*$/.test(t)) return false;
  const low = t.toLocaleLowerCase('tr');
  if (CLOSING_PHRASE.test(t) || CLOSING_PHRASE.test(low)) return true;
  const bare = low.replace(EMOJI, ' ').replace(/[^\p{L}\p{N}\s']/gu, ' ').replace(/\s+/g, ' ').trim();
  return CLOSING_WORD.test(bare);
}

export type Reception = 'laughed' | 'answered' | 'ignored' | 'booed';

/**
 * How the bot's recent UNPROMPTED lines were received: laughed at, booed ("cringe", "not funny", 🙄),
 * answered, or ignored (three or more human messages later, nobody laughed, replied or said its name).
 * A run of ignored lines, or pushback on the last one, means it is misjudging this room right now, so the
 * policy raises its bar (HUMA's reflection step, in code).
 * A line counts as unprompted when the human message before it did not mention or reply to the bot.
 */
export function reception(rows: MsgRow[], botName: string, now = Date.now(), last = 4): Reception[] {
  const bot = botName.toLowerCase();
  const laughs = laughCounts(rows);
  const chat = rows.filter(r => r.type !== 'reaction');
  const out: Reception[] = [];
  // first names of the people here: "cringe" that names one of them is about them, not the bot's line
  const people = new Set(rows.filter(r => !r.is_bot && r.sender_name).map(r => r.sender_name!.trim().split(/\s+/)[0].toLowerCase()).filter(n => n.length >= 3));
  const aimedElsewhere = (t: string) => {
    const w = t.toLowerCase().match(/\p{L}+/gu) ?? [];
    return w.length > 5 || w.some(x => people.has(x) || OTHER_PERSON.has(x));
  };
  for (let i = 0; i < chat.length; i++) {
    const b = chat[i];
    if (!b.is_bot || b.type !== 'text' || !b.id) continue;
    if (chat[i - 1]?.is_bot) continue; // the second text of a burst: judged with the first
    const before = chat[i - 1];
    const prompted = before && ((before.text ?? '').toLowerCase().includes(bot) || (!!before.quoted_id && chat.some(x => x.id === before.quoted_id && x.is_bot)));
    if (prompted) continue;
    const after = chat.slice(i + 1).filter(r => !r.is_bot && !r.is_owner);
    if ((laughs.get(b.id) ?? 0) > 0) { out.push('laughed'); continue; }
    // pushback is not engagement: a 🙄 / 👎 on it, or "cringe" / "not funny" / "не смешно" aimed at it: a
    // message that quotes it or names the bot, or a short one right after it (within 5 minutes, quoting
    // nothing else, naming nobody else)
    const atIt = (r: MsgRow, k: number) => r.quoted_id === b.id || (r.text ?? '').toLowerCase().includes(bot)
      || (k === 0 && !r.quoted_id && r.ts - b.ts <= 5 * 60_000 && !aimedElsewhere(r.text ?? ''));
    const booed = rows.some(r => r.type === 'reaction' && r.quoted_id === b.id && !r.is_bot && !r.is_owner && COLD_REACTION.test(r.text ?? ''))
      || after.slice(0, 4).some((r, k) => atIt(r, k) && pushback(r.text ?? ''));
    if (booed) { out.push('booed'); continue; }
    const engaged = after.slice(0, 4).some(r => r.quoted_id === b.id || (r.text ?? '').toLowerCase().includes(bot))
      || rows.some(r => r.type === 'reaction' && r.quoted_id === b.id && !r.is_bot);
    if (engaged) { out.push('answered'); continue; }
    if (after.length >= 3 || (after.length >= 1 && now - b.ts > 5 * 60_000)) out.push('ignored');
  }
  return out.slice(-last);
}

/** Pronouns that point at someone else ("his celebration was cringe"). */
const OTHER_PERSON = new Set(['he', 'his', 'him', 'she', 'her', 'they', 'their', 'them', 'он', 'она', 'они', 'его', 'её', 'ее', 'их', 'onun', 'onlar']);

/** How many of the latest judged lines in a row landed cold (ignored or pushback). */
export function coldStreak(rec: Reception[]): number {
  let n = 0;
  for (let i = rec.length - 1; i >= 0 && (rec[i] === 'ignored' || rec[i] === 'booed'); i--) n += 1;
  return n;
}

/** How many of the latest judged lines in a row were ignored. */
export function ignoredStreak(rec: Reception[]): number {
  let n = 0;
  for (let i = rec.length - 1; i >= 0 && rec[i] === 'ignored'; i--) n += 1;
  return n;
}


/** Everyday words that never make a phrase a "bit" on their own. */
const COMMON = new Set([
  ...STOP, 'is', 'a', 'i', 'it', 'to', 'of', 'in', 'on', 'my', 'me', 'so', 'do', 'be', 'we', 'he', 'at', 'if', 'or', 'no', 'yes',
  'ok', 'okay', 'an', 'am', 'im', "i'm", 'dont', "don't", 'know', 'think', 'going', 'gonna', 'want', 'need', 'will', 'would',
  'should', 'could', 'one', 'did', 'does', 'has', 'had', 'been', 'see', 'say', 'said', 'make', 'good', 'time', 'today',
  'tomorrow', 'yesterday', 'tonight', 'yeah', 'yea', 'ya', 'u', 'ur', 'up', 'go', 'come', 'let', 'lets', "let's", 'some',
  'any', 'more', 'much', 'many', 'well', 'after', 'before', 'also', 'only', 'over', 'into', 'our', 'us',
  'mi', 'sen', 'men', 'bu', 'şu', 've', 'da', 'də', 'ki', 'və', 'ama', 'çok', 'cox', 'çox', 'yaxşı', 'iyi',
  'что', 'как', 'это', 'там', 'тут', 'уже', 'еще', 'ещё', 'так', 'вот', 'ну', 'да', 'нет',
]);

/** Words a phrase never starts or ends with (a bit is "bro is cooked", not "the goat" or "cooked and"). */
const FILLER = new Set(['the', 'a', 'an', 'and', 'or', 'but', 'to', 'of', 'in', 'on', 'at', 'for', 'with', 'from', 'is', 'are', 'was',
  'it', 'its', 'that', 'this', 'then', 'than', 'и', 'в', 'на', 'а', 'но', 'что', 'və', 've', 'da', 'də', 'ki']);

export interface Bit {
  phrase: string;
  people: string[];
  uses: number;
  days: number;
  lastTs: number;
}

/**
 * The group's own running phrases: 2-4 word phrases that at least two different people used, on at
 * least two different days. Exact words matter here: plain word matching keeps the in-group language
 * that summarizing memories wash out (GroupMemBench, arXiv 2605.14498).
 */
export function runningBits(rows: MsgRow[], botName: string, max = 6): Bit[] {
  const bot = botName.toLowerCase();
  const stats = new Map<string, { people: Map<string, string>; days: Set<string>; uses: number; lastTs: number }>();
  for (const r of rows) {
    if (r.is_bot || r.type !== 'text' || !r.text) continue;
    const w = words(r.text);
    const day = new Date(r.ts).toISOString().slice(0, 10);
    const seen = new Set<string>();
    for (let n = 2; n <= 4; n++) {
      for (let i = 0; i + n <= w.length; i++) {
        const gram = w.slice(i, i + n);
        if (!gram.some(g => g.length >= 3 && !COMMON.has(g) && !/^\d+$/.test(g))) continue;
        if (FILLER.has(gram[0]) || FILLER.has(gram[n - 1])) continue;
        const phrase = gram.join(' ');
        if (phrase.includes(bot) || seen.has(phrase)) continue;
        seen.add(phrase);
        const s = stats.get(phrase) ?? { people: new Map(), days: new Set(), uses: 0, lastTs: 0 };
        s.people.set(r.sender_jid ?? '?', r.sender_name ?? '?');
        s.days.add(day);
        s.uses += 1;
        s.lastTs = Math.max(s.lastTs, r.ts);
        stats.set(phrase, s);
      }
    }
  }
  const bits = [...stats.entries()]
    .filter(([, s]) => s.people.size >= 2 && s.days.size >= 2 && s.uses >= 3)
    .map(([phrase, s]) => ({ phrase, people: [...s.people.values()], uses: s.uses, days: s.days.size, lastTs: s.lastTs }));
  // a shorter phrase inside a longer one that is used about as often is the same bit
  const kept = bits.filter(b => !bits.some(o => o !== b && o.phrase.length > b.phrase.length && ` ${o.phrase} `.includes(` ${b.phrase} `) && o.uses >= b.uses * 0.8));
  return kept.sort((a, b) => b.people.length * b.days * Math.log1p(b.uses) - a.people.length * a.days * Math.log1p(a.uses) || b.lastTs - a.lastTs).slice(0, max);
}

export function formatBits(bits: Bit[], now = Date.now()): string | null {
  if (bits.length === 0) return null;
  const ago = (ts: number) => {
    const d = Math.floor((now - ts) / 86_400_000);
    return d <= 0 ? 'today' : d === 1 ? 'yesterday' : `${d} days ago`;
  };
  const lines = bits.map(b => `- "${b.phrase}": ${b.people.slice(0, 4).join(', ')}${b.people.length > 4 ? ' and more' : ''}, ${b.uses} times over ${b.days} days, last ${ago(b.lastTs)}${now - b.lastTs > 5 * 86_400_000 ? ' (cooling off: only bring it back if it really fits)' : ''}`);
  return `THIS GROUP'S OWN PHRASES AND BITS (said by several of them on different days; use their exact words when a callback fits, never force one):\n${lines.join('\n')}`;
}

/** Words that mark a take: a prediction, a verdict, a bet. */
const TAKE = /\b(will|won'?t|gonna|going to|by \d|mark my words|trust me|calling it|i predict|i bet|no way|wins?|loses?|best|worst|overrated|underrated|goat|washed|finished|done for)\b|будет|выиграет|проиграет|лучший|худший|qalib|uduzacaq|udacaq|kazanacak|kaybedecek|ən yaxşı|en iyi/iu;

/**
 * The bot's own takes from the last days (predictions, verdicts), so it stays consistent instead of
 * contradicting itself by accident, and can say "told you" or own a miss (persona drift: arXiv
 * 2511.00222; BeliefShift, arXiv 2603.23848). Lines from the last 30 minutes are skipped: they are
 * in the transcript anyway.
 */
export function ownTakes(botRows: MsgRow[], strip: (t: string) => string, now = Date.now(), max = 4): { text: string; ts: number }[] {
  return botRows
    .filter(r => r.is_bot && r.type === 'text' && now - r.ts > 30 * 60_000 && now - r.ts < 7 * 86_400_000)
    .map(r => ({ text: strip(r.text ?? ''), ts: r.ts }))
    .filter(x => x.text.length >= 8 && TAKE.test(x.text))
    .slice(-max);
}

export function formatTakes(takes: { text: string; ts: number }[], now = Date.now()): string | null {
  if (takes.length === 0) return null;
  const ago = (ts: number) => {
    const h = Math.round((now - ts) / 3_600_000);
    const d = Math.round(h / 24);
    return h < 24 ? `${h}h ago` : d === 1 ? '1 day ago' : `${d} days ago`;
  };
  return `YOUR OWN TAKES FROM THE LAST DAYS (stay consistent: double down, own a miss with style, or say you called it. never contradict one by accident):\n${takes.map(t => `- ${ago(t.ts)}: "${cut(t.text, 140)}"`).join('\n')}`;
}

/** The bot's recent emoji reactions: tapping the same one every time is a bot tell. */
export function formatReactionHabit(rows: MsgRow[]): string | null {
  const mine = rows.filter(r => r.is_bot && r.type === 'reaction' && r.text).map(r => r.text!).slice(-6);
  if (mine.length < 3) return null;
  const counts = new Map<string, number>();
  for (const e of mine) counts.set(e, (counts.get(e) ?? 0) + 1);
  const [top, n] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  if (n < 3) return null;
  return `Your last reactions: ${mine.join(' ')}. If you react, pick one that fits this message, not ${top} again by habit.`;
}

export interface PersonNow {
  name: string;
  /** text messages (reactions are not messages) */
  msgs: number;
  laughing: boolean;
  /** caps or "!!" that is not a laugh: shouting, arguing or hyped */
  loud: boolean;
  serious: boolean;
  /** short id of their question to the group that nobody answered yet */
  openQuestion: string | null;
  talkingTo: string[];
}

/** Caps lock or "!!" / "?!": someone is loud (shouting, arguing, hyped). */
function loudText(t: string): boolean {
  const letters = t.match(/\p{L}/gu) ?? [];
  const upper = letters.filter(c => c !== c.toLowerCase()).length;
  return (letters.length >= 6 && upper / letters.length >= 0.6) || /!!|\?!|!\?/.test(t);
}

/** Sending condolences is not the same as having the loss. */
const CONDOLENCE = /condolen|rest in peace|başsağlığı|başın sağ|соболезн|allah rəhmət|allah rahmet/iu;

/**
 * Who is doing what right now, measured per person over the recent messages (theory of mind in code,
 * like SimToM's perspective taking, arXiv 2311.10227), plus the reply chains that are running. Group
 * chats interleave several conversations; models lose track of who answers whom (conversation
 * disentanglement), so the chains come from the quote links and from a name a message opens with.
 * The owner is labelled like the transcript does and never gets cues that invite a reply.
 */
export interface RoomMapResult { people: PersonNow[]; chains: { ids: string[]; people: string[]; fresh: boolean }[] }

export function roomMap(rows: MsgRow[], names: string[], botName: string, now = Date.now(), windowMs = 15 * 60_000): RoomMapResult {
  const recent = rows.filter(r => now - r.ts <= windowMs && !r.is_bot);
  const label = (r: MsgRow) => (r.is_owner ? 'Said (owner)' : r.sender_name ?? '?');
  const byId = new Map(rows.filter(r => r.id).map(r => [r.id!, r]));
  const bot = botName.toLowerCase();
  const lastBotTs = rows.filter(r => r.is_bot && r.type !== 'reaction').reduce((m, r) => Math.max(m, r.ts), 0);
  // names people go by here: the senders in the chat (their transcript names) plus the known members
  const known = new Map<string, string>();
  for (const n of [...names, ...rows.filter(r => !r.is_bot && !r.is_owner).map(r => r.sender_name ?? '')]) {
    const first = n.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
    if (first.length >= 3) known.set(first, rows.find(r => !r.is_bot && !r.is_owner && (r.sender_name ?? '').toLowerCase().startsWith(first))?.sender_name ?? n);
  }

  // who a message is aimed at: the author of the quoted message, or a name it opens with followed by
  // a comma, colon, "?" or "!" (so "can someone" is not aimed at a friend called Can)
  const target = (r: MsgRow): string | null => {
    const q = r.quoted_id ? byId.get(r.quoted_id) : undefined;
    if (q) return q.is_bot ? botName : label(q);
    const m = (r.text ?? '').trim().match(/^@?([\p{L}\p{N}_]+)\s*[,:?!]/u);
    const first = m?.[1]?.toLowerCase() ?? '';
    if (first === bot) return botName;
    return known.get(first) ?? null;
  };

  const keyOf = (r: MsgRow) => (r.is_owner ? 'owner' : r.sender_jid ?? label(r));
  const people = new Map<string, PersonNow & { key: string; laughs: number; loudN: number; lastTs: number }>();
  for (const r of recent) {
    const key = keyOf(r);
    const p = people.get(key) ?? { key, name: label(r), msgs: 0, laughing: false, loud: false, serious: false, openQuestion: null, talkingTo: [], laughs: 0, loudN: 0, lastTs: 0 };
    const t = r.text ?? '';
    p.lastTs = Math.max(p.lastTs, r.ts);
    if (r.type === 'reaction') { if (LAUGH_EMOJI.test(t)) p.laughs += 1; }
    else if (r.type === 'text') {
      p.msgs += 1;
      if (pureLaugh(t) || (LAUGH_TEXT.test(t) && t.length <= 60 && words(t.replace(LAUGH_TEXT, ' ')).length <= 1)) p.laughs += 1;
      else if (loudText(t)) p.loudN += 1;
      if (seriousHit(t) && !CONDOLENCE.test(t)) p.serious = true;
      const to = target(r);
      // the owner's lines never point anywhere; "talking to ForceAI" only while that is still unanswered
      if (!r.is_owner && to && to !== p.name && (to !== botName || r.ts > lastBotTs) && !p.talkingTo.includes(to)) p.talkingTo.push(to);
    }
    people.set(key, p);
  }
  for (const p of people.values()) {
    if (p.key === 'owner') continue; // never a cue: no open question for the owner
    const mine = recent.filter(r => keyOf(r) === p.key && r.type === 'text');
    const q = mine[mine.length - 1];
    // a question to the group: not a reply to someone, not opening with a friend's name, nobody spoke since
    if (q && QUESTION_END.test(q.text ?? '') && q.short_id && !q.quoted_id && target(q) === null
      && !rows.some(r => r.ts > q.ts && r.type !== 'reaction' && (r.is_bot || keyOf(r) !== p.key))) p.openQuestion = q.short_id;
  }
  for (const p of people.values()) {
    p.laughing = p.laughs > 0 && p.laughs * 2 >= Math.max(1, p.msgs + (p.msgs === 0 ? p.laughs : 0));
    p.loud = p.loudN >= 2 || (p.loudN >= 1 && p.msgs <= 2);
  }

  // reply chains: messages linked by quotes, at least two people
  const parent = new Map<string, string>();
  const find = (id: string): string => { let x = id; while (parent.has(x)) x = parent.get(x)!; return x; };
  const chatIds = new Set(recent.filter(r => r.type === 'text' && r.id).map(r => r.id!));
  for (const r of recent) {
    if (r.type !== 'text' || !r.id || !r.quoted_id || !chatIds.has(r.quoted_id)) continue;
    const a = find(r.id), b = find(r.quoted_id);
    if (a !== b) parent.set(a, b);
  }
  const groups = new Map<string, MsgRow[]>();
  for (const r of recent) {
    if (r.type !== 'text' || !r.id) continue;
    const root = find(r.id);
    groups.set(root, [...(groups.get(root) ?? []), r]);
  }
  const chains = [...groups.values()]
    .filter(g => g.length >= 2 && new Set(g.map(label)).size >= 2)
    .sort((a, b) => b[b.length - 1].ts - a[a.length - 1].ts)
    .slice(0, 3)
    .map(g => ({ ids: g.map(r => r.short_id ?? '?').slice(-5), people: [...new Set(g.map(label))], fresh: now - g[g.length - 1].ts <= 3 * 60_000 }));

  // people who need care or have a question always make the list; then the most recently active
  const all = [...people.values()].filter(p => p.msgs > 0 || p.laughing);
  const list = all.sort((a, b) => Number(b.serious || !!b.openQuestion) - Number(a.serious || !!a.openQuestion) || b.lastTs - a.lastTs).slice(0, 6)
    .map(({ key: _k, laughs: _l, loudN: _n, lastTs: _t, ...p }) => p);
  return { people: list, chains };
}


/**
 * Turkish / Azerbaijani letters typed either way ("canım" / "canim", "çox" / "cox"), so the markers
 * below also match messages typed without the special letters.
 */
function loose(phrase: string): string {
  const map: Record<string, string> = { ç: '[çc]', ğ: '[ğg]', ı: '[ıi]', i: '[iı]', ş: '[şs]', ö: '[öo]', ü: '[üu]', ə: '[əe]' };
  // words joined by an optional comma and any spaces ("hə də, hə də" / "he de he de")
  return phrase.split(' ').map(w => w.split('').map(c => map[c] ?? c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('')).join(',?\\s+');
}

/**
 * Phrases that are sarcastic far more often than not, in this group's languages. Deliberately narrow:
 * everyday words that are usually sincere ("aynen", "çox sağ ol", "thanks a lot", "tabii canım") are NOT
 * here, because a wrong "possible irony" hint on a sincere message is worse than no hint. A hit is still
 * only a hint. LLMs miss mixed-language sarcasm without help (arXiv 2602.21933), so code points at it.
 */
const IRONY_MARKERS = new RegExp('(?<!\\p{L})(?:' + [
  // English
  'yeah right', 'sure buddy', 'sure jan', 'sure pal', 'real smooth', 'nice one,? genius', 'what a surprise', 'shocker',
  'said no one ever', 'cool story', 'great,? just great', 'oh wow,? groundbreaking',
  // Russian (and the same in Latin letters)
  'ага,? конечно', 'ага,? щас', 'конечно-конечно', 'да-да,? конечно', 'ну-ну', 'ну да,? ну да', 'спасибо,? кэп', 'кто бы сомневался',
  'какая неожиданность', 'ну спасибо', 'aga,? konechno', 'nu da,? nu da',
  // Turkish
  ...['yaa tabii', 'ne demezsin', 'çok biliyorsun', 'tabii tabii'].map(loose),
  // Azerbaijani
  ...['hə də hə də', 'çox bilirsən', 'hə hə əlbəttə'].map(loose),
].join('|') + ')(?!\\p{L})', 'iu');
/** "very funny" with no laugh next to it is usually dry; with a laugh it is just funny. */
const DRY_FUNNY = new RegExp('(?<!\\p{L})(?:very funny|очень смешно|' + loose('çok komik') + '|' + loose('çox gülməli') + ')(?!\\p{L})', 'iu');
const SARCASM_EMOJI = /🙄|🙃|😏|🤡/u;
const CLAPS = /\S\s*👏\s*\S+\s*👏/u;

export interface IronyCue { shortId: string; who: string; cue: string }

/**
 * Likely irony in the recent human messages, measured, strongest first: a known sarcastic phrase, a dry
 * "very funny", an eye-roll / upside-down / smirk / clown emoji, claps between words, or a clear switch
 * of alphabet by someone who always writes the other way (switching language often marks a joke or a
 * quote; switching features help humor and sarcasm detection, ACL 2020). Never the owner's lines.
 */
export function ironyCues(rows: MsgRow[], now = Date.now(), max = 3): IronyCue[] {
  const human = rows.filter(r => !r.is_bot && !r.is_owner && r.type === 'text' && r.text);
  const recent = human.filter(r => now - r.ts <= 10 * 60_000).slice(-8);
  const found: (IronyCue & { strength: number; ts: number })[] = [];
  for (const r of recent) {
    const raw = r.text ?? '';
    // "jk" / "шучу" / "zarafat edirəm" right after their own line (or quoting it): that line was the joke.
    // A voice note or photo in between gets it, not the text before; another "jk" is never the joke.
    const jk = JK.exec(raw.trim()) ?? JK.exec(raw.trim().toLocaleLowerCase('tr'));
    if (jk) {
      const own = (x: MsgRow) => x.sender_jid === r.sender_jid && x.ts < r.ts && x.type !== 'reaction' && x.type !== 'sticker' && !JK.test((x.text ?? '').trim());
      const quoted = r.quoted_id ? rows.find(x => x.id === r.quoted_id && own(x)) : undefined;
      const prev = quoted ?? rows.filter(own).pop();
      if (prev?.short_id && prev.type === 'text' && (quoted || r.ts - prev.ts <= 2 * 60_000)) {
        found.push({ shortId: prev.short_id, who: prev.sender_name ?? '?', cue: `their own "${jk[1].replace(/\s+/g, ' ')}" right after it (they say it was a joke)`, strength: 3, ts: prev.ts });
      }
      continue;
    }
    const t = `${raw}\n${raw.toLocaleLowerCase('tr')}`; // Turkish İ / I lowercase properly
    let cue: string | null = null;
    let strength = 0;
    const m = t.match(IRONY_MARKERS);
    if (m) { cue = `"${m[0].trim()}"`; strength = 3; }
    else if (DRY_FUNNY.test(t) && !LAUGH_TEXT.test(raw)) { cue = 'a dry "very funny" (no laugh with it)'; strength = 3; }
    else if (SARCASM_EMOJI.test(raw)) { cue = 'an eye-roll, smirk or clown emoji'; strength = 2; }
    else if (CLAPS.test(raw)) { cue = 'claps between words'; strength = 2; }
    else if (/(^|\s)\/s(?=$|\s|[.!?,])/.test(raw)) { cue = '"/s"'; strength = 3; }
    else {
      // a clear switch of alphabet: they wrote the other way in at least 5 of their last 6 texts and in
      // the one right before, and this is a real sentence (3+ words, links removed)
      const clean = raw.replace(/https?:\/\/\S+/g, ' ');
      const nowScript = clean.trim().split(/\s+/).length >= 3 ? scriptOfText(clean) : null;
      const mine = human.filter(x => x.sender_jid === r.sender_jid && x.ts < r.ts).slice(-6)
        .map(x => scriptOfText((x.text ?? '').replace(/https?:\/\/\S+/g, ' '))).filter(Boolean);
      if (nowScript && mine.length >= 5 && mine[mine.length - 1] !== nowScript && mine.filter(x => x !== nowScript).length >= 5) {
        cue = `a switch to ${nowScript === 'cyrillic' ? 'Russian' : 'Latin letters'} (sometimes a joke or a quote)`;
        strength = 1;
      }
    }
    if (cue && r.short_id) found.push({ shortId: r.short_id, who: r.sender_name ?? '?', cue, strength, ts: r.ts });
  }
  // one cue per message (the strongest), strongest first, then shown in chat order
  const best = [...new Map(found.sort((a, b) => a.strength - b.strength).map(c => [c.shortId, c])).values()];
  return best.sort((a, b) => b.strength - a.strength || b.ts - a.ts).slice(0, max)
    .sort((a, b) => a.ts - b.ts).map(({ strength: _s, ts: _t, ...c }) => c);
}

/** "jk" and friends as the whole message, with laughs or a wink around it ("lol jk", "шучу шучу 😂"). Not "no kidding". */
const JK_PAD = '(?:[\\s!.,)]|ha|ah|ха|ах|lol|lmao|xd|😂|🤣|😅|😜|😉|💀|😭)*'; // each token starts differently: one parse, linear
const JK_WORD = '(?:' + ['(?:jk)+', 'j/k', 'just kidding', 'just joking', "i['’]?m (?:just )?(?:kidding|joking)", 'kidding', 'joking',
  'шучу', 'я шучу', 'да шучу', 'шутка', 'я пошутил', 'пошутил', 'прикалываюсь', 'shuchu', 'shutka',
  ...['şaka', 'şaka lan', 'şaka yaptım', 'şaka yapıyorum', 'şaka yapıyom', 'şakaydı', 'zarafat', 'zarafat edirəm', 'zarafat eliyirəm', 'zarafatdı', 'zarafat idi', 'zarafat elədim'].map(loose)].join('|') + ')';
const JK = new RegExp('^' + JK_PAD + '(' + JK_WORD + '(?:[\\s,]+' + JK_WORD + ')?)' + JK_PAD + '$', 'iu');

/**
 * Taking a question back ("oh nvm found it", "ладно, забей", "boş ver", "neyse"), with at most a few words
 * after and a laugh or emoji at the end. "забей гол" is "score a goal", not "never mind".
 */
const RETRACT = new RegExp('^(?:(?:oh|ah|ok|okay|actually|lol|а|ой|ну|да|ладно|всё|все|tamam|hə)[\\s,!.]+){0,2}(?:' + [
  'nvm+', 'never ?mind', 'forget it', 'ignore (?:that|it|me)', 'found it', 'неважно', 'забей(?![\\s,]+(?:гол|мяч|пенальти))', 'проехали', 'нашел', 'нашёл',
  'nevazhno', 'zabe[yi](?![\\s,]+(?:gol|myach|penalti))',
  ...['boş ver', 'boşver', 'unut gitsin', 'fərqi yoxdur', 'unut getsin', 'neyse', 'nəysə', 'buldum', 'tapdım'].map(loose),
].join('|') + ")(?:[\\s!.,)]+[\\p{L}\\p{N}'’]+){0,4}(?:[\\s!.,)]|\\p{Extended_Pictographic}|\\u{FE0F}|\\u{200D}|\\p{EMod})*$", 'iu');

/** Same rule as the linter's scriptOf, kept local so signals stay independent of lint. */
function scriptOfText(text: string): 'cyrillic' | 'latin' | null {
  const letters = text.replace(EMOJI, '').match(/\p{L}/gu) ?? [];
  if (letters.length < 6) return null;
  const cyr = letters.filter(c => /[Ѐ-ӿ]/.test(c)).length / letters.length;
  return cyr >= 0.6 ? 'cyrillic' : cyr <= 0.05 ? 'latin' : null;
}


/**
 * Everything measured about the room right now, in ONE block of facts (no orders: what each fact means
 * is explained once in the cached system prompts). Replaces three overlapping blocks that said the same
 * thing twice and sometimes pulled in opposite directions. The gate also gets the timing facts (mid-story,
 * your share, how your last lines landed); the reply writer only the content facts.
 */
export interface RoomNow {
  dyn: Dynamics;
  map: RoomMapResult;
  cues: IronyCue[];
  rec?: Reception[];
  part?: Participation;
  asked?: boolean;
}

export function formatRoomNow(r: RoomNow, stage: 'gate' | 'writer'): string | null {
  const lines: string[] = [];
  const s = r.dyn.serious;
  const others = r.map.people.filter(p => p.serious && p.name !== s?.who).map(p => p.name);
  if (s) lines.push(`- bad news: #${s.shortId} (${s.who}) may be real ("${s.word}")${others.length ? `; ${others.join(', ')} may be going through something real too` : ''}`);
  else if (others.length) lines.push(`- bad news: ${others.join(', ')} may be going through something real`);
  const q = r.dyn.hangingQuestion;
  // a question at the end of someone's run of messages is often part of the story ("guess what he did?")
  const storyQuestion = !!(q && r.dyn.storyteller && r.dyn.storyteller === q.who);
  if (q && storyQuestion) lines.push(`- ${q.who}: several messages in a row, the last one a question (#${q.shortId}, may be part of the story)`);
  else if (q) lines.push(`- open question: #${q.shortId} (${q.who}) asked the group, nobody answered yet`);
  if (r.dyn.rhetorical) lines.push(`- rhetorical (likely): #${r.dyn.rhetorical.shortId} (${r.dyn.rhetorical.who}) sounds like venting or sarcasm, not a real ask`);
  if (r.dyn.privatePair) lines.push(`- ${r.dyn.privatePair[0]} and ${r.dyn.privatePair[1]} are going back and forth with each other`);
  if (r.dyn.hype) lines.push(`- hype: ${r.dyn.hype.join(', ')} shouting in the last 90 seconds`);
  if (r.dyn.windingDown) lines.push(`- winding down: ${r.dyn.windingDown.who.join(', ')} said bye or goodnight (#${r.dyn.windingDown.shortId})`);
  if (stage === 'gate' && r.dyn.storyteller && !storyQuestion) lines.push(`- ${r.dyn.storyteller} is sending several messages in a row (probably not finished)`);
  for (const c of r.cues) lines.push(`- possible irony: #${c.shortId} ${c.who}, ${c.cue}`);
  const shouting = new Set(r.dyn.hype ?? []); // already said in the hype line
  const moods = r.map.people.map(p => ({ ...p, loud: p.loud && !shouting.has(p.name) })).filter(p => !p.serious && (p.loud || p.laughing || p.talkingTo.length))
    .map(p => [p.name, p.loud ? 'loud' : '', p.laughing ? 'laughing' : '', p.talkingTo.length ? `talking to ${p.talkingTo.join(', ')}` : ''].filter(Boolean).join(' '));
  if (moods.length) lines.push(`- people: ${moods.join('; ')}`);
  const chain = r.map.chains.find(c => c.fresh);
  if (chain) lines.push(`- reply chain: ${chain.ids.map(i => `#${i}`).join(' > ')} (${chain.people.join(', ')})`);
  if (stage === 'gate' && r.rec) {
    const cold = coldStreak(r.rec);
    const mixed = r.rec.slice(-cold).includes('booed');
    if (r.rec[r.rec.length - 1] === 'booed') lines.push(`- your last unprompted line got pushback (called cringe, not funny or an eye-roll)${cold >= 2 ? `; your last ${cold} all landed cold` : ''}`);
    else if (cold >= 2) lines.push(`- your last ${cold} unprompted lines ${mixed ? 'landed cold (no reaction or pushback)' : 'got no reaction'}`);
    else if (r.rec.filter(x => x === 'laughed').length >= 2) lines.push('- your recent unprompted lines got laughs');
  }
  if (r.part) {
    const share = Math.round(r.part.botShare * 100);
    if (stage === 'gate') {
      const ago = r.part.secondsSinceBot !== null && r.part.secondsSinceBot < 120 ? ` (${r.part.secondsSinceBot}s ago)` : '';
      lines.push(`- you: ${share}% of the last ${r.part.window} messages, ${r.part.humansSinceBot} human messages since you last spoke${ago}`);
    } else {
      const note = r.asked ? (share >= 20 ? ' (answer, and keep it short)' : '') : share >= 35 ? ' (a lot lately: say less)' : '';
      lines.push(`- you: ${share}% of the last ${r.part.window} messages${note}`);
    }
  }
  return lines.length ? `ROOM NOW (facts counted in code):\n${lines.join('\n')}` : null;
}

/**
 * Lines that worked here, in one list: the owner's liked lines, the bot's lines that got laughs, and the
 * friends' own lines that made people laugh. Deduped and capped. Lines that carry the bot's current
 * emoji tics or aim at someone it was told to go easy on are left out (unless nothing else is left), so
 * the examples never pull against the other signals.
 */
export function formatLinesThatWorked(
  liked: string[], landed: { text: string; laughs: number }[], group: { who: string; text: string; laughs: number }[],
  avoid: { emojis?: string[]; names?: string[] } = {}, max = 4,
): string | null {
  const firstNames = (avoid.names ?? []).map(n => n.trim().split(/\s+/)[0].toLowerCase()).filter(n => n.length >= 3);
  // the bot's current emoji tics are taken out of the example, not the whole example
  const untic = (t: string) => (avoid.emojis ?? []).reduce((acc, e) => acc.split(e).join(''), t).replace(/\s{2,}/g, ' ').trim();
  const all: { line: string; liked: boolean }[] = [];
  const seen = new Set<string>();
  const add = (raw: string, line: (t: string) => string, liked = false) => {
    const text = untic(raw);
    const key = text.toLowerCase().replace(EMOJI, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    if (!key || seen.has(key) || firstNames.some(n => key.split(' ').includes(n))) return; // never a dig at an easy-on person
    seen.add(key);
    all.push({ line: line(cut(text, 140)), liked });
  };
  for (const t of liked.filter(Boolean)) add(t, x => `- "${x}" (your owner liked it)`, true);
  for (const l of landed) add(l.text, x => `- "${x}" (${l.laughs} laugh${l.laughs > 1 ? 's' : ''})`);
  for (const g of group) add(g.text, x => `- ${g.who}: "${x}" (${g.laughs} laughing)`);
  // at most 2 of the owner's liked lines, then the rest, so one kind never crowds out the others
  const likedPick = all.filter(x => x.liked).slice(0, 2);
  const pick = [...likedPick, ...all.filter(x => !x.liked)].slice(0, max);
  if (pick.length === 0) return null;
  return `LINES THAT WORKED HERE (learn the kind of humor and use new words; never repeat them):\n${pick.map(x => x.line).join('\n')}`;
}

/** The time in each clock city, on one line (the model reads it off; no math, no time zones). */
export function formatClockLine(cities: ClockCity[], now = new Date()): string {
  const list = cities?.length ? cities : DEFAULT_CLOCK_CITIES;
  return `Time now (read off, never calculate; mention it only when the time or date matters): ${list.map(c => `${c.label} ${cityNow(c, now)}`).join('; ')}`;
}

/** Pushing back on a dig ("not funny", "отстань", "yeter artık", "bəsdir"...), or a cold reaction. */
const PUSHBACK = new RegExp('(?<!\\p{L})(?:' + [
  'not funny', 'shut up', 'stop it', 'stfu', 'leave me alone', 'cring(?:e|y|ey|eworthy)', 'unfunny', 'corny', 'nobody asked',
  'went too far', "(?:that['’]?s|this is|it['’]?s) too far", 'not cool',
  'не ?смешно', 'отстань', 'заткнись', 'хватит уже', 'ну хватит', 'завали', 'кринж\\p{L}*', 'испанский стыд',
  'ne ?smeshno', 'krin(?:j|zh)\\p{L}*', 'otstan', 'zatknis',
  // "komik değil mi 😂" is "isn't it funny?": not pushback
  loose('komik değil') + '(?:s[iı]n)?(?!\\s*m[iıuü])',
  ...['yeter artık', 'kes artık', 'soğuk espri'].map(loose),
  loose('gülməli deyil') + '(?:s[əe]n)?',
  ...['bəsdir də', 'bəsdir artıq', 'əl çək', 'soyuq zarafat'].map(loose),
].join('|') + ')(?!\\p{L})', 'iu');
/** Words that mean "enough" / "who asked" only when they are the whole message ("денег не хватит" is not pushback). */
const PUSHBACK_WHOLE = /^(?:(?:ну\s+)?(?:хватит|hvatit|b[əe]sdi(?:r)?|yeter)[\s!.]*|who asked[\s!.?]*)$/iu;
const COLD_REACTION = /😐|😑|🙄|👎|🖕|😒|🥱|🤡/u;

/** Pushback on a line, unless it comes with a laugh ("shut up 😭😭" means it was funny). */
function pushback(text: string): boolean {
  return (PUSHBACK.test(text) || PUSHBACK_WHOLE.test(text.trim())) && !LAUGH_TEXT.test(text);
}

export interface TeaseTake { name: string; teased: number; laughed: number; pushedBack: number }

/**
 * How each friend takes the bot's digs, measured: for every recent bot line aimed at someone (their
 * name, or a quote of their message), did THAT person laugh (laugh reaction, laughing reply, a "hahaha"
 * right after) or push back ("not funny", "отстань", "bəsdir", a 🙄 / 👎 on it)? Friends tease people who
 * enjoy it; a real friend notices who does not. Owner and bot lines are never targets.
 */
export function teaseReception(rows: MsgRow[], names: string[]): TeaseTake[] {
  const byId = new Map(rows.filter(r => r.id).map(r => [r.id!, r]));
  const chat = rows.filter(r => r.type !== 'reaction');
  const reactsOn = new Map<string, MsgRow[]>();
  for (const r of rows) if (r.type === 'reaction' && r.quoted_id) reactsOn.set(r.quoted_id, [...(reactsOn.get(r.quoted_id) ?? []), r]);
  const people = new Map<string, TeaseTake>();
  const firstOf = (n: string) => n.trim().split(/\s+/)[0].toLowerCase();
  // one entry per first name, so "Kanan" and "Kanan Aliyev" count as one person
  const known = new Map<string, { name: string; re: RegExp }>();
  for (const n of names) {
    const f = firstOf(n);
    if (f.length >= 3 && !known.has(f)) known.set(f, { name: n, re: new RegExp(`(?<!\\p{L})${f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?!\\p{L})`, 'u') });
  }
  for (let i = 0; i < chat.length; i++) {
    const b = chat[i];
    if (!b.is_bot || b.type !== 'text' || !b.id) continue;
    const text = (b.text ?? '').toLowerCase();
    const quoted = b.quoted_id ? byId.get(b.quoted_id) : undefined;
    const targets = new Map<string, string>(); // first name -> display name
    if (quoted && !quoted.is_bot && !quoted.is_owner && quoted.sender_name) {
      const f = firstOf(quoted.sender_name);
      targets.set(f, known.get(f)?.name ?? quoted.sender_name);
    }
    for (const [f, k] of known) if (k.re.test(text)) targets.set(f, k.name);
    if (targets.size !== 1) continue; // a dig at one person (a line about everyone tells nothing about anyone)
    const [tFirst, target] = [...targets][0];
    const isTarget = (r: MsgRow) => !r.is_bot && !r.is_owner && firstOf(r.sender_name ?? '') === tFirst;
    // what the target did in the next few messages (or reacted on the line itself)
    const after = chat.slice(i + 1, i + 6).filter(r => r.ts - b.ts <= 5 * 60_000);
    const reacts = (reactsOn.get(b.id) ?? []).filter(isTarget);
    const theirs = after.filter(isTarget);
    const laughed = reacts.some(r => LAUGH_EMOJI.test(r.text ?? ''))
      || theirs.some(r => (r.quoted_id === b.id || theirs[0] === r) && LAUGH_TEXT.test(r.text ?? ''));
    const pushed = reacts.some(r => COLD_REACTION.test(r.text ?? '')) || theirs.some(r => pushback(r.text ?? ''));
    const p = people.get(tFirst) ?? { name: target, teased: 0, laughed: 0, pushedBack: 0 };
    p.teased += 1;
    if (pushed) p.pushedBack += 1;
    else if (laughed) p.laughed += 1;
    people.set(tFirst, p);
  }
  return [...people.values()].sort((a, b) => b.teased - a.teased);
}

/**
 * EASY ON (it keeps going at the same person) and how each person takes its digs, in one block. EASY ON
 * works like a rule (see the craft text); the rest is information.
 */
export function formatTeasing(targets: { name: string; count: number }[], takes: TeaseTake[], min = 4, window = 15): string | null {
  const lines: string[] = [];
  const heavy = targets.filter(t => t.count >= min);
  if (heavy.length) lines.push(`- EASY ON: ${heavy.map(t => `${t.name} (in ${t.count} of your last ${window} messages)`).join(', ')}. Give them a break unless they start it.`);
  for (const t of takes) {
    if (t.teased < 2) continue;
    if (t.pushedBack >= 1) lines.push(`- ${t.name} pushed back on ${t.pushedBack} of your ${t.teased} digs: keep it light with them`);
    else if (t.laughed >= 2) lines.push(`- ${t.name} laughed at ${t.laughed} of your ${t.teased} digs: they enjoy it`);
  }
  return lines.length ? `TEASING (measured):\n${lines.join('\n')}` : null;
}
