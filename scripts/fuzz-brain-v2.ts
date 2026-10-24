import assert from 'node:assert/strict';
import { autoFix, lintPlan, phoneStyle, scriptOf, splitInTwo } from '../src/ai/v2/lint.js';
import { decide, roomShift } from '../src/ai/v2/policy.js';
import {
  botTargets, botTics, callbackKeywords, dynamics, formatBits, formatLinesThatWorked, formatRoomNow, formatTics, groupLaughs, laughCounts, landedLines,
  ironyCues, ownTakes, parseDecisionLine, participation, reception, roomMap, runningBits, seriousHit, styleStats, type MsgRow,
} from '../src/ai/v2/signals.js';

// Brain v2 fuzz: random multilingual, emoji-heavy, very long and malformed messages through every pure
// v2 function. Looks for crashes and slow regexes (a regex that backtracks badly would freeze the bot).
// Pure functions only: no DB, no network. Run: npx tsx scripts/fuzz-brain-v2.ts [rounds] [seed]
const ROUNDS = Number(process.argv[2] ?? 300);
let seed = Number(process.argv[3] ?? 42);
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = <T>(a: readonly T[]): T => a[Math.floor(rnd() * a.length)];

const PIECES = [
  'kanan', 'murad', 'madrid', 'barca', 'bro is cooked', 'hahaha', 'HAHAHAHA', 'lmao', 'xd', '😂', '💀💀💀', '❤️', '🤷‍♂️', '👍🏻', '⚰️',
  'кто играет', 'умер', 'сумерки', 'ахахах', 'çox pis', 'İndi gəlirəm', 'vəfat', 'başın sağolsun', 'not just a game, but a religion',
  'great question', 'as an AI', ';', '—', '–', '3–1', '?', '!!!', '...', '"quoted"', '#hashtag', 'forceai', 'ForceAI', '@123456',
  'passed away', 'in the hospital', 'will win', 'trust me', '2-1', '\n', '\t', '   ', '', '‍', '️', '🇦🇿', 'a'.repeat(50),
  'ha'.repeat(40), '!'.repeat(30), '?'.repeat(30), 'not '.repeat(20), 'is not about x, it is', '(jk)', 'http://x.y/z?q=1',
] as const;
const text = () => Array.from({ length: 1 + Math.floor(rnd() * 8) }, () => pick(PIECES)).join(pick([' ', '', ', ', '. ', '? ']));
const huge = () => Array.from({ length: 400 }, () => pick(PIECES)).join(' '); // ~5k chars

const marker = { prefix: '🤖 ', suffix: '' };
let slowest = { ms: 0, what: '' };
function timed<T>(what: string, f: () => T, limitMs = 200): T {
  const t0 = performance.now();
  const out = f();
  const ms = performance.now() - t0;
  if (ms > slowest.ms) slowest = { ms, what };
  assert.ok(ms < limitMs, `${what} took ${ms.toFixed(1)} ms`);
  return out;
}

const T0 = 1_800_000_000_000;
for (let round = 0; round < ROUNDS; round++) {
  const rows: MsgRow[] = [];
  const n = 5 + Math.floor(rnd() * 60);
  for (let i = 0; i < n; i++) {
    const bot = rnd() < 0.2;
    const type = rnd() < 0.15 ? 'reaction' : rnd() < 0.05 ? pick(['sticker', 'image', 'poll', 'audio']) : 'text';
    const id = `r${round}_${i}`;
    rows.push({
      id, short_id: `m${i}`, sender_jid: bot ? 'bot' : pick(['a', 'b', 'c', 'd']), sender_name: bot ? 'ForceAI' : pick(['Murad', 'Kanan', 'Aysel', 'Said']),
      is_bot: bot ? 1 : 0, is_owner: !bot && rnd() < 0.05 ? 1 : 0, type,
      text: type === 'reaction' ? pick(['😂', '❤️', '💀', '👍🏻', '⚰️', '']) : rnd() < 0.02 ? huge() : rnd() < 0.03 ? null : text(),
      quoted_id: rnd() < 0.3 && i > 0 ? `r${round}_${Math.floor(rnd() * i)}` : rnd() < 0.02 ? 'missing' : null,
      ts: T0 + i * Math.floor(rnd() * 90_000),
    });
  }
  const now = T0 + n * 90_000;
  const strip = (t: string) => t.replace(/^🤖 /, '');
  const botTexts = rows.filter(r => r.is_bot && r.type === 'text').map(r => strip(r.text ?? ''));
  const humanTexts = rows.filter(r => !r.is_bot && r.type === 'text').map(r => r.text ?? '');

  timed('styleStats', () => styleStats(rows));
  const tics = timed('botTics', () => botTics(botTexts, ['Kanan Aliyev', 'Murad']));
  if (tics) timed('formatTics', () => formatTics(tics));
  const part = timed('participation', () => participation(rows, now));
  timed('laughCounts', () => laughCounts(rows));
  timed('landedLines', () => landedLines(rows, strip));
  timed('groupLaughs', () => groupLaughs(rows));
  const dyn = timed('dynamics', () => dynamics(rows, 'ForceAI', now));
  const rec = timed('reception', () => reception(rows, 'ForceAI', now));
  timed('formatRoomNow', () => formatRoomNow({ dyn, rec, part, map: roomMap(rows, ['Kanan Aliyev', 'Murad', 'x'], 'ForceAI', now), cues: ironyCues(rows, now) }, 'gate'));
  timed('formatLinesThatWorked', () => formatLinesThatWorked(botTexts.slice(0, 3), landedLines(rows, strip), groupLaughs(rows), { emojis: ['💀'], names: ['Kanan'] }));
  timed('runningBits', () => formatBits(runningBits(rows, 'ForceAI'), now));

  timed('ownTakes', () => ownTakes(rows, strip, now));
  timed('callbackKeywords', () => callbackKeywords(rows));
  timed('botTargets', () => botTargets(rows.filter(r => r.is_bot), ['Kanan', 'Murad', '(weird) name.*'], () => pick(['Kanan', null])));
  for (const t of [...humanTexts, ...botTexts].slice(0, 20)) {
    timed('seriousHit', () => seriousHit(t));
    timed('autoFix', () => autoFix(t, marker));
    timed('phoneStyle', () => phoneStyle(t));
    timed('scriptOf', () => scriptOf(t));
    timed('splitInTwo', () => splitInTwo(t, 50));
    timed('parseDecisionLine', () => parseDecisionLine(t));
  }
  const actions: any[] = Array.from({ length: 1 + Math.floor(rnd() * 5) }, () => {
    const k = pick(['message', 'reply', 'reaction', 'voice', 'sticker', 'poll', 'nothing']);
    return k === 'reaction' ? { type: k, emoji: pick(['😂', '❤️', '💀']), target_message_id: 'm1' }
      : k === 'sticker' ? { type: k, sticker_id: 1 } : k === 'poll' ? { type: k, question: 'q', options: ['a', 'b'] }
        : k === 'nothing' ? { type: k } : { type: k, text: rnd() < 0.05 ? huge() : text(), target_message_id: 'm2' };
  });
  const lint = timed('lintPlan', () => lintPlan(actions, {
    recentBotTexts: botTexts, recentHumanTexts: humanTexts, medianLen: Math.floor(rnd() * 40), marker, lowercaseShare: rnd(),
    serious: rnd() < 0.2, unprompted: rnd() < 0.5, avoidTexts: botTexts.slice(0, 3), textOf: () => pick([text(), null]),
    lastHumanTexts: humanTexts, replyShare: rnd(), newestShortId: 'm2', burstiness: 1 + rnd(), p80Len: Math.floor(rnd() * 80),
  }));
  assert.ok(lint.actions.filter(a => a.type === 'message' || a.type === 'reply').length <= 2, 'never more than two texts');
  assert.ok(lint.issues.every(i => i.index >= 0 && i.index < lint.actions.length), 'issue indexes point at kept actions');
  for (const a of lint.actions) if ('text' in a && a.type !== 'voice') assert.ok(!/[—–]/.test(a.text), 'no long dashes survive');

  const s = () => Math.floor(rnd() * 11);
  const out: any = {
    scene: { topic: 't', threads: '', vibe: pick(['hype', 'banter', 'chill', 'heated', 'serious', 'dead']), running_bit: null, bit_played_out: false },
    addressed: rnd() < 0.2, thought: rnd() < 0.7 ? { text: text(), why: '' } : null,
    scores: { relevance: s(), novelty: s(), humor: s(), timing: s(), fit: s() },
    decision: pick(['RESPOND', 'WAIT', 'IGNORE', 'REACT']), react: rnd() < 0.5 ? { target_message_id: 'm1', emoji: pick(['😂', '❤️']) } : null,
    reason: text(), address_message_ids: [], wait_ms: null,
  };
  const res = timed('decide', () => decide(out, part, rnd() < 0.3, pick([-1, 0, 1]), { dyn, rec }));
  assert.ok(['RESPOND', 'WAIT', 'IGNORE', 'REACT'].includes(res.decision));
  if (out.addressed && res.decision !== 'WAIT') assert.equal(res.decision, 'RESPOND', 'addressed always answers');
  if (!out.addressed && res.decision === 'RESPOND') assert.ok(res.motivation >= res.threshold, 'unprompted only above the bar');
  if (res.decision === 'REACT' && (out.scene.vibe === 'serious' || dyn.serious)) assert.notEqual(out.react?.emoji, '😂', 'no 😂 in a serious moment');
  timed('roomShift', () => roomShift({ dyn, rec }));
}

// the biggest single inputs the live bot will see: 4000 messages for the bits table, a 50k-char message
const big: MsgRow[] = Array.from({ length: 4000 }, (_, i) => ({ id: `b${i}`, sender_jid: pick(['a', 'b', 'c']), sender_name: 'x', is_bot: 0, type: 'text', text: text(), ts: T0 + i * 60_000 }));
timed('runningBits on 4000 messages', () => runningBits(big, 'ForceAI'), 1500);
const wall = 'ha '.repeat(8000) + 'not just '.repeat(3000) + '?'.repeat(5000);
timed('lint on a 50k-char message', () => lintPlan([{ type: 'message', text: wall } as any], { recentBotTexts: [wall], recentHumanTexts: [wall], medianLen: 10, marker }), 1500);
timed('dynamics on a 50k-char message', () => dynamics([{ short_id: 'm1', sender_jid: 'a', is_bot: 0, type: 'text', text: wall, ts: T0 }], 'ForceAI', T0 + 1000), 1500);

console.log(`brain v2 fuzz: ${ROUNDS} rounds passed (slowest call: ${slowest.what}, ${slowest.ms.toFixed(1)} ms)`);
