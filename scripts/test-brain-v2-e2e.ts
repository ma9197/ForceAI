import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ARBITER, BRAIN_V2 } from '../src/config.js';
import { openDb } from '../src/memory/db.js';
import { Repo } from '../src/memory/repo.js';
import { PromptBuilder } from '../src/ai/prompts.js';
import { BrainV2 } from '../src/ai/v2/brain.js';
import { Arbiter } from '../src/arbiter/arbiter.js';

// Brain v2 end to end: the real arbiter, the real v2 brain, policy, signals and linter together.
// Only the Anthropic client and WhatsApp are fakes; a throwaway DB. Checks the wiring between the
// parts (the unit tests check each part on its own).
if (process.env.DEMO_MODE === '1') throw new Error('run without DEMO_MODE');
Object.assign(ARBITER as any, { DEBOUNCE_BASE: 150, DEBOUNCE_PER_MSG: 0, DEBOUNCE_MAX: 300, SAME_SENDER_EXTRA: 0, HARD_TRIGGER_DEBOUNCE: 150, SOFT_COOLDOWN: 0 });
Object.assign(BRAIN_V2 as any, { LULL_MS: 1200, LULL_MIN_HUMAN_MSGS: 3, REACT_MIN_GAP_MS: 0 });

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forceai-e2e-'));
const repo = new Repo(openDb(path.join(dir, 'forceai.db')));
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const G = 'e2e@g.us';
repo.setBrainVersion(G, 'v2');
repo.upsertMember('a@s', 'Murad', null, Date.now());
repo.upsertMember('b@s', 'Kanan', null, Date.now());

let n = 0;
function say(who: 'a@s' | 'b@s', text: string) {
  n += 1;
  const m = { id: `id${n}`, shortId: `m${n}`, chatJid: G, senderJid: who, senderName: who === 'a@s' ? 'Murad' : 'Kanan', fromMe: false, isBot: false,
    isOwner: false, type: 'text', text, quotedId: null, mentionedJids: [], ts: Date.now(), raw: {} } as any;
  repo.insertMessage(m);
  arb.onMessage(m);
  return m;
}

// ---- fake Anthropic: answers by the schema it is asked for ----
const scores = (s: number, timing = s) => ({ relevance: s, novelty: s, humor: s, timing, fit: s });
const scene = (vibe = 'banter') => ({ topic: 'football', threads: 'Murad and Kanan', vibe, running_bit: null, bit_played_out: false });
let gateOut: any;
let planOut: any;
let criticOut: any = { reason: 'lands', verdict: 'send' };
const calls: { kind: string; text: string }[] = [];
const ai: any = {
  gatekeeperModel: 'claude-haiku-5-5', generationModel: 'claude-sonnet-5-5', utilityModel: 'claude-haiku-5-5',
  tuning: (_m: string, mt: number) => ({ max_tokens: mt, effort: 'low' }),
  recordUsage: () => undefined,
  isOverBudget: () => false,
  client: { messages: { parse: async (req: any) => {
    const schema = JSON.stringify(req.output_config.format);
    const content = req.messages[0].content;
    const text = typeof content === 'string' ? content : content[0].text;
    const kind = schema.includes('"angles"') ? 'plan' : schema.includes('"addressed"') ? 'gate' : schema.includes('"verdict"') ? 'critic' : schema.includes('"fixes"') ? 'rewrite' : 'other';
    calls.push({ kind, text });
    const out = kind === 'gate' ? gateOut : kind === 'plan' ? planOut : kind === 'critic' ? criticOut
      : kind === 'rewrite' ? { fixes: [{ index: 0, text: 'kanan said the same last season' }] } : null;
    return { usage: {}, stop_reason: 'end_turn', parsed_output: out };
  } } },
};
const plan = (actions: any[], extra: any = {}) => ({
  read: { happening: 'banter', subtext: 'bait', vibe: 'banter', sincere: false },
  angles: [{ idea: 'callback', device: 'callback' }], pick: 0, actions, note: 'n', observation: null, ...extra,
});

const sent: any[] = [];
const prompts = new PromptBuilder(repo);
const brain = new BrainV2(ai, repo, prompts);
const decisions: string[] = [];
const arb = new Arbiter(
  G, repo, ai,
  { decide: async () => { throw new Error('v1 gatekeeper must not run in a v2 group'); } } as any,
  { generate: async () => { throw new Error('v1 generator must not run here'); } } as any,
  { abortCurrentPlan: false, executePlan: async (_jid: string, actions: any[], onSent: any) => { for (const a of actions) { sent.push(a); onSent?.({ action: a }); } } } as any,
  { isOwnJid: () => false } as any,
  { onDecision: (tier: string, d: string, reason: string) => decisions.push(`${tier}:${d}:${reason}`), onAction: () => undefined, onPhase: () => undefined },
  brain,
);
const has = (tier: string, d: string) => decisions.some(x => x.startsWith(`${tier}:${d}`));
const reset = () => { sent.length = 0; calls.length = 0; decisions.length = 0; };

// 1. a strong unprompted jump-in: gate -> writer (thought seeded) -> linter fixes the dash + AI tell -> second opinion -> sent
say('a@s', 'kanan said madrid wins the league again');
say('b@s', 'they will, watch');
gateOut = { scene: scene(), addressed: false, thought: { text: 'kanan says this every season', why: 'callback' }, scores: scores(8),
  decision: 'RESPOND', react: null, reason: 'callback', address_message_ids: ['m2'], wait_ms: null };
planOut = plan([{ type: 'reply', text: 'Kanan said that last season too — as an AI I remember everything', target_message_id: 'm2' }]);
await sleep(800);
assert.ok(has('T1v2', 'RESPOND') && has('T2v2', 'SEND'), decisions.join('\n'));
assert.deepEqual(calls.map(c => c.kind), ['gate', 'plan', 'rewrite', 'critic']);
assert.ok(calls[0].text.includes('WHO IS DOING WHAT') && calls[1].text.includes('WHO IS DOING WHAT'), 'the room map reaches both stages');
assert.ok(calls[1].text.includes('YOUR INNER THOUGHT WHILE READING') && calls[1].text.includes('kanan says this every season'), 'thought reaches the writer');
assert.ok(!calls[1].text.includes('Someone talked to you'), 'a jump-in is not told it was asked');
assert.equal(sent.length, 1);
assert.equal(sent[0].type, 'reply', 'too few messages to know how this group quotes: the quote stays');
assert.equal(sent[0].text, 'kanan said the same last season');

// 2. named directly: no gate call, the writer is told it was asked, no second opinion
reset();
criticOut = { reason: 'meh', verdict: 'skip' }; // would veto if it were asked
planOut = plan([{ type: 'message', text: 'barca by two, cope' }]);
say('b@s', 'forceai who wins tonight?');
await sleep(800);
assert.ok(has('T0', 'HARD_TRIGGER'), decisions.join('\n'));
assert.deepEqual(calls.map(c => c.kind), ['plan']);
assert.ok(calls[0].text.includes('Someone talked to you'));
assert.deepEqual(sent.map(a => a.text), ['barca by two, cope']);

// 3. bad news, and the model misreads it as a joke: no laughing reaction, nothing sent
reset();
gateOut = { scene: scene('banter'), addressed: false, thought: null, scores: scores(0), decision: 'REACT',
  react: { target_message_id: 'm6', emoji: '😂' }, reason: 'funny', address_message_ids: [], wait_ms: null };
say('a@s', 'guys my grandma is in the hospital');
await sleep(800);
assert.ok(has('T1v2', 'IGNORE'), decisions.join('\n'));
assert.ok(calls[0].text.includes('may be real bad news'), 'the room check flags it to the gate');
assert.equal(sent.length, 0);

// 4. a good line at a bad moment is saved, and offered when the chat pauses
reset();
criticOut = { reason: 'lands', verdict: 'send' };
const freshG = 'e2e2@g.us'; // a second group, so the bad news above does not block the pause
repo.setBrainVersion(freshG, 'v2');
const arb2 = new Arbiter(
  freshG, repo, ai, {} as any, {} as any,
  { abortCurrentPlan: false, executePlan: async (_jid: string, actions: any[], onSent: any) => { for (const a of actions) { sent.push(a); onSent?.({ action: a }); } } } as any,
  { isOwnJid: () => false } as any,
  { onDecision: (tier: string, d: string, reason: string) => decisions.push(`${tier}:${d}:${reason}`), onAction: () => undefined, onPhase: () => undefined },
  brain,
);
gateOut = { scene: scene(), addressed: false, thought: { text: 'murad finally paid someone back', why: 'callback' }, scores: scores(8, 3),
  decision: 'IGNORE', react: null, reason: 'mid-story', address_message_ids: ['m9'], wait_ms: null };
planOut = plan([{ type: 'message', text: 'first time murad paid anyone back, frame it' }]);
for (const t of ['so i paid him back', 'all of it', 'yes really']) {
  n += 1;
  const m = { id: `id${n}`, shortId: `m${n}`, chatJid: freshG, senderJid: 'a@s', senderName: 'Murad', fromMe: false, isBot: false, isOwner: false,
    type: 'text', text: t, quotedId: null, mentionedJids: [], ts: Date.now(), raw: {} } as any;
  repo.insertMessage(m);
  arb2.onMessage(m);
}
await sleep(600);
assert.ok(has('T1v2', 'IGNORE') && brain.hasThought(freshG), decisions.join('\n'));
await sleep(BRAIN_V2.LULL_MS + 800);
assert.ok(has('T1v2', 'PAUSE'), decisions.join('\n'));
const pausePlan = calls.find(c => c.kind === 'plan')!;
assert.ok(pausePlan.text.includes('A THOUGHT YOU HAD A MOMENT AGO') && pausePlan.text.includes('murad finally paid someone back'));
assert.deepEqual(sent.map(a => a.text), ['first time murad paid anyone back, frame it']);

fs.rmSync(dir, { recursive: true, force: true });
console.log('brain v2 end to end: all checks passed');
process.exit(0);
