import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/memory/db.js';
import { Repo } from '../src/memory/repo.js';
import { PromptBuilder } from '../src/ai/prompts.js';
import { BrainV2 } from '../src/ai/v2/brain.js';
import { lintPlan, phoneStyle, autoFix } from '../src/ai/v2/lint.js';
import { decide, threshold } from '../src/ai/v2/policy.js';
import {
  botTics, callbackKeywords, formatTics, landedLines, participation, styleStats, type MsgRow,
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

// ---- linter ----
const marker = { prefix: '🤖 ', suffix: '' };
assert.equal(autoFix('🤖 he scored — twice', marker), 'he scored, twice');
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
], { recentBotTexts: ['bro is cooked 💀'], recentHumanTexts: chat.map(r => r.text ?? ''), medianLen: 14, marker, lowercaseShare: 0.9 });
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
let genAnswer: any;
const fakeAi: any = {
  gatekeeperModel: 'claude-haiku-5-5', generationModel: 'claude-sonnet-5-5',
  tuning: (_m: string, mt: number) => ({ max_tokens: mt, effort: 'low' }),
  recordUsage: () => undefined,
  client: { messages: { parse: async (req: any) => {
    calls.push(req);
    const schema = JSON.stringify(req.output_config.format);
    if (schema.includes('"addressed"')) return { usage: {}, stop_reason: 'end_turn', parsed_output: gate({ decision: 'IGNORE', s: { timing: 3 } }) };
    if (schema.includes('"fixes"')) return { usage: {}, stop_reason: 'end_turn', parsed_output: { fixes: [{ index: 0, text: 'kanan said that last season too' }] } };
    return { usage: {}, stop_reason: 'end_turn', parsed_output: genAnswer };
  } } },
};
const prompts = new PromptBuilder(repo);
const brain = new BrainV2(fakeAi, repo, prompts);

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
  actions: [{ type: 'reply', text: 'Kanan said that last season too — as an AI I remember everything', target_message_id: 'm60' }, { type: 'reaction', emoji: '💀', target_message_id: 'm60' }],
  note: 'callback', observation: null,
};
const res = await brain.generate({ chatJid: G, consumedUpToTs: Date.now() - 60_000, addressIds: ['m60'], thought: 'kanan predicted 3-0' });
assert.ok(res);
assert.equal(calls.length, 2, 'generator + one rewrite (AI tell found)');
const genReq = calls[0];
const userText = typeof genReq.messages[0].content === 'string' ? genReq.messages[0].content : genReq.messages[0].content[0].text;
assert.ok(userText.includes('SCENE RIGHT NOW: football'), 'scene from the gatekeeper reaches the generator');
assert.ok(userText.includes('HOW THIS CHAT TEXTS RIGHT NOW'), 'style numbers');
assert.ok(userText.includes('OLDER MOMENTS'), 'callback candidates found');
assert.ok(userText.includes('A THOUGHT YOU HAD A MOMENT AGO'), 'saved thought offered');
assert.ok(genReq.system[0].text.includes('HOW A REAL FRIEND TEXTS'), 'v2 craft block in the system prompt');
assert.ok(!genReq.system[0].text.includes('great question'), 'no banned phrase planted in the prompt');
assert.deepEqual(res.plan.actions.map(a => a.type), ['reply', 'reaction']);
assert.equal((res.plan.actions[0] as any).text, 'kanan said that last season too');
assert.ok(res.plan.note.includes('angle: callback') && res.plan.note.includes('rewrote 1'));

// v1 is untouched: its frozen block has no v2 text
assert.ok(!prompts.getBlockA().includes('HOW A REAL FRIEND TEXTS'));
assert.ok(prompts.getBlockAV2().startsWith(prompts.getBlockA().split('\n\n')[0]), 'v2 starts from the same persona');

db.close();
fs.rmSync(dir, { recursive: true, force: true });
console.log('brain v2: all checks passed');
