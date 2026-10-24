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
    if (QUESTION_END.test(t)) questionEndings += 1;
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
 */
export function laughCounts(rows: MsgRow[]): Map<string, number> {
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
  for (let i = 0; i < chat.length; i++) {
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

export function formatGroupLaughs(lines: { who: string; text: string; laughs: number }[]): string | null {
  if (lines.length === 0) return null;
  return `WHAT MAKES THIS GROUP LAUGH (their own lines that got the most laughs lately: this is the humor that works here. learn the kind, never copy the line):\n${lines.map(l => `- ${l.who}: "${l.text.slice(0, 140)}" (${l.laughs} laughing)`).join('\n')}`;
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

/**
 * The owner's calls on past v2 decisions (rated in the dashboard feed), as examples of when to talk.
 * A "bad" on a spoken line means it should have stayed quiet, and the other way round.
 */
export function formatDecisionFeedback(rows: { decision: string; reason: string; verdict: string }[]): string | null {
  if (rows.length === 0) return null;
  const spoke = (d: string) => d === 'RESPOND' || d === 'PAUSE';
  const lines = rows.map(r => {
    const what = r.reason.slice(0, 200);
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
  /** a message that looks like real bad news, and the word that flagged it */
  serious: { shortId: string; word: string } | null;
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
  const recent = humans.filter(r => now - r.ts < 10 * 60_000);
  for (let i = recent.length - 1; i >= Math.max(0, recent.length - 3); i--) {
    const q = recent[i];
    if (q.type !== 'text' || q.is_owner || q.quoted_id || mentionsBot(q)) continue;
    if (!QUESTION_END.test(q.text ?? '')) continue;
    const answered = recent.slice(i + 1).some(r => r.sender_jid !== q.sender_jid) || rows.some(r => r.is_bot && r.ts > q.ts);
    if (!answered && q.short_id) hangingQuestion = { shortId: q.short_id, who: q.sender_name ?? '?' };
    break;
  }

  // real bad news in the last 10 minutes
  let serious: Dynamics['serious'] = null;
  for (const r of recent.slice(-8)) {
    const word = r.type === 'text' ? seriousHit(r.text ?? '') : null;
    if (word && r.short_id) serious = { shortId: r.short_id, word };
  }

  return { privatePair, storyteller, hangingQuestion, serious };
}

export type Reception = 'laughed' | 'answered' | 'ignored';

/**
 * How the bot's recent UNPROMPTED lines were received: laughed at, answered, or ignored (three or
 * more human messages later, nobody laughed, replied or said its name). A run of ignored lines means
 * it is misjudging this room right now, so the policy raises its bar (HUMA's reflection step, in code).
 * A line counts as unprompted when the human message before it did not mention or reply to the bot.
 */
export function reception(rows: MsgRow[], botName: string, now = Date.now(), last = 4): Reception[] {
  const bot = botName.toLowerCase();
  const laughs = laughCounts(rows);
  const chat = rows.filter(r => r.type !== 'reaction');
  const out: Reception[] = [];
  for (let i = 0; i < chat.length; i++) {
    const b = chat[i];
    if (!b.is_bot || b.type !== 'text' || !b.id) continue;
    if (chat[i - 1]?.is_bot) continue; // the second text of a burst: judged with the first
    const before = chat[i - 1];
    const prompted = before && ((before.text ?? '').toLowerCase().includes(bot) || (!!before.quoted_id && chat.some(x => x.id === before.quoted_id && x.is_bot)));
    if (prompted) continue;
    const after = chat.slice(i + 1).filter(r => !r.is_bot && !r.is_owner);
    if ((laughs.get(b.id) ?? 0) > 0) { out.push('laughed'); continue; }
    const engaged = after.slice(0, 4).some(r => r.quoted_id === b.id || (r.text ?? '').toLowerCase().includes(bot))
      || rows.some(r => r.type === 'reaction' && r.quoted_id === b.id && !r.is_bot);
    if (engaged) { out.push('answered'); continue; }
    if (after.length >= 3 || (after.length >= 1 && now - b.ts > 5 * 60_000)) out.push('ignored');
  }
  return out.slice(-last);
}

/** How many of the latest judged lines in a row were ignored. */
export function ignoredStreak(rec: Reception[]): number {
  let n = 0;
  for (let i = rec.length - 1; i >= 0 && rec[i] === 'ignored'; i--) n += 1;
  return n;
}

export function formatDynamics(d: Dynamics, rec: Reception[]): string | null {
  const lines: string[] = [];
  if (d.serious) lines.push(`- #${d.serious.shortId} may be real bad news ("${d.serious.word}"). Read it carefully: if it is sincere, no jokes and no laughing reactions.`);
  if (d.privatePair) lines.push(`- ${d.privatePair[0]} and ${d.privatePair[1]} are in a back-and-forth with each other. Jumping in needs a really good reason.`);
  if (d.storyteller) lines.push(`- ${d.storyteller} is sending several messages in a row: probably not finished yet.`);
  if (d.hangingQuestion) lines.push(`- #${d.hangingQuestion.shortId} (${d.hangingQuestion.who}) asked the group something nobody has answered yet.`);
  const streak = ignoredStreak(rec);
  if (streak >= 2) lines.push(`- your last ${streak} unprompted lines got no reaction at all: you are misreading this room right now, hold back.`);
  else if (rec.filter(r => r === 'laughed').length >= 2) lines.push('- your recent unprompted lines got laughs: the room is with you.');
  return lines.length ? `ROOM CHECK (measured):\n${lines.join('\n')}` : null;
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
const TAKE = /\b(will|won'?t|gonna|going to|by \d|mark my words|trust me|calling it|i predict|i bet|no way|wins?|loses?|best|worst|overrated|underrated|goat|washed|finished|done for)\b|\b\d+\s*[-:]\s*\d+\b|будет|выиграет|проиграет|лучший|худший|qalib|uduzacaq|udacaq|kazanacak|kaybedecek|ən yaxşı|en iyi/iu;

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
    return h < 24 ? `${h}h ago` : `${Math.round(h / 24)} days ago`;
  };
  return `YOUR OWN TAKES FROM THE LAST DAYS (stay consistent: double down, own a miss with style, or say you called it. never contradict one by accident):\n${takes.map(t => `- ${ago(t.ts)}: "${t.text.slice(0, 140)}"`).join('\n')}`;
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
