import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/memory/db.js';
import { Repo } from '../src/memory/repo.js';
import { PromptBuilder } from '../src/ai/prompts.js';
import { BrainV2 } from '../src/ai/v2/brain.js';
import { lintPlan, phoneStyle, autoFix, overlap, scriptOf, splitInTwo } from '../src/ai/v2/lint.js';
import { CHATTINESS_SHIFT, decide, roomShift, threshold } from '../src/ai/v2/policy.js';
import { actualAfter, pickReplayCuts } from '../src/ai/v2/replay.js';
import {
  botTargets, botTics, callbackKeywords, dynamics, formatDecisionFeedback, formatDynamics, formatGroupLaughs, formatTargets, formatTaste, formatTics,
  formatBits, formatReactionHabit, formatTakes, groupLaughs, ignoredStreak, laughCounts, landedLines, ownTakes, participation, reception, runningBits, seriousHit,
  styleStats, type MsgRow,
} from '../src/ai/v2/signals.js';
import type { GateV2Out } from '../src/ai/v2/schemas.js';

// Brain v2 without any real API: signals, linter and policy are pure; the brain runs on a throwaway
// DB with a fake Anthropic client. Never touches data/forceai.db.
if (process.env.DEMO_MODE === '1') throw new Error('run without DEMO_MODE');

let t = Date.now() - 60 * 60_000;
const row = (who: string, text: string, extra: Partial<MsgRow> = {}): MsgRow =>
  ({ sender_jid: who, sender_name: who, text, type: 'text', is_bot: 0, is_owner: 0, ts: (t += 30_000), ...extra });

// ---- signals ----
const chat: MsgRow[] = [
  row('a', 'bro what was that pass'), row('a', 'actually crazy'), row('b', 'nah he was cooked'),
  row('c', 'кто играет сегодня'), row('b', 'madrid vs barca 🔥'), row('a', 'çox pis oynadılar'),
  row('c', 'lmao'), row('b', 'He scored twice though.'), row('a', 'fair'), row('c', 'who asked 💀💀'),
];
const st = styleStats(chat)!;
assert.ok(st && st.sample === 10);
assert.ok(st.medianLen > 3 && st.medianLen < 25, `median ${st.medianLen}`);
assert.equal(st.lowercaseShare, 0.9);
assert.ok(st.languages.includes('Cyrillic') && st.languages.includes('Azerbaijani'));
assert.equal(styleStats(chat.slice(0, 5)), null, 'too few messages: no numbers');

const tics = botTics(['bro is cooked 💀', 'bro that is crazy 💀', 'we are so back 💀', 'nah bro 💀', 'bro what 💀', 'bro chill', 'who asked?']);
assert.ok(tics && tics.emojis[0].emoji === '💀' && tics.emojis[0].count === 5);
assert.ok(tics.openers.some(o => o.word === 'bro'));
assert.ok(formatTics(tics)!.includes('💀 in 5 of your last 7'));
assert.equal(botTics(['a', 'b']), null);

const part = participation([...chat, row('bot', 'hi', { is_bot: 1 }), row('a', 'yo'), row('b', 'yo')]);
assert.equal(part.humansSinceBot, 2);
assert.ok(part.botShare > 0 && part.botShare < 0.2);
assert.equal(participation(chat).secondsSinceBot, null);

const kw = callbackKeywords([row('a', 'remember the penalty miss against madrid'), row('b', 'madrid again lol')]);
assert.equal(kw[0], 'madrid');

const bot1 = row('bot', '🤖 kanan predicted 3-0 and got 0-3', { is_bot: 1, id: 'b1' });
const bot2 = row('bot', '🤖 fair', { is_bot: 1, id: 'b2' });
const landed = landedLines([
  bot1, bot2,
  row('a', '😂', { type: 'reaction', quoted_id: 'b1' }), row('b', 'HAHAHA', { quoted_id: 'b1' }), row('c', 'ok', { quoted_id: 'b2' }),
], t => t.replace(/^🤖 /, ''));
assert.deepEqual(landed, [{ text: 'kanan predicted 3-0 and got 0-3', laughs: 2 }]);

const botLines = ['kanan you are washed', 'murad what was that', 'Kanan again lol', 'kanan predicted 3-0', 'kanan pls', 'nice weather'].map(t => row('bot', t, { is_bot: 1 }));
botLines.push(row('bot', 'take the L', { is_bot: 1, quoted_id: 'q1' }));
const targets = botTargets(botLines, ['Kanan Aliyev', 'Murad'], id => (id === 'q1' ? 'Kanan Aliyev' : null));
assert.deepEqual(targets, [{ name: 'Kanan Aliyev', count: 5 }, { name: 'Murad', count: 1 }]);
assert.ok(formatTargets(targets)!.startsWith('EASY ON: Kanan Aliyev'));
assert.equal(formatTargets([{ name: 'Murad', count: 2 }]), null);
assert.ok(formatTaste(['good one'], ['cringe one'])!.includes('liked:\n- "good one"'));
assert.equal(formatTaste([], []), null);

// ---- linter ----
const marker = { prefix: '🤖 ', suffix: '' };
assert.equal(autoFix('🤖 he scored \u2014 twice', marker), 'he scored, twice');
assert.equal(autoFix('"quoted line"', marker), 'quoted line');
assert.equal(phoneStyle('He scored twice.'), 'he scored twice');
assert.equal(phoneStyle('LMAO no...'), 'LMAO no...');
const lint = lintPlan([
  { type: 'message', text: 'Great question! Madrid; obviously.' },
  { type: 'reply', text: 'bro is cooked 💀', target_message_id: 'm1' },
  { type: 'message', text: 'who asked 💀💀' },          // parrots a member
  { type: 'reaction', emoji: '😂', target_message_id: 'm2' },
  { type: 'message', text: 'third text' },
  { type: 'message', text: 'fourth text' },
], { recentBotTexts: ['bro is cooked 💀'], recentHumanTexts: chat.map(r => r.text ?? ''), medianLen: 14, marker, lowercaseShare: 0.9, unprompted: true });
assert.deepEqual(lint.actions.map(a => a.type), ['message', 'reaction', 'message']);
assert.equal((lint.actions[0] as any).text, 'great question! Madrid; obviously', 'phone style applied');
assert.ok(lint.issues.some(i => i.index === 0 && i.problem.includes('great question')));
assert.ok(lint.issues.some(i => i.index === 0 && i.problem.includes('semicolon')));
assert.ok(lint.dropped.some(d => d.includes('already said')) && lint.dropped.some(d => d.includes('parrots')) && lint.dropped.some(d => d.includes('third text')));
const serious = lintPlan([{ type: 'sticker', sticker_id: 1 }, { type: 'message', text: 'damn, sorry man. here if you need anything' }],
  { recentBotTexts: [], recentHumanTexts: [], medianLen: 20, marker, serious: true });
assert.deepEqual(serious.actions.map(a => a.type), ['message']);
assert.ok(lintPlan([{ type: 'message', text: 'it is not just football, it is religion' }],
  { recentBotTexts: [], recentHumanTexts: [], medianLen: 20, marker }).issues.length >= 1, 'contrast template caught');
assert.equal(lintPlan([{ type: 'message', text: 'not bad, but he still missed the pen' }],
  { recentBotTexts: [], recentHumanTexts: [], medianLen: 20, marker }).issues.length, 0, 'normal "not ... but" speech is fine');
const long = lintPlan([{ type: 'message', text: 'x'.repeat(300) }], { recentBotTexts: [], recentHumanTexts: [], medianLen: 20, marker });
assert.ok(long.issues[0].problem.startsWith('too long'));

// ---- policy ----
const gate = (o: Partial<GateV2Out> & { s?: Partial<GateV2Out['scores']> } = {}): GateV2Out => ({
  scene: { topic: 'football', threads: 'a and b', vibe: 'banter', running_bit: null, bit_played_out: false },
  addressed: false,
  thought: { text: 'kanan predicted 3-0 last week too', why: 'callback' },
  scores: { relevance: 8, novelty: 8, humor: 8, timing: 8, fit: 8, ...o.s },
  decision: 'IGNORE', react: null, reason: 'r', address_message_ids: [], wait_ms: null, ...o,
});
const quiet = { window: 30, botShare: 0.05, humansSinceBot: 10, secondsSinceBot: 600 };
const chatty = { window: 30, botShare: 0.5, humansSinceBot: 1, secondsSinceBot: 20 };
assert.equal(decide(gate({ addressed: true, s: { humor: 0, relevance: 0, novelty: 0, timing: 0, fit: 0 } }), chatty, false).decision, 'RESPOND', 'addressed always answers');
assert.equal(decide(gate({ addressed: true, decision: 'WAIT' }), quiet, false).decision, 'WAIT');
assert.equal(decide(gate({ decision: 'RESPOND' }), quiet, false).decision, 'RESPOND', 'strong unprompted thought');
assert.equal(decide(gate({ decision: 'RESPOND', s: { humor: 4, novelty: 4, relevance: 5, timing: 5, fit: 5 } }), quiet, false).decision, 'IGNORE', 'weak thought stays quiet');
assert.equal(decide(gate({ decision: 'RESPOND', s: { humor: 4, novelty: 4 }, react: { target_message_id: 'm3', emoji: '😂' } }), quiet, false).decision, 'REACT');
assert.equal(decide(gate({ decision: 'RESPOND' }), chatty, false).decision, 'IGNORE', 'talk-share cap');
assert.equal(decide(gate({ decision: 'IGNORE', s: { relevance: 10, novelty: 10, humor: 10, timing: 9, fit: 10 } }), quiet, false).decision, 'RESPOND', 'too good to keep');
assert.equal(decide(gate({ decision: 'IGNORE', s: { relevance: 7, novelty: 7, humor: 7, timing: 7, fit: 7 } }), quiet, false).decision, 'IGNORE', 'model said ignore, thought only good');
assert.equal(decide(gate({ decision: 'IGNORE' }), quiet, false).decision, 'RESPOND', 'an 8 across the board is too good to keep');
assert.equal(decide(gate({ decision: 'WAIT' }), quiet, true).decision, 'RESPOND', 'forced after waiting, strong');
assert.equal(decide(gate({ thought: null, decision: 'WAIT' }), quiet, true).decision, 'IGNORE');
assert.equal(decide(gate({ decision: 'IGNORE', s: { timing: 3 } }), quiet, false).saveThought, true, 'good idea, bad moment: saved');
assert.ok(threshold({ ...quiet, humansSinceBot: 40 }, 'banter') < threshold(quiet, 'banter'), 'silence lowers the bar');
assert.ok(threshold(quiet, 'serious') > threshold(quiet, 'banter'));
assert.equal(threshold(quiet, 'banter', CHATTINESS_SHIFT.quiet), threshold(quiet, 'banter') + 1, 'quiet raises the bar');
assert.equal(decide(gate({ decision: 'RESPOND', s: { humor: 7, novelty: 6, relevance: 6, timing: 6, fit: 6 } }), quiet, false, CHATTINESS_SHIFT.chatty).decision, 'RESPOND');
assert.equal(decide(gate({ decision: 'RESPOND', s: { humor: 7, novelty: 6, relevance: 6, timing: 6, fit: 6 } }), quiet, false, CHATTINESS_SHIFT.quiet).decision, 'IGNORE');

// ---- round 2: room dynamics, reception, group laughs, bad news, language mirror ----
{
  const T = 1_800_000_000_000;
  let k = 0;
  const r = (who: string, text: string, at: number, extra: Partial<MsgRow> = {}): MsgRow =>
    ({ id: `r${++k}`, short_id: `m${k}`, sender_jid: who, sender_name: who, text, type: 'text', is_bot: 0, is_owner: 0, ts: T + at * 1000, ...extra });

  // laughs: a reaction, a quoting laugh, and an unquoted "hahaha" right after count once per person
  const joke = r('Kanan', 'murad drives like he is taking a penalty', 0);
  const laughs = laughCounts([joke, r('Murad', 'HAHAHAHA', 5), r('Aysel', '💀💀', 8), r('Murad', 'hahaha', 9),
    r('Aysel', '😂', 10, { type: 'reaction', quoted_id: joke.id })]);
  assert.equal(laughs.get(joke.id!), 2, 'two people laughed (Murad twice counts once)');
  assert.equal(laughCounts([joke, r('Kanan', 'hahaha', 4)]).get(joke.id!), undefined, 'laughing at your own joke does not count');
  assert.equal(laughCounts([joke, r('Murad', 'hahaha', 200)]).get(joke.id!), undefined, 'too late to be a laugh at it');
  const gl = groupLaughs([joke, r('Murad', 'HAHAHAHA', 5), r('Aysel', '💀💀', 8), r('Aysel', 'ok', 30)]);
  assert.deepEqual(gl.map(x => x.who), ['Kanan']);
  assert.ok(formatGroupLaughs(gl)!.includes('Kanan: "murad drives like'));
  assert.equal(formatGroupLaughs([]), null);

  // a private back-and-forth between two people
  const now = T + 200_000;
  const pair = [r('Murad', 'you owe me 20', 100), r('Kanan', 'for what', 110), r('Murad', 'the pizza', 120), r('Kanan', 'that was you', 130), r('Murad', 'no it was not', 140), r('Kanan', 'send proof', 150)];
  const d1 = dynamics(pair, 'ForceAI', now);
  assert.deepEqual(d1.privatePair, ['Murad', 'Kanan']);
  assert.equal(dynamics([...pair.slice(0, 5), r('Kanan', 'forceai who is right', 150)], 'ForceAI', now).privatePair, null, 'naming the bot is not private');

  // one person mid-story
  const story = [r('Aysel', 'ok so yesterday', 190), r('Aysel', 'i go to the shop', 195), r('Aysel', 'and guess who is there', 198)];
  assert.equal(dynamics(story, 'ForceAI', now).storyteller, 'Aysel');
  assert.equal(dynamics(story, 'ForceAI', now + 60_000).storyteller, null, 'a run that went quiet is over');

  // a question nobody answered (not the owner's, not to the bot)
  const q = [r('Murad', 'yo', 150), r('Kanan', 'who is playing tonight?', 160)];
  assert.equal(dynamics(q, 'ForceAI', now).hangingQuestion?.shortId, q[1].short_id);
  assert.equal(dynamics([...q, r('Murad', 'barca', 170)], 'ForceAI', now).hangingQuestion, null, 'answered');
  assert.equal(dynamics([r('Said', 'who is playing tonight?', 160, { is_owner: 1 })], 'ForceAI', now).hangingQuestion, null, "owner's questions are never a cue");

  // bad news, in several languages; slang is not
  assert.ok(seriousHit('my dad passed away this morning'));
  assert.ok(seriousHit('бабушка в больнице'));
  assert.ok(seriousHit('nənəm xəstəxanadadır'));
  assert.equal(seriousHit("i'm dead 💀 öldüm rip madrid"), null);
  const sad = dynamics([r('Aysel', 'guys my grandma is in the hospital', 150)], 'ForceAI', now);
  assert.equal(sad.serious?.shortId, `m${k}`);
  assert.ok(formatDynamics(sad, [])!.includes('real bad news'));

  // reception: unprompted lines that got nothing raise the bar; an answer to a question is not judged
  const b = (text: string, at: number) => r('bot', text, at, { is_bot: 1 });
  const ignored = [r('Murad', 'match tonight', 0), b('madrid fans stay quiet tonight', 5), r('Kanan', 'what time', 10), r('Murad', '9', 12), r('Kanan', 'ok', 14),
    r('Murad', 'who is ref', 20), b('the ref is a barca fan, trust', 25), r('Kanan', 'pizza after?', 30), r('Murad', 'yes', 32), r('Aysel', 'me too', 34)];
  const rec = reception(ignored, 'ForceAI', T + 100_000);
  assert.deepEqual(rec, ['ignored', 'ignored']);
  assert.equal(ignoredStreak(rec), 2);
  assert.ok(formatDynamics({ privatePair: null, storyteller: null, hangingQuestion: null, serious: null }, rec)!.includes('no reaction'));
  assert.deepEqual(reception([r('Murad', 'forceai thoughts?', 0), b('madrid is done', 5), r('Kanan', 'ok', 6), r('Murad', 'ok', 7), r('Aysel', 'ok', 8)], 'ForceAI', T + 100_000), [], 'asked: not judged');
  const funny = b('ref is on the barca payroll', 5);
  assert.deepEqual(reception([r('Murad', 'match', 0), funny, r('Kanan', 'HAHAHA', 8)], 'ForceAI', T + 100_000), ['laughed']);

  // policy: the room moves the bar for unprompted lines only
  const calm = { window: 30, botShare: 0.05, humansSinceBot: 10, secondsSinceBot: 600 };
  const ok = gate({ decision: 'RESPOND', s: { relevance: 6.8, novelty: 6.8, humor: 6.8, timing: 6.8, fit: 6.8 } });
  assert.equal(decide(ok, calm, false).decision, 'RESPOND');
  const pairRoom = { dyn: d1, rec: [] };
  assert.equal(decide(ok, calm, false, 0, pairRoom).decision, 'IGNORE', 'two people talking: a 7 is not enough');
  assert.deepEqual(decide(ok, calm, false, 0, pairRoom).room, ['pair talking +0.8']);
  assert.equal(decide(gate({ addressed: true }), calm, false, 0, pairRoom).decision, 'RESPOND', 'still answers when asked');
  assert.equal(decide(ok, calm, false, 0, { rec: ['ignored', 'ignored', 'ignored'] }).decision, 'IGNORE', 'ignored three times: holds back');
  assert.equal(roomShift({ rec: ['ignored', 'ignored', 'ignored', 'ignored'] }).delta, 1, 'capped');
  assert.equal(roomShift({ rec: ['laughed', 'answered', 'laughed'] }).delta, -0.3);
  const borderline = gate({ decision: 'RESPOND', s: { relevance: 5.8, novelty: 5.8, humor: 6, timing: 5.8, fit: 5.8 } });
  assert.equal(decide(borderline, calm, false).decision, 'IGNORE');
  assert.equal(decide(borderline, calm, false, 0, { dyn: dynamics(q, 'ForceAI', now), rec: [] }).decision, 'RESPOND', 'an open question lowers the bar');
  const sadRoom = { dyn: sad, rec: [] };
  assert.equal(decide(gate({ decision: 'REACT', react: { target_message_id: 'm1', emoji: '😂' } }), calm, false, 0, sadRoom).decision, 'IGNORE', 'no 😂 on bad news');
  assert.equal(decide(gate({ decision: 'REACT', react: { target_message_id: 'm1', emoji: '❤️' } }), calm, false, 0, sadRoom).decision, 'REACT', 'a heart is fine');
  assert.ok(decide(ok, calm, false, 0, sadRoom).threshold > decide(ok, calm, false).threshold, 'bad news spotted in code raises the bar');

  // language mirror: answers in the script of the person it replies to
  assert.equal(scriptOf('кто играет сегодня вечером'), 'cyrillic');
  assert.equal(scriptOf('bu gün kim oynayır axşam'), 'latin');
  assert.equal(scriptOf('ok'), null);
  const texts: Record<string, string> = { m1: 'кто сегодня играет вообще', m2: 'who is playing tonight' };
  const base2 = { recentBotTexts: [], recentHumanTexts: [], medianLen: 20, marker, textOf: (id: string) => texts[id] ?? null };
  assert.ok(lintPlan([{ type: 'reply', text: 'barca vs madrid at nine tonight', target_message_id: 'm1' }], base2).issues.some(i => i.problem.includes('Russian')));
  assert.equal(lintPlan([{ type: 'reply', text: 'барса с реалом в девять', target_message_id: 'm1' }], base2).issues.length, 0);
  assert.ok(lintPlan([{ type: 'reply', text: 'барса с реалом в девять вечера', target_message_id: 'm2' }], base2).issues.some(i => i.problem.includes('Latin')));
  assert.equal(lintPlan([{ type: 'message', text: 'barca vs madrid at nine tonight' }], { ...base2, lastHumanTexts: ['кто сегодня играет', 'who is playing', 'кто знает вообще'] }).issues.length, 0, 'mixed room: no flag');
  assert.equal(lintPlan([{ type: 'message', text: 'barca vs madrid at nine tonight' }], { ...base2, lastHumanTexts: ['кто сегодня играет', 'никто не знает', 'кто знает вообще'] }).issues.length, 1);

  // replay: moments at the end of bursts, spread out, the latest included; what the bot really did after
  const day: MsgRow[] = [];
  for (let i = 0; i < 30; i++) {
    day.push(r(i % 3 === 0 ? 'Kanan' : 'Murad', `line ${i}`, 1000 + i * 30));
    if (i % 3 === 0) day.push(r('Kanan', `and ${i}`, 1000 + i * 30 + 5)); // same person, 5 s later: one burst
  }
  day.push(r('bot', 'bot line', 1000 + 29 * 30 + 10, { is_bot: 1 }), r('Said', 'owner line', 1000 + 29 * 30 + 12, { is_owner: 1 }));
  const cuts = pickReplayCuts(day, 6);
  assert.equal(cuts.length, 6);
  assert.ok(cuts.every(c => !c.is_bot && !c.is_owner && !(c.text ?? '').startsWith('line 0')), 'never mid-burst, never the bot or owner');
  assert.equal(cuts[5].text, 'line 29', 'the latest moment is included');
  assert.ok(cuts.every((c, i) => i === 0 || c.ts > cuts[i - 1].ts), 'in order, no duplicates');
  assert.equal(pickReplayCuts(day.slice(0, 2), 6).length, 1);
  assert.equal(actualAfter(day, cuts[5].ts, Infinity), 'said: bot line');
  assert.equal(actualAfter(day, cuts[0].ts, cuts[1].ts), 'stayed quiet');
  assert.equal(actualAfter([r('bot', '😂', 10, { is_bot: 1, type: 'reaction' })], T, Infinity), 'reacted 😂');
}

// ---- round 3: running bits, own takes, natural quoting, burst split ----
{
  const DAY = 86_400_000;
  const T = 1_800_000_000_000;
  const m = (who: string, text: string, day: number, extra: Partial<MsgRow> = {}): MsgRow =>
    ({ sender_jid: who, sender_name: who, text, type: 'text', is_bot: 0, is_owner: 0, ts: T + day * DAY, ...extra });
  const hist = [
    m('Murad', 'bro is cooked fr', 0), m('Kanan', 'kanan is cooked lol', 0), m('Aysel', 'madrid bro is cooked', 1),
    m('Kanan', 'ok bro is cooked', 2),
    m('Murad', 'the goat again', 1), m('Kanan', 'the goat again', 2), m('Aysel', 'messi the goat again', 3),
    m('Murad', 'pizza tonight', 0), m('Murad', 'pizza tonight', 1), m('Murad', 'pizza tonight', 2), // one person only: not a group bit
    m('Kanan', 'forceai is cooked', 1), m('Aysel', 'forceai is cooked', 2), m('Murad', 'forceai is cooked', 3), // about the bot: skipped
    m('bot', 'bro is cooked', 2, { is_bot: 1 }),
  ];
  const bits = runningBits(hist, 'ForceAI');
  const phrases = bits.map(b => b.phrase);
  assert.deepEqual(phrases.sort(), ['bro is cooked', 'goat again'], phrases.join(' / '));
  assert.ok(!phrases.includes('pizza tonight'), 'one person repeating is not a group bit');
  assert.ok(!phrases.some(p => p.includes('forceai')), 'bits about the bot are skipped');
  const cooked = bits.find(b => b.phrase === 'bro is cooked')!;
  assert.deepEqual([cooked.people.length, cooked.days, cooked.uses], [3, 3, 3]);
  assert.ok(formatBits(bits, T + 3 * DAY)!.includes("THIS GROUP'S OWN PHRASES"));
  assert.ok(formatBits([{ phrase: 'old bit', people: ['a', 'b'], uses: 4, days: 2, lastTs: T }], T + 9 * DAY)!.includes('cooling off'));
  assert.equal(formatBits([]), null);

  const strip = (t: string) => t.replace(/^🤖 /, '');
  const now = T + 3 * DAY;
  const takes = ownTakes([
    m('bot', '🤖 madrid wins 2-1 tonight, trust me', 1, { is_bot: 1 }), m('bot', '🤖 lol', 2, { is_bot: 1 }),
    m('bot', '🤖 haaland is overrated', 2, { is_bot: 1 }), m('bot', '🤖 calling it: kanan will be late', 3, { is_bot: 1, ts: now - 5 * 60_000 }),
    m('bot', '🤖 barca will win the league', -10, { is_bot: 1 }),
  ], strip, now);
  assert.deepEqual(takes.map(x => x.text), ['madrid wins 2-1 tonight, trust me', 'haaland is overrated'], 'takes only, not the last 30 min, not older than a week');
  assert.ok(formatTakes(takes, now)!.includes('2 days ago: "madrid wins 2-1'));

  // quote-replies: dropped only when the group rarely quotes and it is the newest message
  const qctx = { recentBotTexts: [], recentHumanTexts: [], medianLen: 20, marker, newestShortId: 'm9' };
  assert.equal(lintPlan([{ type: 'reply', text: 'nah he is done', target_message_id: 'm9' }], { ...qctx, replyShare: 0.05 }).actions[0].type, 'message');
  assert.equal(lintPlan([{ type: 'reply', text: 'nah he is done', target_message_id: 'm9' }], { ...qctx, replyShare: 0.4 }).actions[0].type, 'reply', 'this group quotes a lot');
  assert.equal(lintPlan([{ type: 'reply', text: 'nah he is done', target_message_id: 'm4' }], { ...qctx, replyShare: 0.05 }).actions[0].type, 'reply', 'an older message still needs the quote');
  assert.ok(styleStats([...chat, row('a', 'x', { quoted_id: 'q' })])!.replyShare > 0);

  // bursts: one longer two-sentence text becomes two short ones
  assert.deepEqual(splitInTwo('nah he was offside by a mile. the ref needs glasses honestly', 50), ['nah he was offside by a mile.', 'the ref needs glasses honestly']);
  assert.equal(splitInTwo('one short line', 50), null);
  assert.equal(splitInTwo('one long sentence without any break that goes on and on and on', 50), null);
  assert.equal(splitInTwo('ok. this one is long enough to split but the first half is tiny', 50), null);
  const bctx = { recentBotTexts: [], recentHumanTexts: [], medianLen: 20, marker, burstiness: 1.8, p80Len: 30, lowercaseShare: 0.9 };
  const burst = lintPlan([{ type: 'reply', text: 'Nah he was offside by a mile. The ref needs glasses honestly', target_message_id: 'm4' }], bctx);
  assert.deepEqual(burst.actions, [{ type: 'reply', text: 'nah he was offside by a mile', target_message_id: 'm4' }, { type: 'message', text: 'the ref needs glasses honestly' }]);
  assert.ok(burst.split);
  assert.equal(lintPlan([{ type: 'message', text: 'Nah he was offside by a mile. The ref needs glasses honestly' }], { ...bctx, burstiness: 1.1 }).actions.length, 1, 'one-message group: stays one');
  assert.equal(lintPlan([{ type: 'message', text: 'nah he was offside by a mile. the ref needs glasses honestly' }, { type: 'message', text: 'lol' }], bctx).actions.length, 2, 'already two texts: no split');
}

// ---- round 4: near-repeats, reaction habit ----
{
  const words = (t: string) => new Set(t.split(' '));
  assert.equal(overlap(words('kanan predicted three nil again lol'), words('kanan predicted three nil')), 4 / 6);
  assert.equal(overlap(words('short one'), words('short one')), 0, 'too short to judge');
  const near = lintPlan([{ type: 'message', text: 'kanan predicted madrid wins three nil again' }],
    { recentBotTexts: ['kanan predicted madrid wins three nil'], recentHumanTexts: [], medianLen: 20, marker, unprompted: true });
  assert.equal(near.actions.length, 0);
  assert.ok(near.dropped[0].startsWith('too close to something you already said'));
  // answering someone: a repeat is never dropped (that would leave them unanswered), it is rewritten
  const asked = lintPlan([{ type: 'reply', text: 'still 2-1 madrid, bellingham scored twice', target_message_id: 'm7' }],
    { recentBotTexts: ['2-1 madrid, bellingham scored twice'], recentHumanTexts: [], medianLen: 20, marker });
  assert.equal(asked.actions.length, 1);
  assert.ok(asked.issues[0].problem.includes('say it in new words'));
  assert.equal(lintPlan([{ type: 'message', text: 'kanan is late again, classic kanan behaviour' }],
    { recentBotTexts: ['kanan predicted madrid wins three nil'], recentHumanTexts: [], medianLen: 20, marker }).actions.length, 1, 'same name, different line: fine');

  const re = (e: string, k: number): MsgRow => ({ id: `re${k}`, type: 'reaction', text: e, is_bot: 1, ts: k });
  assert.ok(formatReactionHabit([re('😂', 1), re('😂', 2), re('💀', 3), re('😂', 4)])!.includes('not 😂 again'));
  assert.equal(formatReactionHabit([re('😂', 1), re('🔥', 2), re('💀', 3)]), null, 'varied already');
  assert.equal(formatReactionHabit([re('😂', 1), re('😂', 2)]), null, 'too few');
}

// ---- review fixes: regexes, reactions, wording ----
{
  const T = 1_800_000_000_000;
  const line: MsgRow = { id: 'L1', short_id: 'm1', sender_jid: 'bot', is_bot: 1, type: 'text', text: 'ref is on the payroll', ts: T };
  const heart: MsgRow = { id: 'L2', sender_jid: 'a', is_bot: 0, type: 'reaction', text: '❤️', quoted_id: 'L1', ts: T + 1000 };
  assert.equal(laughCounts([line, heart]).get('L1'), undefined, 'a ❤️ is not a laugh');
  assert.equal(laughCounts([line, { ...heart, text: '⚰️' }]).get('L1'), 1, 'a ⚰️ is');
  const p2 = participation([{ sender_jid: 'a', is_bot: 0, type: 'text', text: 'x', ts: T }, { sender_jid: 'bot', is_bot: 1, type: 'reaction', text: '😂', ts: T + 1000 },
    { sender_jid: 'b', is_bot: 0, type: 'text', text: 'y', ts: T + 2000 }], T + 3000);
  assert.equal(p2.secondsSinceBot, null, "its own reaction is not speaking");
  assert.equal(p2.humansSinceBot, 2);
  assert.ok(formatDecisionFeedback([{ decision: 'REACT', reason: 'r', verdict: 'bad' }])!.includes('should NOT have reacted here'));
  const ask = (text: string) => dynamics([{ short_id: 'm5', sender_jid: 'a', sender_name: 'a', is_bot: 0, is_owner: 0, type: 'text', text, ts: T }], 'ForceAI', T + 1000).hangingQuestion;
  assert.ok(ask('who is coming? 🤷‍♂️') && ask('anyone?👍🏻') && ask('really?❤️'), 'emoji after the "?" still a question');
  assert.equal(ask('score? 2'), null);
  assert.equal(seriousHit('сумерки были классные'), null);
  assert.equal(seriousHit('умеренно смешно'), null);
  assert.ok(seriousHit('дедушка умер'));
  const sad = lintPlan([{ type: 'reaction', emoji: '😂', target_message_id: 'm1' }, { type: 'reaction', emoji: '❤️', target_message_id: 'm1' }],
    { recentBotTexts: [], recentHumanTexts: [], medianLen: 20, marker, serious: true });
  assert.deepEqual(sad.actions.map(a => (a as any).emoji), ['❤️'], 'no laughing reaction on bad news');
  assert.equal(autoFix('Barca won 3\u20131, and \u2014 honestly \u2014 deserved', marker), 'Barca won 3-1, and, honestly, deserved');
  assert.equal(phoneStyle('İndi gəlirəm.'), 'indi gəlirəm');
}

// ---- brain on a throwaway DB with a fake client ----
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forceai-v2-'));
const db = openDb(path.join(dir, 'forceai.db'));
const repo = new Repo(db);
const G = 'g@g.us';
repo.upsertMember('a@s', 'Murad', null, t);
repo.upsertMember('b@s', 'Kanan', null, t);
let n = 0;
const add = (who: string, name: string, text: string, isBot = false) => {
  n += 1;
  repo.insertMessage({ id: `x${n}`, shortId: `m${n}`, chatJid: G, senderJid: who, senderName: name, fromMe: isBot, isBot, isOwner: false,
    type: 'text', text, mentionedJids: [], ts: Date.now() - (61 - n) * 4_000, raw: {} } as any);
};
add('a@s', 'Murad', 'remember when kanan said madrid wins the league');
for (let i = 0; i < 45; i++) add('a@s', 'Murad', `filler ${i}`); // pushes that line out of the visible transcript
for (let i = 0; i < 12; i++) add(i % 2 ? 'a@s' : 'b@s', i % 2 ? 'Murad' : 'Kanan', ['nah', 'bro what', 'madrid is done', 'who asked', 'fair', 'lmao'][i % 6]);
add('x@s', 'ForceAI', '🤖 madrid fans in shambles 💀', true);
add('b@s', 'Kanan', 'madrid will win the league watch');

const calls: any[] = [];
let gateAnswer = () => gate({ decision: 'IGNORE', s: { timing: 3 } });
let genAnswer: any;
let criticAnswer: any = { reason: 'not funny', verdict: 'skip' };
const fakeAi: any = {
  gatekeeperModel: 'claude-haiku-5-5', generationModel: 'claude-sonnet-5-5',
  tuning: (_m: string, mt: number) => ({ max_tokens: mt, effort: 'low' }),
  recordUsage: () => undefined,
  client: { messages: { parse: async (req: any) => {
    calls.push(req);
    const schema = JSON.stringify(req.output_config.format);
    if (schema.includes('"addressed"')) return { usage: {}, stop_reason: 'end_turn', parsed_output: gateAnswer() };
    if (schema.includes('"verdict"')) return { usage: {}, stop_reason: 'end_turn', parsed_output: criticAnswer };
    if (schema.includes('"fixes"')) return { usage: {}, stop_reason: 'end_turn', parsed_output: { fixes: [{ index: 0, text: 'kanan said that last season too' }] } };
    return { usage: {}, stop_reason: 'end_turn', parsed_output: genAnswer };
  } } },
};
const prompts = new PromptBuilder(repo);
const brain = new BrainV2(fakeAi, repo, prompts);

// older days: a phrase two people keep using, and one of the bot's own takes
const old = (id: string, who: string, name: string, text: string, daysAgo: number, isBot = false) => repo.insertMessage({ id, shortId: id, chatJid: G, senderJid: who,
  senderName: name, fromMe: isBot, isBot, isOwner: false, type: 'text', text, mentionedJids: [], ts: Date.now() - daysAgo * 86_400_000, raw: {} } as any);
old('o1', 'a@s', 'Murad', 'kanan tax again', 3); old('o2', 'b@s', 'Kanan', 'no kanan tax today', 2); old('o3', 'a@s', 'Murad', 'pay the kanan tax', 1);
old('o4', 'x@s', 'ForceAI', '🤖 madrid wins 2-1 sunday, trust me', 2, true);
const g = await brain.gate(G, Date.now() - 60_000, false);
assert.ok(g && g.policy.decision === 'IGNORE' && g.policy.saveThought);
assert.ok(brain.hasThought(G), 'good idea at a bad moment is kept for the pause');
assert.equal(brain.lastScene(G)?.topic, 'football');
const gateReq = calls[0];
assert.ok(gateReq.system[1].text.includes('Murad'), 'gatekeeper gets who is in the chat');
assert.ok(gateReq.messages[0].content.includes('YOUR SHARE OF THE CHAT'), 'gatekeeper gets the talk share');
assert.equal(brain.takeThought(G)?.text, 'kanan predicted 3-0 last week too');
assert.equal(brain.takeThought(G), null, 'a thought is offered once');

calls.length = 0;
genAnswer = {
  read: { happening: 'kanan doubling down on madrid', subtext: 'bait, he knows it is a reach', vibe: 'banter', sincere: false },
  angles: [{ idea: 'callback to his old prediction', device: 'callback' }, { idea: 'fake agreement', device: 'fake_agreement' }],
  pick: 0,
  actions: [{ type: 'reply', text: 'Kanan said that last season too \u2014 as an AI I remember everything', target_message_id: 'm60' }, { type: 'reaction', emoji: '💀', target_message_id: 'm60' }],
  note: 'callback', observation: null,
};
assert.equal(repo.setFeedback('x1', 1), false, 'only bot lines can be rated');
assert.equal(repo.setFeedback(`x${n - 1}`, 1), true);
assert.deepEqual(repo.getFeedbackLines(G, 1, 5), ['🤖 madrid fans in shambles 💀']);
assert.deepEqual(repo.getFeedbackLines('other@g.us', 1, 5), [], 'groups never share memory');
assert.deepEqual([...repo.getFeedbackRatings([`x${n - 1}`, 'x1']).entries()], [[`x${n - 1}`, 1]]);
const res = await brain.generate({ chatJid: G, consumedUpToTs: Date.now() - 60_000, addressIds: ['m60'], thought: 'kanan predicted 3-0', thoughtWhen: 'pause' });
assert.ok(res);
assert.equal(calls.length, 2, 'generator + one rewrite (AI tell found)');
const genReq = calls[0];
const userText = typeof genReq.messages[0].content === 'string' ? genReq.messages[0].content : genReq.messages[0].content[0].text;
assert.ok(userText.includes('SCENE RIGHT NOW: football'), 'scene from the gatekeeper reaches the generator');
assert.ok(userText.includes('HOW THIS CHAT TEXTS RIGHT NOW'), 'style numbers');
assert.ok(userText.includes('OLDER MOMENTS'), 'callback candidates found');
assert.ok(!userText.includes('you: 🤖'), 'callbacks show the bot lines without its marker');
assert.ok(userText.includes('A THOUGHT YOU HAD A MOMENT AGO'), 'saved thought offered');
assert.ok(userText.includes('"kanan tax": Murad, Kanan, 3 times over 3 days'), 'running bits reach the generator');
assert.ok(userText.includes('2 days ago: "madrid wins 2-1 sunday, trust me"'), 'own takes reach the generator, marker stripped');
assert.ok(userText.includes("YOUR OWNER'S TASTE") && userText.includes('- "madrid fans in shambles 💀"'), 'owner taste reaches the generator, marker stripped');
assert.ok(genReq.system[0].text.includes('HOW A REAL FRIEND TEXTS'), 'v2 craft block in the system prompt');
assert.ok(!genReq.system[0].text.includes('great question'), 'no banned phrase planted in the prompt');
assert.deepEqual(res.plan.actions.map(a => a.type), ['message', 'reaction'], 'nobody quotes here and m60 is the newest: plain message');
assert.equal((res.plan.actions[0] as any).text, 'kanan said that last season too');
assert.ok(res.plan.note.includes('angle: callback') && res.plan.note.includes('rewrote 1'));

// second opinion: only for unprompted lines; "skip" means silence, "send" keeps the plan
calls.length = 0;
const vetoed = await brain.generate({ chatJid: G, consumedUpToTs: Date.now() - 60_000, unprompted: true });
assert.equal(calls.length, 3, 'generator + rewrite + second opinion');
assert.deepEqual(vetoed!.plan.actions, []);
assert.ok(vetoed!.plan.note.includes('second opinion said skip: not funny'));
criticAnswer = { reason: 'lands', verdict: 'send' };
const sent = await brain.generate({ chatJid: G, consumedUpToTs: Date.now() - 60_000, unprompted: true });
assert.equal(sent!.plan.actions.length, 2);
repo.setConfig('v2_second_opinion', '0');
calls.length = 0;
await brain.generate({ chatJid: G, consumedUpToTs: Date.now() - 60_000, unprompted: true });
assert.equal(calls.length, 2, 'second opinion off: no extra call');
calls.length = 0;
await brain.generate({ chatJid: G, consumedUpToTs: Date.now() - 60_000, addressIds: ['m60'] });
assert.equal(calls.length, 2, 'answers when addressed never get a second opinion');

// owner's calls on v2 decisions reach the v2 gatekeeper as examples of when to talk
const d1 = repo.insertDecision(G, 'T1v2', 'RESPOND', 'r | strong thought | urge 7 vs bar 6.5 | thought: roast kanan again');
const d2 = repo.insertDecision(G, 'T1v2', 'IGNORE', 'r | nothing worth adding | thought: ask about the match');
const d3 = repo.insertDecision(G, 'T2', 'SEND', 'v1 line');
assert.equal(repo.setDecisionFeedback(d1, 'bad'), true);
assert.equal(repo.setDecisionFeedback(d2, 'bad'), true);
assert.equal(repo.setDecisionFeedback(d3, 'good'), false, 'only v2 turn-taking decisions can be rated');
assert.deepEqual([...repo.getDecisionVerdicts([d1, d2, d3]).entries()], [[d1, 'bad'], [d2, 'bad']]);
const fb = formatDecisionFeedback(repo.getDecisionFeedback(G, 8))!;
assert.equal(repo.getDecisionFeedback('other@g.us', 8).length, 0, 'calls stay in their group');
assert.ok(fb.includes('should have STAYED QUIET here: r | strong thought') && fb.includes('should have SPOKEN here: r | nothing worth adding'));
prompts.memoryVersion += 1;
calls.length = 0;
await brain.gate(G, Date.now() - 60_000, false);
assert.ok(calls[0].system[1].text.includes("YOUR OWNER'S CALLS ON YOUR PAST DECISIONS"), 'owner calls reach the gatekeeper');
const sb = repo.brainV2Stats(G, 0);
assert.equal(sb.spoke, 1, 'RESPOND counted');
assert.equal(sb.unprompted, 1, 'not addressed: unprompted');
assert.equal(sb.quiet, 1);
assert.ok(sb.rewrites >= 1 || sb.vetoed >= 0);
assert.equal(repo.setDecisionFeedback(d1, null), true);
assert.equal(repo.getDecisionFeedback(G, 8).length, 1);

// replay: the gate sees the chat as it was at that moment, and changes nothing
const cutRow = repo.getMessageByShortId('m50');
calls.length = 0;
brain.takeThought(G); // clear the one saved by the gate call above
const before = brain.lastScene(G);
const rp = await brain.gate(G, cutRow.ts - 30_000, false, { untilTs: cutRow.ts });
assert.ok(rp);
const replayText: string = calls[0].messages[0].content;
assert.ok(replayText.includes('#m50 ') && !replayText.includes('#m51 ') && !replayText.includes('madrid will win the league watch'), 'nothing after the cut');
assert.ok(!replayText.includes('Your previous read of the scene'), 'no scene from the future');
assert.equal(brain.lastScene(G), before, 'replay leaves the live state alone');
assert.equal(brain.hasThought(G), false, 'replay saves no thought');

// a saved thought belongs to its moment: kept while someone is mid-story, let go on a new read, dropped on bad news
const saveOne = () => { gateAnswer = () => gate({ decision: 'IGNORE', s: { timing: 3 } }); };
saveOne(); await brain.gate(G, Date.now() - 60_000, false);
assert.ok(brain.hasThought(G));
gateAnswer = () => gate({ decision: 'WAIT', thought: null });
await brain.gate(G, Date.now() - 60_000, false);
assert.ok(brain.hasThought(G), 'still mid-story: kept');
gateAnswer = () => gate({ decision: 'IGNORE', thought: null });
await brain.gate(G, Date.now() - 60_000, false);
assert.equal(brain.hasThought(G), false, 'the chat moved on: let go');
saveOne(); await brain.gate(G, Date.now() - 60_000, false);
gateAnswer = () => gate({ decision: 'WAIT', thought: null, scene: { topic: 'grandma', threads: '', vibe: 'serious', running_bit: null, bit_played_out: false } });
await brain.gate(G, Date.now() - 60_000, false);
assert.equal(brain.hasThought(G), false, 'serious moment: dropped even while waiting');
saveOne();

// per-group chattiness beats the global setting; "default" follows it
repo.setConfig('v2_chattiness', 'chatty');
assert.equal(repo.getV2Chattiness(G), 'chatty');
repo.setV2Chattiness(G, 'quiet');
assert.equal(repo.getV2Chattiness(G), 'quiet');
repo.setV2Chattiness(G, 'default');
assert.equal(repo.getV2Chattiness(G), 'chatty');

// v1 is untouched: its frozen block has no v2 text
assert.ok(!prompts.getBlockA().includes('HOW A REAL FRIEND TEXTS'));
assert.ok(prompts.getBlockAV2().startsWith(prompts.getBlockA().split('\n\n')[0]), 'v2 starts from the same persona');

db.close();
fs.rmSync(dir, { recursive: true, force: true });
console.log('brain v2: all checks passed');
