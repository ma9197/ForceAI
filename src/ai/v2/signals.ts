/**
 * Brain v2: cheap, deterministic signals measured from the chat itself (no AI call). They give the
 * generator hard numbers instead of vibes: how long people's messages really are, which of the bot's
 * own habits are getting repetitive, how much of the chat the bot already is, and older moments that
 * could make a callback joke.
 */

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
export function botTics(botTexts: string[]): Tics | null {
  const texts = botTexts.map(t => t.trim()).filter(Boolean);
  if (texts.length < 6) return null;

  const emojiCount = new Map<string, number>();
  const openerCount = new Map<string, number>();
  const phraseMsgs = new Map<string, number>();
  let questionEndings = 0;
  for (const t of texts) {
    const em = new Set(t.match(EMOJI) ?? []);
    for (const e of em) emojiCount.set(e, (emojiCount.get(e) ?? 0) + 1);
    const w = words(t);
    if (w[0]) openerCount.set(w[0], (openerCount.get(w[0]) ?? 0) + 1);
    if (/\?\s*(\p{Extended_Pictographic}|\s)*$/u.test(t)) questionEndings += 1;
    const seen = new Set<string>();
    for (let n = 1; n <= 3; n++) {
      for (let i = 0; i + n <= w.length; i++) {
        const gram = w.slice(i, i + n);
        if (n === 1 && (STOP.has(gram[0]) || gram[0].length < 4)) continue;
        if (n > 1 && gram.every(g => STOP.has(g))) continue;
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

export function formatTics(t: Tics): string | null {
  const lines: string[] = [];
  for (const e of t.emojis) lines.push(`- ${e.emoji} in ${e.count} of your last ${t.sample} messages`);
  for (const o of t.openers) lines.push(`- starting with "${o.word}" (${o.count}x)`);
  for (const p of t.phrases) lines.push(`- "${p.phrase}" (${p.count}x)`);
  if (t.questionEndings >= Math.max(3, Math.ceil(t.sample * 0.25))) lines.push(`- ending on a question (${t.questionEndings}x): stop fishing for replies`);
  if (lines.length === 0) return null;
  return `YOUR OWN RECENT TICS (you have been leaning on these; skip them this time, a real person varies):\n${lines.join('\n')}`;
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
    if (r.is_bot) { lastBotTs = r.ts; break; }
    if (!r.is_owner && r.type !== 'reaction') humansSinceBot += 1;
  }
  return {
    window: recent.length,
    botShare: recent.length ? bot / recent.length : 0,
    humansSinceBot,
    secondsSinceBot: lastBotTs ? Math.round((now - lastBotTs) / 1000) : null,
  };
}

export function formatParticipation(p: Participation): string {
  const share = Math.round(p.botShare * 100);
  const tone = share >= 35
    ? 'that is a LOT: you are dominating, so say less and only if it is really good'
    : share >= 20
      ? 'that is plenty: keep it tight'
      : 'you have room to talk';
  return `YOUR SHARE OF THE CHAT: ${share}% of the last ${p.window} messages are yours (${tone}). ${p.humansSinceBot} human messages since you last spoke.`;
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

export function formatCallbacks(rows: MsgRow[]): string | null {
  if (rows.length === 0) return null;
  const lines = rows.map(r => {
    const d = new Date(r.ts);
    const when = `${d.toISOString().slice(0, 10)}`;
    const who = r.is_bot ? 'you' : (r.sender_name ?? '?');
    return `- [${when}] ${who}: ${(r.text ?? '').slice(0, 160)}`;
  });
  return `OLDER MOMENTS FROM THIS CHAT (matched on today's topic; a callback to one of these can be the funniest move, but only if it genuinely connects. never force it):\n${lines.join('\n')}`;
}

const LAUGH_EMOJI = /[😂🤣💀😭⚰️]/u;
const LAUGH_TEXT = /(ha){2,}|\bxd+\b|\blmf?ao+\b|\blo+l\b|(ах){2,}|(хa){2,}|(ха){2,}|😂|🤣|💀|😭/iu;

/**
 * Which of the bot's recent lines actually got laughs (laugh reactions on it, or laughing replies
 * quoting it). Showing the bot what landed in THIS group is cheap in-context feedback.
 */
export function landedLines(rows: MsgRow[], strip: (t: string) => string, max = 3): { text: string; laughs: number }[] {
  const bot = rows.filter(r => r.is_bot && r.type === 'text' && r.id);
  const laughs = new Map<string, number>();
  for (const r of rows) {
    if (!r.quoted_id || r.is_bot) continue;
    const hit = r.type === 'reaction' ? LAUGH_EMOJI.test(r.text ?? '') : r.type === 'text' && LAUGH_TEXT.test(r.text ?? '');
    if (hit) laughs.set(r.quoted_id, (laughs.get(r.quoted_id) ?? 0) + 1);
  }
  return bot
    .map(b => ({ text: strip(b.text ?? ''), laughs: laughs.get(b.id!) ?? 0 }))
    .filter(x => x.laughs > 0 && x.text)
    .sort((a, b) => b.laughs - a.laughs)
    .slice(0, max);
}

export function formatLanded(lines: { text: string; laughs: number }[]): string | null {
  if (lines.length === 0) return null;
  return `WHAT LANDED WITH THIS GROUP LATELY (your lines that got laughs; learn the kind of humor, never repeat the line):\n${lines.map(l => `- "${l.text.slice(0, 140)}" (${l.laughs} laugh${l.laughs > 1 ? 's' : ''})`).join('\n')}`;
}

/** The owner's thumbs up / down from the dashboard: their taste, shown as examples. */
export function formatTaste(liked: string[], disliked: string[]): string | null {
  const l = liked.filter(Boolean).map(t => `- "${t.slice(0, 140)}"`);
  const d = disliked.filter(Boolean).map(t => `- "${t.slice(0, 140)}"`);
  if (l.length === 0 && d.length === 0) return null;
  return [
    "YOUR OWNER'S TASTE (they rated some of your lines; aim for the spirit of the liked ones, steer away from the style of the disliked ones, never repeat any):",
    l.length ? `liked:\n${l.join('\n')}` : '',
    d.length ? `disliked:\n${d.join('\n')}` : '',
  ].filter(Boolean).join('\n');
}

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

export function formatTargets(targets: { name: string; count: number }[], min = 4, window = 15): string | null {
  const heavy = targets.filter(t => t.count >= min);
  if (heavy.length === 0) return null;
  return `EASY ON: ${heavy.map(t => `${t.name} (in ${t.count} of your last ${window} messages)`).join(', ')}. You keep going at the same person; give them a break unless they start it.`;
}
