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
import { TasteLearner, readTasteRules } from '../src/ai/v2/taste.js';
import {
  botTargets, botTics, callbackKeywords, dynamics, formatDecisionFeedback, formatTeasing, formatTics, teaseReception, formatClockLine, formatLinesThatWorked, formatRoomNow,
  formatBits, formatReactionHabit, formatTakes, groupLaughs, ironyCues, parseDecisionLine, roomMap, ignoredStreak, laughCounts, landedLines, ownTakes, participation, reception, runningBits, seriousHit,
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
assert.ok(formatTics(tics)!.includes('💀 is in 5 of your last 7'));
assert.ok(!formatTics(tics)!.includes('"bro'), 'openers and phrases are counted, never quoted back');
assert.equal(botTics(['kanan you are late', 'kanan pls', 'kanan again', 'kanan bro', 'kanan stop', 'kanan lol'], ['Kanan Aliyev'])?.openers.length, 0, 'a name is not a tic');
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
assert.ok(formatTeasing(targets, [])!.includes('- EASY ON: Kanan Aliyev (in 5 of your last 15 messages)'));
assert.equal(formatTeasing([{ name: 'Murad', count: 2 }], []), null);

// how each friend takes the bot's digs
{
  const T = 1_800_000_000_000;
  let k = 0;
  const r = (who: string, text: string, at: number, extra: Partial<MsgRow> = {}): MsgRow =>
    ({ id: `t${++k}`, short_id: `m${k}`, sender_jid: who, sender_name: who, text, type: 'text', is_bot: who === 'bot' ? 1 : 0, is_owner: 0, ts: T + at * 1000, ...extra });
  const rows: MsgRow[] = [];
  // Kanan laughs at digs (a laughing reply, a 😂 reaction)
  const d1 = r('bot', 'kanan predicted 3-0 again', 10); rows.push(d1, r('Kanan', 'HAHAHA ok fair', 12));
  const d2 = r('bot', 'kanan and his penalties', 60); rows.push(d2, { ...r('Kanan', '😂', 62), type: 'reaction', quoted_id: d2.id });
  // Aysel pushes back
  const d3 = r('bot', 'aysel still lost in the parking lot', 120); rows.push(d3, r('Aysel', 'not funny', 125));
  const d4 = r('bot', 'aysel driving again', 180); rows.push(d4, { ...r('Aysel', '🙄', 182), type: 'reaction', quoted_id: d4.id });
  // a line about two people tells nothing about either; a line nobody answers is just "teased"
  rows.push(r('bot', 'kanan and aysel both cooked', 240), r('bot', 'kanan you ok', 300), r('Murad', 'lol', 305));
  const takes = teaseReception(rows, ['Kanan Aliyev', 'Aysel', 'Murad']);
  const kanan = takes.find(t => t.name === 'Kanan Aliyev')!;
  const aysel = takes.find(t => t.name === 'Aysel')!;
  assert.deepEqual([kanan.teased, kanan.laughed, kanan.pushedBack], [3, 2, 0], JSON.stringify(kanan));
  assert.deepEqual([aysel.teased, aysel.laughed, aysel.pushedBack], [2, 0, 2]);
  const tx = formatTeasing([], takes)!;
  assert.ok(tx.includes('- Aysel pushed back on 2 of your 2 digs: keep it light with them') && tx.includes('- Kanan Aliyev laughed at 2 of your 3 digs: they enjoy it'), tx);
  assert.ok(teaseReception([r('bot', 'murad is washed', 10), r('Murad', 'отстань', 12)], ['Murad'])[0].pushedBack === 1, 'pushback in Russian');
  assert.ok(teaseReception([r('bot', 'murad is washed', 10), r('Murad', 'bəsdir', 12)], ['Murad'])[0].pushedBack === 1, 'pushback in Azerbaijani');
  assert.equal(teaseReception([r('bot', 'that is sus', 10), r('Murad', 'sus', 12)], ['Murad']).length, 0, 'English "sus" is not pushback (and nobody was named)');
  // quoting Kanan and naming him is one person, not two (full name in the member list, first name in the chat)
  const q = r('Kanan', 'i will score tonight', 400);
  const one = teaseReception([q, r('bot', 'kanan you will not', 410, { quoted_id: q.id }), r('Kanan', 'hahaha', 415)], ['Kanan Aliyev']);
  assert.deepEqual(one.map(t => [t.name, t.teased, t.laughed]), [['Kanan Aliyev', 1, 1]], JSON.stringify(one));
}
// lines that worked: one deduped list, without the bot's current tics or digs at an "easy on" person
const worked = formatLinesThatWorked(['good one 🔥', 'kanan is cooked 💀'], [{ text: 'good one 🔥', laughs: 2 }, { text: 'murad and the penalty again', laughs: 3 }],
  [{ who: 'Aysel', text: 'he drives like he takes pens', laughs: 2 }], { emojis: ['💀'], names: ['Kanan Aliyev'] })!;
assert.ok(worked.startsWith('LINES THAT WORKED HERE'));
assert.ok(worked.includes('- "good one 🔥" (your owner liked it)') && !worked.includes('(2 laughs)'), 'deduped: the owner-liked version wins');
assert.ok(!worked.includes('kanan is cooked'), 'a line with a current tic or aimed at an easy-on person is left out');
assert.ok(worked.includes('- Aysel: "he drives like he takes pens" (2 laughing)'));
assert.ok(formatLinesThatWorked(['ref is cooked 💀'], [], [], { emojis: ['💀'] })!.includes('- "ref is cooked" (your owner liked it)'), 'a liked line keeps its words; only the tic emoji is taken out');
assert.equal(formatLinesThatWorked(['kanan is cooked'], [], [], { names: ['Kanan'] }), null, 'never a dig at an easy-on person, even as the only example');
const capped = formatLinesThatWorked(['one a', 'two b', 'three c', 'four d'], [{ text: 'landed line', laughs: 2 }], [{ who: 'Aysel', text: 'group line', laughs: 2 }])!;
assert.equal((capped.match(/your owner liked it/g) ?? []).length, 2, 'at most 2 liked lines');
assert.ok(capped.includes('landed line') && capped.includes('group line'), 'the other kinds still get a place');
assert.equal(formatLinesThatWorked([], [], []), null);
assert.ok(formatClockLine([{ label: 'Baku', offset: 4 }]).startsWith('Time now (read off, never calculate; mention it only when the time or date matters): '));
assert.ok(formatClockLine([{ label: 'Baku', offset: 4 }], new Date(Date.UTC(2026, 9, 24, 3, 5))).includes('Baku Sat 24 Oct 2026, 07:05'));

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
  assert.ok(formatLinesThatWorked([], [], gl)!.includes('Kanan: "murad drives like'));

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
  const emptyMap = { people: [], chains: [] };
  assert.ok(formatRoomNow({ dyn: sad, map: emptyMap, cues: [] }, 'writer')!.includes('- bad news: #'));

  // reception: unprompted lines that got nothing raise the bar; an answer to a question is not judged
  const b = (text: string, at: number) => r('bot', text, at, { is_bot: 1 });
  const ignored = [r('Murad', 'match tonight', 0), b('madrid fans stay quiet tonight', 5), r('Kanan', 'what time', 10), r('Murad', '9', 12), r('Kanan', 'ok', 14),
    r('Murad', 'who is ref', 20), b('the ref is a barca fan, trust', 25), r('Kanan', 'pizza after?', 30), r('Murad', 'yes', 32), r('Aysel', 'me too', 34)];
  const rec = reception(ignored, 'ForceAI', T + 100_000);
  assert.deepEqual(rec, ['ignored', 'ignored']);
  assert.equal(ignoredStreak(rec), 2);
  const quietDyn = { privatePair: null, storyteller: null, hangingQuestion: null, serious: null };
  assert.ok(formatRoomNow({ dyn: quietDyn, map: emptyMap, cues: [], rec }, 'gate')!.includes('- your last 2 unprompted lines got no reaction'));
  assert.equal(formatRoomNow({ dyn: quietDyn, map: emptyMap, cues: [], rec }, 'writer'), null, 'reception is a timing fact: gate only');
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
  const avoid = lintPlan([{ type: 'message', text: 'madrid wins it 2-1 on sunday trust me' }],
    { recentBotTexts: [], recentHumanTexts: [], medianLen: 20, marker, unprompted: true, avoidTexts: ['madrid wins 2-1 sunday, trust me'] });
  assert.ok(avoid.actions.length === 0 && avoid.dropped[0].startsWith('too close to a line your owner disliked'));
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

// ---- round 8: who is doing what ----
{
  const T = 1_800_000_000_000;
  let k = 0;
  const r = (who: string, text: string, at: number, extra: Partial<MsgRow> = {}): MsgRow =>
    ({ id: `w${++k}`, short_id: `m${k}`, sender_jid: who, sender_name: who, text, type: 'text', is_bot: 0, is_owner: 0, ts: T + at * 1000, ...extra });
  const at = T + 120_000;
  const a1 = r('Murad', 'REF IS BLIND', 10);
  const a2 = r('Kanan', 'murad calm down', 20, { quoted_id: a1.id });
  const a3 = r('Murad', 'NO!! he saw it', 30, { quoted_id: a2.id });
  const b1 = r('Aysel', 'who is coming to dinner?', 40);
  const c1 = r('Kanan', 'hahaha', 45);
  const own = r('Said', 'anyone up?', 50, { is_owner: 1 });
  const bad = r('Leyla', 'my grandpa is in the hospital', 55);
  const map = roomMap([a1, a2, a3, b1, c1, own, bad], ['Murad', 'Kanan', 'Aysel', 'Leyla'], 'ForceAI', at);
  const who = Object.fromEntries(map.people.map(p => [p.name, p]));
  assert.ok(who.Murad.loud && who.Murad.talkingTo.includes('Kanan'), JSON.stringify(who.Murad));
  assert.ok(who.Kanan.talkingTo.includes('Murad') && !who.Kanan.loud);
  assert.equal(who.Aysel.openQuestion, null, 'others spoke after her question, so it is not "open" any more');
  assert.equal(who['Said (owner)'].openQuestion, null, "the owner's questions are never a cue (labelled like the transcript)");
  assert.ok(who.Leyla.serious);
  assert.deepEqual(map.chains, [{ ids: [a1.short_id, a2.short_id, a3.short_id], people: ['Murad', 'Kanan'], fresh: true }]);
  const noDyn = { privatePair: null, storyteller: null, hangingQuestion: null, serious: null };
  const txt = formatRoomNow({ dyn: noDyn, map, cues: [] }, 'writer')!;
  assert.ok(txt.startsWith('ROOM NOW (facts counted in code):'), txt);
  assert.ok(txt.includes('- people: ') && txt.includes('Murad loud talking to Kanan') && txt.includes('Kanan laughing talking to Murad'), txt);
  assert.ok(txt.includes('- bad news: Leyla may be going through something real'), txt);
  assert.ok(txt.includes(`- reply chain: #${a1.short_id} > #${a2.short_id} > #${a3.short_id} (Murad, Kanan)`), txt);
  assert.ok(!txt.includes('messages,'), 'no per-person message counts');
  assert.equal(formatRoomNow({ dyn: noDyn, map: roomMap([], [], 'ForceAI', T), cues: [] }, 'writer'), null);
  assert.equal(roomMap([a1, a2, a3], [], 'ForceAI', T + 10 * 60_000).chains[0].fresh, false, 'an old chain is not shown as running');
  // one fact, said once: an open question and bad news are not repeated
  const qDyn = dynamics([r('Aysel', 'who is coming to dinner?', 100), r('Leyla', 'my grandpa is in the hospital', 101)], 'ForceAI', T + 110_000);
  const qMap = roomMap([r('Aysel', 'who is coming to dinner?', 100), r('Leyla', 'my grandpa is in the hospital', 101)], [], 'ForceAI', T + 110_000);
  const once = formatRoomNow({ dyn: qDyn, map: qMap, cues: [] }, 'writer')!;
  assert.equal(once.split('bad news').length - 1, 1, once);
  assert.ok(once.includes('(Leyla) may be real'), 'says who sent the bad news');
  // a question at the end of someone's run is shown as possibly part of the story, and the policy stays neutral
  const run = [r('Kanan', 'so yesterday im at the gym', 100), r('Kanan', 'and this guy walks in', 105), r('Kanan', 'you know what he did?', 110)];
  const runDyn = dynamics(run, 'ForceAI', T + 115_000);
  assert.ok(runDyn.storyteller === 'Kanan' && runDyn.hangingQuestion, 'both facts kept for the policy');
  const runTxt = formatRoomNow({ dyn: runDyn, map: roomMap(run, [], 'ForceAI', T + 115_000), cues: [] }, 'gate')!;
  assert.ok(runTxt.includes('- Kanan: several messages in a row, the last one a question') && !runTxt.includes('open question:'), runTxt);
  // the writer, when nobody asked and it has talked a lot
  const loudPart = { window: 30, botShare: 0.4, humansSinceBot: 1, secondsSinceBot: 20 };
  assert.ok(formatRoomNow({ dyn: noDyn, map: { people: [], chains: [] }, cues: [], part: loudPart }, 'writer')!.includes('(a lot lately: say less)'));
  assert.ok(formatRoomNow({ dyn: noDyn, map: { people: [], chains: [] }, cues: [], part: loudPart, asked: true }, 'writer')!.includes('(answer, and keep it short)'));
  assert.equal(roomMap([r('Murad', 'old', 0)], [], 'ForceAI', T + 20 * 60_000).people.length, 0, 'only recent minutes');
  const lone = roomMap([r('Aysel', 'who is coming to dinner?', 40)], [], 'ForceAI', T + 60_000);
  assert.equal(lone.people[0].openQuestion, `m${k}`);

  // review fixes
  const botLine = r('bot', 'madrid by two', 5, { is_bot: 1 });
  const ownerQuote = r('Said', 'lmao true', 8, { is_owner: 1, quoted_id: botLine.id });
  const ownerCmd = r('Said', 'forceai, roast kanan', 9, { is_owner: 1 });
  const m1 = roomMap([botLine, ownerQuote, ownerCmd], [], 'ForceAI', at);
  assert.deepEqual(m1.people.find(p => p.name === 'Said (owner)')!.talkingTo, [], "the owner's lines never point at anyone");
  const asked = r('Kanan', 'forceai, who wins?', 10);
  const answered = r('bot', 'barca', 12, { is_bot: 1 });
  assert.deepEqual(roomMap([asked], [], 'ForceAI', at).people[0].talkingTo, ['ForceAI'], 'unanswered: talking to it');
  assert.deepEqual(roomMap([asked, answered], [], 'ForceAI', at).people[0].talkingTo, [], 'answered: not any more');
  const grief = roomMap([r('Leyla', 'my grandpa passed away', 10), r('Kanan', 'condolences 🙏', 11), r('Murad', 'başın sağ olsun qardaş', 12), r('Aysel', 'başsağlığı', 13)], [], 'ForceAI', at);
  assert.deepEqual(grief.people.filter(p => p.serious).map(p => p.name), ['Leyla'], 'only the one with the loss');
  const tickets = r('Murad', 'i bought the tickets', 10);
  const howMuch = r('Kanan', 'for how much?', 11, { quoted_id: tickets.id });
  assert.equal(roomMap([tickets, howMuch], [], 'ForceAI', at).people.find(p => p.name === 'Kanan')!.openQuestion, null, 'a question to a friend is not a question to the group');
  assert.equal(roomMap([tickets, r('Kanan', 'murad, how much?', 11)], [], 'ForceAI', at).people.find(p => p.name === 'Kanan')!.openQuestion, null);
  const caps = roomMap([r('Kanan', 'HAHAHAHAHAHAHAHAHAHAHAHAHAHAHA', 10), r('Kanan', 'ХАХАХАХА', 11)], [], 'ForceAI', at).people[0];
  assert.ok(caps.laughing && !caps.loud, 'laughing in caps is laughing, not loud');
  const crowd = ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7'].flatMap((n, i) => [r(n, 'yo', 20 + i), r(n, 'yo yo', 30 + i)]);
  assert.ok(roomMap([r('Leyla', 'my mom is in the hospital', 10), ...crowd], [], 'ForceAI', at).people.some(p => p.name === 'Leyla'), 'someone going through something is never cut off the list');
  assert.deepEqual(roomMap([r('Murad', 'can someone grab ice', 10)], ['Can Yilmaz'], 'ForceAI', at).people[0].talkingTo, [], '"can someone" is not aimed at Can');
  assert.deepEqual(roomMap([r('Murad', 'can, grab ice', 10)], ['Can Yilmaz'], 'ForceAI', at).people[0].talkingTo, ['Can Yilmaz']);
  const reacts = roomMap([r('Kanan', '👍', 10, { type: 'reaction', quoted_id: 'x' }), r('Kanan', '', 11, { type: 'reaction', quoted_id: 'x' }), r('Kanan', 'ok', 12)], [], 'ForceAI', at).people[0];
  assert.equal(reacts.msgs, 1, 'reactions are not messages');
  const twins = roomMap([r('Murad', 'hi?', 10, { sender_jid: 'm1@s' }), r('Murad', 'yo', 11, { sender_jid: 'm2@s' })], [], 'ForceAI', at).people;
  assert.equal(twins.length, 2, 'two people with the same name stay two people');
}

// ---- round 10: irony cues in the group's languages ----
{
  const T = 1_800_000_000_000;
  let k = 0;
  const r = (who: string, text: string, at: number, extra: Partial<MsgRow> = {}): MsgRow =>
    ({ id: `i${++k}`, short_id: `m${k}`, sender_jid: who, sender_name: who, text, type: 'text', is_bot: 0, is_owner: 0, ts: T + at * 1000, ...extra });
  const now = T + 120_000;
  const cueOf = (text: string) => ironyCues([r('Kanan', text, 60)], now)[0]?.cue ?? null;
  // sarcasm that should be flagged, in each language, typed either way
  for (const [line, cue] of [
    ['yeah right, he totally scored', '"yeah right"'], ['ага, конечно', '"ага, конечно"'], ['ага щас', '"ага щас"'],
    ['кто бы сомневался', '"кто бы сомневался"'], ['ну да, ну да', '"ну да, ну да"'], ['aga konechno', '"aga konechno"'],
    ['tabii tabii', '"tabii tabii"'], ['TABİİ TABİİ', '"tabii tabii"'], ['ne demezsin', '"ne demezsin"'], ['cok biliyorsun', '"cok biliyorsun"'],
    ['hə də, hə də', '"hə də, hə də"'], ['he de he de', '"he de he de"'], ['cox bilirsen', '"cox bilirsen"'],
  ] as const) assert.equal(cueOf(line), cue, line);
  assert.equal(cueOf('very funny.'), 'a dry "very funny" (no laugh with it)');
  assert.equal(cueOf('очень смешно'), 'a dry "very funny" (no laugh with it)');
  assert.equal(cueOf('he is so smart 🙄'), 'an eye-roll, smirk or clown emoji');
  assert.equal(cueOf('nice 👏 one 👏'), 'claps between words');
  assert.equal(cueOf('best ref ever /s'), '"/s"');
  // everyday sincere lines must stay clean (a wrong hint is worse than none)
  for (const line of ['aynen kanka', 'çox sağ ol qardaş', 'ne güzel olmuş', 'hə də, gəlirəm', 'hə, əlbəttə gəlirəm', 'ну да, логично', 'tabii canım gel',
    'thanks a lot man, saved me', 'oh perfect, see you at 8', 'wow thanks for the ticket', 'big brain play by messi', 'legend 💀', 'gg 😂',
    'очень смешной мем', 'çok komikti ya 😂', 'very funny 😂😂', 'see /s/abc', 'what a goal, genius pass', 'ну дай мне', 'see you at nine']) {
    assert.equal(cueOf(line), null, line);
  }
  // strong cues are kept over weak ones
  const usual = ['bro that was crazy', 'i am on my way', 'who is playing tonight', 'nah he is washed', 'see you there then', 'he is cooked'].map((t, i) => r('Murad', t, 10 + i));
  const mix = ironyCues([r('Aysel', 'yeah right he scored', 40), r('Kanan', '🙄🙄', 61), r('Leyla', 'ok 🙃', 62), r('Aysel', 'smart 🤡', 63), r('Murad', 'sure 😏', 64)], now);
  assert.equal(mix.length, 3);
  assert.ok(mix.some(c => c.cue === '"yeah right"'), 'the strongest cue is never pushed out by newer weak ones');
  assert.deepEqual(mix.map(c => c.who), ['Aysel', 'Aysel', 'Murad'], 'kept in chat order');
  // alphabet switch: only a clear one (5 of the last 6 and the one right before), real sentences, links ignored
  const sw = ironyCues([...usual, r('Murad', 'ну конечно он лучший игрок', 60)], now);
  assert.equal(sw[0]?.cue, 'a switch to Russian (sometimes a joke or a quote)');
  const lasting = ironyCues([...usual, r('Murad', 'да я уже еду домой', 60), r('Murad', 'буду через десять минут', 61)], now);
  assert.equal(lasting.length, 1, 'a lasting switch is flagged once, not on every message');
  const ruUsual = ['я уже еду домой', 'кто сегодня играет', 'он вообще не умеет', 'давай завтра тогда', 'ну это было сильно', 'посмотрим что будет'].map((t, i) => r('Kanan', t, 10 + i));
  assert.equal(ironyCues([...ruUsual, r('Kanan', 'https://youtu.be/dQw4w9WgXcQ', 60)], now).length, 0, 'a link is not a switch');
  assert.equal(ironyCues([...ruUsual, r('Kanan', 'Vinicius Jr', 60)], now).length, 0, 'a name is not a switch');
  assert.equal(ironyCues([...usual.slice(0, 4), r('Murad', 'ну конечно он лучший игрок', 60)], now).length, 0, 'not enough history to call it a switch');
  assert.equal(ironyCues([r('Said', 'yeah right', 60, { is_owner: 1 })], now).length, 0, "the owner's lines are never cues");
  assert.equal(ironyCues([r('Kanan', 'yeah right', 0)], T + 20 * 60_000).length, 0, 'only the last minutes');
  const quiet = { privatePair: null, storyteller: null, hangingQuestion: null, serious: null };
  assert.ok(formatRoomNow({ dyn: quiet, map: { people: [], chains: [] }, cues: sw }, 'gate')!.includes(`- possible irony: #${sw[0].shortId} Murad, a switch to Russian`));
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
let tasteAnswer: any = { rules: ['keep jump-ins to one short line', ' ', 'tease Kanan lightly'] };
let tasteDelay = 0;
let genAnswer: any;
let criticAnswer: any = { reason: 'not funny', verdict: 'skip' };
const fakeAi: any = {
  gatekeeperModel: 'claude-haiku-5-5', generationModel: 'claude-sonnet-5-5',
  tuning: (_m: string, mt: number) => ({ max_tokens: mt, effort: 'low' }),
  recordUsage: () => undefined,
  isOverBudget: () => false,
  client: { messages: { parse: async (req: any) => {
    calls.push(req);
    const schema = JSON.stringify(req.output_config.format);
    if (schema.includes('"addressed"')) return { usage: {}, stop_reason: 'end_turn', parsed_output: gateAnswer() };
    if (schema.includes('"verdict"')) return { usage: {}, stop_reason: 'end_turn', parsed_output: criticAnswer };
    if (schema.includes('"rules"')) {
      if (tasteDelay) await new Promise(r => setTimeout(r, tasteDelay));
      return { usage: {}, stop_reason: 'end_turn', parsed_output: tasteAnswer };
    }
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
assert.ok(gateReq.messages[0].content.includes('ROOM NOW (facts counted in code):') && /- you: \d+% of the last \d+ messages, \d+ human messages since you last spoke/.test(gateReq.messages[0].content), 'gatekeeper gets the talk share in ROOM NOW');
assert.ok(gateReq.messages[0].content.includes('Time now (read off, never calculate; mention it only when the time or date matters):'), 'one-line clock');
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
assert.ok(userText.includes('Someone talked to you: answer them'), 'the writer knows it was asked');
assert.ok(userText.includes('"kanan tax": Murad, Kanan, 3 times over 3 days'), 'running bits reach the generator');
assert.ok(userText.includes('2 days ago: "madrid wins 2-1 sunday, trust me"'), 'own takes reach the generator, marker stripped');
assert.ok(userText.includes('LINES THAT WORKED HERE') && userText.includes('- "madrid fans in shambles 💀" (your owner liked it)'), 'owner taste reaches the generator, marker stripped');
assert.ok(genReq.system[0].text.includes('HOW A REAL FRIEND TEXTS'), 'v2 craft block in the system prompt');
assert.ok(genReq.system[0].text.includes('bad news in ROOM NOW, if it is real, means no jokes'), 'the writer knows bad news works like a rule');
assert.ok(!genReq.system[0].text.includes('great question'), 'no banned phrase planted in the prompt');
assert.deepEqual(res.plan.actions.map(a => a.type), ['message', 'reaction'], 'nobody quotes here and m60 is the newest: plain message');
assert.equal((res.plan.actions[0] as any).text, 'kanan said that last season too');
assert.ok(res.plan.note.includes('angle: callback') && res.plan.note.includes('rewrote 1'));

// second opinion: only for unprompted lines; "skip" means silence, "send" keeps the plan
calls.length = 0;
const vetoed = await brain.generate({ chatJid: G, consumedUpToTs: Date.now() - 60_000, unprompted: true });
assert.equal(calls.length, 3, 'generator + rewrite + second opinion');
assert.ok(!calls[0].messages[0].content.includes('Someone talked to you'), 'a jump-in is not told it was asked');
assert.ok(!calls[2].messages[0].content.includes('(you)'), 'the critic plays a member: the bot is labelled by name');
assert.deepEqual(vetoed!.plan.actions, []);
assert.ok(vetoed!.plan.note.includes('second opinion said skip: not funny'));
criticAnswer = { reason: 'lands', verdict: 'send' };
const sent = await brain.generate({ chatJid: G, consumedUpToTs: Date.now() - 60_000, unprompted: true });
assert.equal(sent!.plan.actions.length, 2);
calls.length = 0;
criticAnswer = { reason: 'nope', verdict: 'skip' };
const told = await brain.generate({ chatJid: G, consumedUpToTs: Date.now() - 60_000, unprompted: true, operatorInstruction: 'say hi to kanan' });
assert.equal(calls.length, 2, 'an owner instruction never goes to the second opinion');
assert.equal(told!.plan.actions.length, 2);
repo.setConfig('v2_second_opinion', '0');
calls.length = 0;
await brain.generate({ chatJid: G, consumedUpToTs: Date.now() - 60_000, unprompted: true });
assert.equal(calls.length, 2, 'second opinion off: no extra call');
calls.length = 0;
await brain.generate({ chatJid: G, consumedUpToTs: Date.now() - 60_000, addressIds: ['m60'] });
assert.equal(calls.length, 2, 'answers when addressed never get a second opinion');

// owner's calls on v2 decisions reach the v2 gatekeeper as examples of when to talk
const d1 = repo.insertDecision(G, 'T1v2', 'RESPOND', 'r | strong thought | urge 7 vs bar 6.5 | thought: roast kanan again');
repo.insertDecision(G, 'T2v2', 'SEND', 'v2 line');
const d2 = repo.insertDecision(G, 'T1v2', 'IGNORE', 'r | nothing worth adding | urge 4 vs bar 6.5 | thought: ask about the match');
const d3 = repo.insertDecision(G, 'T2', 'SEND', 'v1 line');
assert.equal(repo.setDecisionFeedback(d1, 'bad'), true);
assert.equal(repo.setDecisionFeedback(d2, 'bad'), true);
assert.equal(repo.setDecisionFeedback(d3, 'good'), false, 'only v2 turn-taking decisions can be rated');
assert.deepEqual([...repo.getDecisionVerdicts([d1, d2, d3]).entries()], [[d1, 'bad'], [d2, 'bad']]);
const fb = formatDecisionFeedback(repo.getDecisionFeedback(G, 8))!;
assert.equal(repo.getDecisionFeedback('other@g.us', 8).length, 0, 'calls stay in their group');
assert.ok(fb.includes('should have STAYED QUIET here: r / thought: roast kanan again') && fb.includes('should have SPOKEN here: r / thought: ask about the match'), fb);
assert.ok(!fb.includes('urge'), 'the code numbers stay out of the examples');
assert.ok(formatDecisionFeedback([{ decision: 'RESPOND', reason: 'asked who wins | addressed | urge 0 vs bar 6.5', verdict: 'bad' }])!.includes('your answer MISSED here'), 'a bad answer is not "stay quiet"');
// the model's own reason may contain " | ": the fixed tail is read from the right
assert.deepEqual(parseDecisionLine('kanan vs murad | addressed is a word here | strong thought | urge 7 vs bar 6.5 (pair talking +0.8) | thought: a | b'),
  { reason: 'kanan vs murad | addressed is a word here', why: 'strong thought', thought: 'a | b' });
assert.ok(formatDecisionFeedback([{ decision: 'RESPOND', reason: 'x | addressed is a word here | strong thought | urge 7 vs bar 6.5', verdict: 'bad' }])!.includes('should have STAYED QUIET'), 'only the policy part decides "addressed"');
assert.ok(formatDecisionFeedback([{ decision: 'RESPOND', reason: 'banter | addressed: direct trigger on m4 | urge 7 vs bar 6.5', verdict: 'bad' }])!.includes('your answer MISSED here'));
assert.deepEqual(parseDecisionLine('chat paused, offering a saved thought: x'), { reason: 'chat paused, offering a saved thought: x', why: '', thought: null });
prompts.memoryVersion += 1;
calls.length = 0;
await brain.gate(G, Date.now() - 60_000, false);
assert.ok(calls[0].system[1].text.includes("YOUR OWNER'S CALLS ON YOUR PAST DECISIONS"), 'owner calls reach the gatekeeper');
const sb = repo.brainV2Stats(G, 0);
assert.equal(sb.spoke, 1, 'RESPOND counted');
assert.equal(sb.unprompted, 1, 'not addressed: unprompted');
assert.equal(sb.quiet, 1);
assert.ok(sb.rewrites >= 1 || sb.vetoed >= 0);
// the scoreboard counts what was really sent: direct answers too, never a line the second opinion stopped
{
  const GX = 'stats@g.us';
  repo.insertDecision(GX, 'T2v2', 'SEND', 'answered a mention (no T1v2 row)');
  repo.insertDecision(GX, 'T1v2', 'RESPOND', 'r | strong thought | urge 7 vs bar 6.5');
  repo.insertDecision(GX, 'T2v2', 'NOTHING', 'second opinion said skip: too try-hard');
  repo.insertDecision(GX, 'T1v2', 'PAUSE', 'chat paused, offering a saved thought: x');
  repo.insertDecision(GX, 'T2v2', 'SEND', 'v2 line');
  repo.insertDecision(GX, 'T1v2', 'RESPOND', 'r | addressed: direct trigger on m4 | urge 0 vs bar 6.5');
  repo.insertDecision(GX, 'T2v2', 'SEND', 'v2 answer');
  repo.insertDecision(GX, 'T1v2', 'FAILED', 'gatekeeper failed or unparseable');
  repo.insertDecision(GX, 'T1v2', 'DROPPED', 'put to sleep or paused while thinking: nothing sent');
  const st = repo.brainV2Stats(GX, 0);
  assert.deepEqual([st.spoke, st.unprompted, st.pauses, st.vetoed, st.quiet], [3, 0, 1, 1, 0], JSON.stringify(st));
}
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
// the writer in replay: the chat as it was at the cut, no current scene or clock, nothing saved
repo.setSummary(G, 'Murad got fired after the match', Date.now()); // written after the replayed moment
prompts.memoryVersion += 1;
calls.length = 0;
await brain.gate(G, cutRow.ts - 30_000, false, { untilTs: cutRow.ts });
assert.ok(!calls[0].system[1].text.includes('Murad got fired'), 'the gate in a replay never sees a summary of later events');
// owner calls (their reasons quote later chat) and house rules learned after the moment stay out of a replay
repo.setConfig(`v2_taste_rules_${G}`, JSON.stringify(['keep jump-ins to one line']));
repo.setConfig(`v2_taste_at_${G}`, String(Date.now()));
brain.invalidate(G);
calls.length = 0;
await brain.gate(G, Date.now() - 60_000, false, { dryRun: true });
assert.ok(calls[0].system[1].text.includes("YOUR OWNER'S CALLS") && calls[0].system[1].text.includes('keep jump-ins to one line'), 'live: both are there');
calls.length = 0;
await brain.gate(G, cutRow.ts - 30_000, false, { untilTs: cutRow.ts });
assert.ok(!calls[0].system[1].text.includes("YOUR OWNER'S CALLS") && !calls[0].system[1].text.includes('keep jump-ins to one line'), calls[0].system[1].text);
repo.setConfig(`v2_taste_at_${G}`, String(cutRow.ts - 1000)); // rules learned before the moment are fine
calls.length = 0;
await brain.gate(G, cutRow.ts - 30_000, false, { untilTs: cutRow.ts });
assert.ok(calls[0].system[1].text.includes('keep jump-ins to one line'));
repo.setConfig(`v2_taste_rules_${G}`, '[]');
brain.invalidate(G);
calls.length = 0;
const obsBefore = (db.prepare('SELECT COUNT(*) AS n FROM member_observations').get() as any).n;
genAnswer = { ...genAnswer, actions: [{ type: 'message', text: 'that was a weird pass' }], observation: { note: 'Murad seems tired', about_message_id: 'm50' } };
const rgen = await brain.generate({ chatJid: G, consumedUpToTs: cutRow.ts - 30_000, addressIds: ['m50'], unprompted: true, untilTs: cutRow.ts });
assert.ok(rgen);
const rtext = calls[0].messages[0].content as string;
assert.ok(rtext.includes('#m50 ') && !rtext.includes('#m51 ') && !rtext.includes('madrid will win the league watch'), 'nothing after the cut');
assert.ok(!rtext.includes('SCENE RIGHT NOW') && !rtext.includes('Time now'), 'no scene or clock from today');
assert.ok(!JSON.stringify(calls[0].system).includes('Murad got fired'), 'the writer in a replay never sees a summary of later events');
assert.ok(!rtext.includes('madrid fans in shambles'), 'lines liked after the moment are not shown as liked');
calls.length = 0;
await brain.generate({ chatJid: G, consumedUpToTs: cutRow.ts - 30_000, addressIds: ['m50'], unprompted: true, untilTs: cutRow.ts,
  scene: { topic: 'derby day', threads: 'everyone', vibe: 'hype', running_bit: null, bit_played_out: false } });
assert.ok((calls[0].messages[0].content as string).includes('SCENE RIGHT NOW: derby day'), 'the scene of that moment is passed in');
calls.length = 0;
await brain.generate({ chatJid: G, consumedUpToTs: Date.now() - 60_000, addressIds: ['m60'], dryRun: true });
assert.ok(JSON.stringify(calls[0].system).includes('Murad got fired'), 'live calls still get the summary');
assert.equal((db.prepare('SELECT COUNT(*) AS n FROM member_observations').get() as any).n, obsBefore, 'a replay saves no observation');

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

// a 👎 line: kept out of "own takes", and a close copy of it is blocked
assert.equal(repo.setFeedback('o4', -1), true);
calls.length = 0;
genAnswer = { ...genAnswer, actions: [{ type: 'message', text: 'madrid wins 2-1 sunday trust me fr' }] };
const disliked = await brain.generate({ chatJid: G, consumedUpToTs: Date.now() - 60_000, unprompted: true });
const dislikedText = calls[0].messages[0].content as string;
assert.ok(!dislikedText.includes('madrid wins 2-1 sunday, trust me'), 'a disliked line is never shown to the writer');
assert.deepEqual(disliked!.plan.actions, []);
assert.equal(disliked!.lint.dropped.length, 1, 'blocked (here as its own recent line; the 👎 path is unit-tested above)');

// shadow decisions can be rated and are counted; blind A/B tally
const GS = 'shadow@g.us';
repo.insertDecision(GS, 'T1', 'RESPOND', 'v1 spoke before shadow was on');
await new Promise(r => setTimeout(r, 5));
const sd = repo.insertDecision(GS, 'S1v2', 'RESPOND', 'banter | strong thought | urge 7 vs bar 6.5 | thought: x');
repo.insertDecision(GS, 'T1', 'RESPOND', 'v1 spoke');
repo.insertDecision(GS, 'S1v2', 'IGNORE', 'r | nothing worth adding | urge 3 vs bar 6.5');
repo.insertDecision(GS, 'T1', 'IGNORE', 'v1 quiet');
await new Promise(r => setTimeout(r, 5));
repo.insertDecision(GS, 'T1', 'RESPOND', 'v1 spoke, its shadow failed');
repo.insertDecision(GS, 'S1v2', 'FAILED', 'thinking stage failed or unparseable');
await new Promise(r => setTimeout(r, 5));
repo.insertDecision(GS, 'T1', 'RESPOND', 'v1 spoke, no shadow row at all (over budget)');
assert.equal(repo.setDecisionFeedback(sd, 'good'), true, 'shadow calls teach the gatekeeper too');
const sst = repo.brainV2Stats(GS, 0);
assert.deepEqual([sst.shadow.spoke, sst.shadow.quiet, sst.v1Spoke], [1, 1, 1], 'v1 counted only in the moments the shadow saw (and did not fail)');
repo.addBrainAb(G, 'v2'); repo.addBrainAb(G, 'v2'); repo.addBrainAb(G, 'tie');
assert.deepEqual(repo.getBrainAb(G), { v1: 0, v2: 2, tie: 1 });
assert.deepEqual(repo.getBrainAb('other@g.us'), { v1: 0, v2: 0, tie: 0 });

// shadow mode keeps its own scene (like real v2 carries one), and never touches v2's live state
brain.forget(G);
gateAnswer = () => gate({ decision: 'IGNORE', s: { timing: 3 } });
calls.length = 0;
await brain.gate(G, Date.now() - 60_000, false, { dryRun: true, shadow: true });
assert.ok(!calls[0].messages[0].content.includes('Your previous read of the scene'));
await brain.gate(G, Date.now() - 60_000, false, { dryRun: true, shadow: true });
assert.ok(calls[1].messages[0].content.includes('Your previous read of the scene: football'), 'the shadow carries its own scene');
assert.equal(brain.lastScene(G), null, "the live v2 scene stays untouched");
assert.equal(brain.hasThought(G), false, 'and no thought is saved');
brain.forget(G);
calls.length = 0;
await brain.gate(G, Date.now() - 60_000, false, { dryRun: true, shadow: true });
assert.ok(!calls[0].messages[0].content.includes('Your previous read of the scene'), 'switching brains forgets it');
saveOne();

// learning loop: the owner's ratings in a group become a few house rules both stages follow
const learned: string[][] = [];
const taste = new TasteLearner(repo, fakeAi, (_jid, rules) => { learned.push(rules); prompts.memoryVersion += 1; });
assert.deepEqual(taste.state('empty@g.us').rules, []);
assert.equal((await taste.run('empty@g.us')).status, 'empty', 'nothing to learn from');
assert.ok(taste.state(G).newRatings > 0, 'this group has ratings');
calls.length = 0;
const tr = await taste.run(G);
assert.equal(tr.status, 'ok');
assert.deepEqual(tr.rules, ['keep jump-ins to one short line', 'tease Kanan lightly'], 'blank rules dropped');
assert.deepEqual(readTasteRules(repo, G), tr.rules);
assert.equal(taste.state(G).newRatings, 0, 'counted from the learn time');
assert.equal(learned.length, 1);
const tasteReq = calls[0].messages[0].content as string;
assert.ok(tasteReq.includes('LINES THE OWNER LIKED') && tasteReq.includes('DECISIONS THE OWNER JUDGED'));
assert.ok(!tasteReq.includes('- 🤖'), 'lines reach the learner without the bot marker');
assert.ok(!/urge \d/.test(tasteReq), 'no code numbers in what it learns from');
calls.length = 0;
await brain.gate(G, Date.now() - 60_000, false, { dryRun: true });
assert.ok(calls[0].system[1].text.includes("YOUR OWNER'S HOUSE RULES FOR THIS GROUP") && calls[0].system[1].text.includes('- tease Kanan lightly'), 'the thinking stage follows them');
assert.ok(calls[0].system[1].text.includes('boundaries and usage dials still win'));
calls.length = 0;
await brain.generate({ chatJid: G, consumedUpToTs: Date.now() - 60_000, addressIds: ['m60'], dryRun: true });
assert.ok((calls[0].messages[0].content as string).includes('- keep jump-ins to one short line'), 'the reply writer follows them');
assert.equal(readTasteRules(repo, 'other@g.us').length, 0, 'groups never share them');
// auto: only where v2 runs or shadows, and only after enough new ratings
repo.setBrainVersion(G, 'v1');
for (const id of ['x58', 'x59']) repo.setFeedback(id, 1);
taste.maybeAuto(G);
assert.equal(learned.length, 1, 'v1 groups never learn');
taste.clear(G);
assert.deepEqual(readTasteRules(repo, G), []);
assert.equal(learned.length, 2);
repo.setConfig(`v2_taste_rules_${G}`, 'not json');
assert.deepEqual(readTasteRules(repo, G), [], 'a broken value reads as no rules');
repo.setBrainVersion(G, 'v2');
await new Promise(r => setTimeout(r, 5));
for (let i = 0; i < 7; i++) repo.setDecisionFeedback(repo.insertDecision(G, 'T1v2', 'IGNORE', `r${i} | quiet | urge 3 vs bar 6.5`), 'good');
taste.maybeAuto(G);
assert.equal(learned.length, 2, '7 new ratings: not yet');
repo.setDecisionFeedback(repo.insertDecision(G, 'T1v2', 'RESPOND', 'r8 | strong thought | urge 7 vs bar 6.5'), 'bad');
taste.maybeAuto(G);
await new Promise(r => setTimeout(r, 50));
assert.equal(learned.length, 3, 'the 8th rating relearns the rules');
assert.deepEqual(readTasteRules(repo, G), ['keep jump-ins to one short line', 'tease Kanan lightly']);

// a WAIT call is told to the learner as waiting, not speaking
repo.setDecisionFeedback(repo.insertDecision(G, 'T1v2', 'WAIT', 'Murad is mid-story | mid-thought | urge 5 vs bar 6.5'), 'good');
calls.length = 0;
await taste.run(G);
assert.ok((calls[0].messages[0].content as string).includes('RIGHT to wait for them to finish: Murad is mid-story'));

// a failed learn is not retried on every rating
tasteAnswer = null;
calls.length = 0;
assert.equal((await taste.run(G)).status, 'error');
assert.ok(repo.getConfig(`v2_taste_fail_${G}`));
for (let i = 0; i < 9; i++) repo.setDecisionFeedback(repo.insertDecision(G, 'T1v2', 'IGNORE', `f${i} | quiet | urge 3 vs bar 6.5`), 'good');
taste.maybeAuto(G);
await new Promise(r => setTimeout(r, 30));
assert.equal(calls.length, 1, 'no automatic retry right after a failure');
assert.deepEqual(readTasteRules(repo, G), ['keep jump-ins to one short line', 'tease Kanan lightly'], 'old rules kept');

// "Clear rules" while a learn is running: the clear wins
tasteAnswer = { rules: ['a rule that must not come back'] };
tasteDelay = 60;
const slow = taste.run(G);
await new Promise(r => setTimeout(r, 10));
assert.equal((await taste.run(G)).status, 'busy', 'one learn at a time per group');
taste.clear(G);
await slow;
tasteDelay = 0;
assert.deepEqual(readTasteRules(repo, G), [], 'the cleared rules stay cleared');
tasteAnswer = { rules: ['keep jump-ins to one short line'] };

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
