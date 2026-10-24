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

export function formatParticipation(p: Participation, asked = false): string {
  const share = Math.round(p.botShare * 100);
  const tone = asked
    ? (share >= 20 ? 'you have talked a lot: answer, and keep it short' : 'answer naturally')
    : share >= 35
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
/**
 * The owner's liked lines, as examples to aim for. Disliked lines are NOT shown (showing them can plant
 * them): the code keeps them out of "what landed" and "own takes", and the linter blocks close copies.
 */
export function formatTaste(liked: string[]): string | null {
  const l = liked.filter(Boolean).map(t => `- "${t.slice(0, 140)}"`);
  if (l.length === 0) return null;
  return `YOUR OWNER'S TASTE (lines of yours they liked: aim for that spirit, in new words, never repeat them):\n${l.join('\n')}`;
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
    const what = [reason, thought ? `thought: ${thought}` : ''].filter(Boolean).join(' / ').slice(0, 200);
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
export function roomMap(rows: MsgRow[], names: string[], botName: string, now = Date.now(), windowMs = 15 * 60_000): { people: PersonNow[]; chains: { ids: string[]; people: string[] }[] } {
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
    .map(g => ({ ids: g.map(r => r.short_id ?? '?').slice(-5), people: [...new Set(g.map(label))] }));

  // people who need care or have a question always make the list; then the most recently active
  const all = [...people.values()].filter(p => p.msgs > 0 || p.laughing);
  const list = all.sort((a, b) => Number(b.serious || !!b.openQuestion) - Number(a.serious || !!a.openQuestion) || b.lastTs - a.lastTs).slice(0, 6)
    .map(({ key: _k, laughs: _l, loudN: _n, lastTs: _t, ...p }) => p);
  return { people: list, chains };
}

export function formatRoomMap(map: { people: PersonNow[]; chains: { ids: string[]; people: string[] }[] }): string | null {
  if (map.people.length === 0) return null;
  const lines = map.people.map(p => {
    const bits = [p.msgs ? `${p.msgs} message${p.msgs > 1 ? 's' : ''}` : 'only reacting'];
    if (p.serious) bits.push('may be going through something real');
    else if (p.loud) bits.push('loud (shouting, arguing or hyped)');
    if (p.laughing) bits.push('laughing');
    if (p.openQuestion) bits.push(`asked the group #${p.openQuestion}, no answer yet`);
    if (p.talkingTo.length) bits.push(`talking to ${p.talkingTo.join(', ')}`);
    return `- ${p.name}: ${bits.join(', ')}`;
  });
  const chains = map.chains.map(c => `- ${c.ids.map(i => `#${i}`).join(' > ')} (${c.people.join(', ')})`);
  return [`WHO IS DOING WHAT (recent messages, measured):`, ...lines, ...(chains.length ? ['REPLY CHAINS RUNNING:', ...chains] : [])].join('\n');
}

/**
 * Phrases that often carry irony in this group's languages. A hit is a hint to check literal vs meant,
 * never a verdict (many of these are sincere in context). LLMs prompted without help do worse than small
 * tuned models on mixed-language sarcasm (arXiv 2602.21933), so code points at the likely spots.
 */
const IRONY_MARKERS = new RegExp([
  // English
  String.raw`\byeah right\b`, String.raw`\bsure (buddy|jan|pal)\b`, String.raw`\boh (great|wonderful|perfect)\b`, String.raw`\bwow,? thanks\b`,
  String.raw`\bthanks a lot\b`, String.raw`\breal smooth\b`, String.raw`\bnice one,? genius\b`, String.raw`\bwhat a surprise\b`, String.raw`\bshocker\b`,
  String.raw`\bbig brain\b`, String.raw`\bsaid no one ever\b`, String.raw`\bcool story\b`, String.raw`(^|\s)/s\b`,
  // Russian
  String.raw`(?<!\p{L})ну да(?!\p{L})`, String.raw`(?<!\p{L})ага,? конечно`, String.raw`(?<!\p{L})конечно-конечно`, String.raw`(?<!\p{L})ну-ну(?!\p{L})`,
  String.raw`(?<!\p{L})спасибо,? кэп`, String.raw`(?<!\p{L})очень смешно`, String.raw`(?<!\p{L})гениально(?!\p{L})`,
  // Turkish
  String.raw`(?<!\p{L})tabi+ canım`, String.raw`(?<!\p{L})ne güzel(?!\p{L})`, String.raw`(?<!\p{L})çok komik`, String.raw`(?<!\p{L})aferin sana`, String.raw`(?<!\p{L})aynen(?!\p{L})`,
  // Azerbaijani
  String.raw`(?<!\p{L})hə də(?!\p{L})`, String.raw`(?<!\p{L})hə,? əlbəttə`, String.raw`(?<!\p{L})afərin sənə`, String.raw`(?<!\p{L})çox sağ ol(?!\p{L})`,
].join('|'), 'iu');
/** Praise next to a laugh or clown emoji ("genius 💀", "great job 🤡") usually means the opposite. */
const MOCK_PRAISE = /\b(genius|brilliant|great job|well done|amazing|legend|smart|gg)\b|(?<!\p{L})(гений|молодец|красавчик|dahi|helal|afərin|əla)(?!\p{L})/iu;
const MOCK_EMOJI = /💀|😂|🤡|🙄|🙃|😏/u;

export interface IronyCue { shortId: string; who: string; cue: string }

/**
 * Likely irony in the recent human messages, measured: a known marker phrase, an eye-roll / upside-down
 * / smirk / clown emoji, praise next to a laugh, or a sudden switch of alphabet by someone who usually
 * writes in the other one (switching language often marks a joke or a quote; switching features help
 * humor and sarcasm detection, ACL 2020).
 */
export function ironyCues(rows: MsgRow[], now = Date.now(), max = 3): IronyCue[] {
  const human = rows.filter(r => !r.is_bot && !r.is_owner && r.type === 'text' && r.text);
  const recent = human.filter(r => now - r.ts <= 10 * 60_000).slice(-8);
  const out: IronyCue[] = [];
  for (const r of recent) {
    const t = r.text ?? '';
    let cue: string | null = null;
    const m = t.match(IRONY_MARKERS);
    if (m) cue = `"${m[0].trim()}"`;
    else if (/🙄|🙃|😏|🤡/u.test(t)) cue = 'an eye-roll, smirk or clown emoji';
    else if (MOCK_PRAISE.test(t) && MOCK_EMOJI.test(t)) cue = 'praise next to a laugh or clown emoji';
    else {
      // a switch of alphabet: they usually write the other way (at least 4 of their last 6 texts)
      const mine = human.filter(x => x.sender_jid === r.sender_jid && x.ts < r.ts).slice(-6).map(x => scriptOfText(x.text ?? '')).filter(Boolean);
      const now_ = scriptOfText(t);
      if (now_ && mine.length >= 4 && mine.filter(s => s !== now_).length >= 4) cue = `a switch to ${now_ === 'cyrillic' ? 'Russian' : 'Latin letters'} (often a joke or a quote)`;
    }
    if (cue && r.short_id) out.push({ shortId: r.short_id, who: r.sender_name ?? '?', cue });
  }
  return out.slice(-max);
}

/** Same rule as the linter's scriptOf, kept local so signals stay independent of lint. */
function scriptOfText(text: string): 'cyrillic' | 'latin' | null {
  const letters = text.replace(EMOJI, '').match(/\p{L}/gu) ?? [];
  if (letters.length < 6) return null;
  const cyr = letters.filter(c => /[Ѐ-ӿ]/.test(c)).length / letters.length;
  return cyr >= 0.6 ? 'cyrillic' : cyr <= 0.05 ? 'latin' : null;
}

export function formatIronyCues(cues: IronyCue[]): string | null {
  if (cues.length === 0) return null;
  return `POSSIBLE IRONY (measured cues; check literal words vs what they mean before you answer, it can still be sincere):\n${cues.map(c => `- #${c.shortId} ${c.who}: ${c.cue}`).join('\n')}`;
}
