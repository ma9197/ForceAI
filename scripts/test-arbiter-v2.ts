import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ARBITER, BRAIN_V2 } from '../src/config.js';
import { openDb } from '../src/memory/db.js';
import { Repo } from '../src/memory/repo.js';
import { Arbiter } from '../src/arbiter/arbiter.js';

// The arbiter routes each group to the right brain: v1 groups never touch brain v2, v2 groups use the
// v2 gatekeeper + generator, a v2 REACT sends one reaction, and a saved thought is offered at a pause.
// All fakes, short timers, a throwaway DB.
Object.assign(ARBITER as any, { DEBOUNCE_BASE: 150, DEBOUNCE_PER_MSG: 0, DEBOUNCE_MAX: 300, SAME_SENDER_EXTRA: 0, HARD_TRIGGER_DEBOUNCE: 150 });
Object.assign(BRAIN_V2 as any, { LULL_MS: 1200, LULL_MIN_HUMAN_MSGS: 3 });

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forceai-arb-'));
const repo = new Repo(openDb(path.join(dir, 'forceai.db')));
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

let n = 0;
function msg(chatJid: string, who: string, text: string) {
  n += 1;
  const m = { id: `id${n}`, shortId: `m${n}`, chatJid, senderJid: who, senderName: who, fromMe: false, isBot: false, isOwner: false,
    type: 'text', text, mentionedJids: [], ts: Date.now(), raw: {} } as any;
  repo.insertMessage(m);
  return m;
}

const log: string[] = [];
const v2Gate: any = { decision: 'IGNORE', react: null };
let gateDelay = 0;
let genDelay = 0;
let gateFail = false;
let genFail = false;
function harness(chatJid: string) {
  const sent: any[] = [];
  const fakeBrain: any = {
    gate: async (_jid: string, _upTo: number, _force: boolean, opts: any = {}) => {
      log.push(`v2gate:${chatJid}${opts.dryRun ? ':dry' : ''}`);
      if (gateDelay) await sleep(gateDelay);
      if (gateFail) return null;
      const out = { scene: { topic: 't', threads: '', vibe: 'banter', running_bit: null, bit_played_out: false }, addressed: false,
        thought: { text: 'saved line', why: '' }, scores: { relevance: 8, novelty: 8, humor: 8, timing: 3, fit: 8 },
        reason: 'r', address_message_ids: ['m1'], wait_ms: null, ...v2Gate };
      return { out, policy: { decision: v2Gate.decision, motivation: 7, threshold: 6.5, saveThought: true, why: 'test' } };
    },
    generate: async (input: any) => {
      log.push(`v2gen:${chatJid}:${input.thought ?? ''}`);
      log.push(`unprompted:${!!input.unprompted}:${input.thoughtWhen ?? ''}`);
      log.push(`ids:${(input.addressIds ?? []).join(',')}`);
      if (input.dryRun) log.push(`dry:${chatJid}:${input.shadow ? 'shadow' : ''}`);
      if (genDelay) await sleep(genDelay);
      if (genFail) return null;
      return { plan: { actions: [{ type: 'message', text: 'v2 says hi' }], note: 'v2' } };
    },
    hasThought: () => true,
    takeThought: () => ({ text: 'saved line', at: Date.now() }),
  };
  const arb = new Arbiter(
    chatJid, repo,
    { isOverBudget: () => false } as any,
    { decide: async () => { log.push(`v1gate:${chatJid}`); return { decision: 'RESPOND', reason: 'v1', address_message_ids: [], heat: 'low' }; } } as any,
    { generate: async () => { log.push(`v1gen:${chatJid}`); return { actions: [{ type: 'message', text: 'v1 says hi' }], note: 'v1' }; } } as any,
    { abortCurrentPlan: false, executePlan: async (_jid: string, actions: any[], onSent: any) => { for (const a of actions) { sent.push(a); onSent?.({ action: a }); } } } as any,
    { isOwnJid: () => false } as any,
    { onDecision: (tier: string, d: string) => log.push(`${tier}:${d}`), onAction: () => undefined, onPhase: () => undefined },
    fakeBrain,
  );
  return { arb, sent };
}

// 1. a v1 group: v1 gatekeeper + generator, brain v2 never called
const V1 = 'v1@g.us';
const one = harness(V1);
one.arb.onMessage(msg(V1, 'a', 'what a game last night'));
await sleep(700);
assert.ok(log.includes(`v1gate:${V1}`) && log.includes(`v1gen:${V1}`));
assert.ok(!log.some(l => l.startsWith('v2')), 'v1 group never touches brain v2');
assert.deepEqual(one.sent.map(a => a.text), ['v1 says hi']);

// 2. switch a group to v2: v2 gatekeeper; RESPOND runs the v2 generator
log.length = 0;
const V2 = 'v2@g.us';
repo.setBrainVersion(V2, 'v2');
const two = harness(V2);
v2Gate.decision = 'RESPOND';
two.arb.onMessage(msg(V2, 'a', 'kanan thinks madrid wins'));
await sleep(700);
assert.ok(log.includes(`v2gate:${V2}`) && log.includes(`v2gen:${V2}:saved line`), 'the inner thought seeds the reply');
assert.ok(!log.includes(`v1gate:${V2}`) && log.includes('T1v2:RESPOND') && log.includes('T2v2:SEND'));
assert.deepEqual(two.sent.map(a => a.text), ['v2 says hi']);
assert.ok(log.includes('unprompted:true:now'), 'nobody addressed it: the reply gets a second opinion');

// 3. v2 REACT: one reaction, no generator call
log.length = 0;
two.sent.length = 0;
v2Gate.decision = 'REACT';
v2Gate.react = { target_message_id: 'm9', emoji: '😂' };
two.arb.onMessage(msg(V2, 'b', 'HE MISSED AGAIN'));
await sleep(700);
assert.deepEqual(two.sent, [{ type: 'reaction', emoji: '😂', target_message_id: 'm9' }]);
assert.ok(!log.some(l => l.startsWith('v2gen')));

// 4. the saved thought is offered when the chat pauses (needs an alive chat, the bot not last)
log.length = 0;
two.sent.length = 0;
v2Gate.decision = 'IGNORE';
v2Gate.react = null;
two.arb.onMessage(msg(V2, 'c', 'anyway'));
await sleep(500);
assert.ok(log.includes('T1v2:IGNORE'));
await sleep(1500);
assert.ok(log.includes('T1v2:PAUSE'), log.join(' '));
assert.ok(log.includes(`v2gen:${V2}:saved line`), 'generator gets the saved thought');
assert.ok(log.includes('unprompted:true:pause'));

// 5. a new message cancels a pending pause
log.length = 0;
two.arb.onMessage(msg(V2, 'a', 'one more'));
await sleep(400);
two.arb.onMessage(msg(V2, 'b', 'and another'));
await sleep(900);
assert.ok(!log.includes('T1v2:PAUSE'), 'chat kept going: no pause line yet');

// 6. switching back to v1 takes effect on the next decision
log.length = 0;
repo.setBrainVersion(V2, 'v1');
await sleep(1500);
two.arb.onMessage(msg(V2, 'a', 'back to normal'));
await sleep(700);
assert.ok(log.includes(`v1gate:${V2}`) && !log.includes(`v2gate:${V2}`));

// 7. someone names the bot while the v2 gate is still thinking: answered as a direct question, not lost
log.length = 0;
const V3 = 'v3@g.us';
repo.setBrainVersion(V3, 'v2');
const three = harness(V3);
v2Gate.decision = 'IGNORE';
gateDelay = 400;
three.arb.onMessage(msg(V3, 'a', 'random chat'));
await sleep(300);
const asked = msg(V3, 'b', 'forceai who wins tonight?');
three.arb.onMessage(asked);
await sleep(1200);
gateDelay = 0;
assert.ok(log.includes('T1v2:IGNORE') && log.includes('T0:HARD_TRIGGER'), log.join(' '));
assert.ok(log.includes('unprompted:false:') && log.includes(`ids:${asked.shortId}`), 'answered as a direct question');

// 8. named mid-way through an unprompted jump-in: the regenerated reply is an answer (no second opinion veto)
log.length = 0;
v2Gate.decision = 'RESPOND';
genDelay = 400;
three.arb.onMessage(msg(V3, 'a', 'kanan thinks madrid wins'));
await sleep(350);
const mid = msg(V3, 'c', 'forceai you agree?');
three.arb.onMessage(mid);
await sleep(1500);
genDelay = 0;
assert.ok(log.includes('T2:REGEN'), log.join(' '));
const gens = log.filter(l => l.startsWith('unprompted:'));
assert.deepEqual(gens.slice(0, 2), ['unprompted:true:now', 'unprompted:false:'], log.join(' '));
assert.ok(log.some(l => l.startsWith('ids:') && l.includes(mid.shortId)));

// 9. a reaction plus a saved thought: its own reaction does not block the pause line
log.length = 0;
const V4 = 'v4@g.us';
repo.setBrainVersion(V4, 'v2');
const four = harness(V4);
v2Gate.decision = 'REACT';
v2Gate.react = { target_message_id: 'm1', emoji: '😂' };
for (const t of ['he missed', 'AGAIN', 'unreal']) four.arb.onMessage(msg(V4, 'a', t));
await sleep(600);
assert.ok(log.includes('T1v2:REACT'));
n += 1;
repo.insertMessage({ id: `id${n}`, shortId: `m${n}`, chatJid: V4, senderJid: 'me', senderName: 'ForceAI', fromMe: true, isBot: true, isOwner: false,
  type: 'reaction', text: '😂', quotedId: 'id1', mentionedJids: [], ts: Date.now(), raw: {} } as any);
await sleep(1500);
assert.ok(log.includes('T1v2:PAUSE'), log.join(' '));

// 10. bad news in the chat: the saved joke is never offered at the pause
log.length = 0;
const V5 = 'v5@g.us';
repo.setBrainVersion(V5, 'v2');
const five = harness(V5);
v2Gate.decision = 'IGNORE';
v2Gate.react = null;
for (const t of ['guys', 'my grandma is in the hospital', 'they say she will be ok']) five.arb.onMessage(msg(V5, 'a', t));
await sleep(2000);
assert.ok(log.includes('T1v2:IGNORE') && !log.includes('T1v2:PAUSE'), log.join(' '));

// 11. safety net: v2 failing 3 times in a row puts the group on v1 for a while
log.length = 0;
const V6 = 'v6@g.us';
repo.setBrainVersion(V6, 'v2');
const six = harness(V6);
gateFail = true;
for (let i = 0; i < 3; i++) {
  six.arb.onMessage(msg(V6, 'a', `line ${i}`));
  await sleep(500);
}
gateFail = false;
assert.ok(log.includes('T0:BRAIN_FALLBACK'), log.join(' '));
assert.ok(six.arb.v2FallbackUntilTs && six.arb.v2FallbackUntilTs > Date.now());
six.arb.onMessage(msg(V6, 'a', 'hello again'));
await sleep(600);
assert.ok(log.includes(`v1gate:${V6}`) && log.includes(`v1gen:${V6}`), 'falls back to v1');

// 12. asked, and v2 cannot write the answer: v1 answers instead of silence
log.length = 0;
const V7 = 'v7@g.us';
repo.setBrainVersion(V7, 'v2');
const seven = harness(V7);
genFail = true;
seven.arb.onMessage(msg(V7, 'a', 'forceai you there?'));
await sleep(600);
genFail = false;
assert.ok(log.includes('T0:HARD_TRIGGER') && log.some(l => l.startsWith(`v2gen:${V7}`)) && log.includes(`v1gen:${V7}`), log.join(' '));
assert.deepEqual(seven.sent.map(a => a.text), ['v1 says hi']);

// 13. a working gate must not hide a writer that always fails: the writer has its own count
log.length = 0;
const V8 = 'v8@g.us';
repo.setBrainVersion(V8, 'v2');
const eight = harness(V8);
v2Gate.decision = 'RESPOND';
genFail = true;
for (let i = 0; i < 3; i++) {
  eight.arb.onMessage(msg(V8, 'a', `take ${i}`));
  await sleep(500);
}
genFail = false;
assert.equal(log.filter(l => l === `v2gate:${V8}`).length, 3, 'the gate worked every time');
assert.ok(log.includes('T0:BRAIN_FALLBACK'), log.join(' '));
assert.ok(!log.includes(`v1gen:${V8}`), 'jump-ins that fail are not handed to v1');
eight.arb.resetBrainFallback();
assert.equal(eight.arb.v2FallbackUntilTs, null, 'switching brains retries v2 right away');

// 14. an owner instruction picked up by a v2 jump-in, and the writer fails: v1 carries it out
log.length = 0;
const V9 = 'v9@g.us';
repo.setBrainVersion(V9, 'v2');
const nine = harness(V9);
v2Gate.decision = 'RESPOND';
gateDelay = 400;
genFail = true;
nine.arb.onMessage(msg(V9, 'a', 'kanan is on one today'));
await sleep(300);
nine.arb.forceGenerate('roast kanan', 'ADMIN');
await sleep(900);
gateDelay = 0;
genFail = false;
assert.ok(log.includes('T1v2:RESPOND') && log.includes('unprompted:true:now') && log.includes(`v1gen:${V9}`), log.join(' '));
assert.deepEqual(nine.sent.map(a => a.text), ['v1 says hi']);

// 15. shadow mode: v1 answers as always; v2 only thinks along (dry run) and logs what it would do
log.length = 0;
const VS = 'vs@g.us';
repo.setBrainVersion(VS, 'shadow');
assert.equal(repo.getBrainVersion(VS), 'v1', 'shadow groups run on v1');
assert.equal(repo.getBrainMode(VS), 'shadow');
const shadow = harness(VS);
v2Gate.decision = 'RESPOND';
gateDelay = 600; // a slow shadow call must not hold up v1
shadow.arb.onMessage(msg(VS, 'a', 'who is watching tonight'));
await sleep(450);
assert.ok(log.includes(`v1gate:${VS}`) && log.includes(`v1gen:${VS}`), 'v1 answered without waiting for the shadow');
assert.deepEqual(shadow.sent.map(a => a.text), ['v1 says hi']);
assert.equal(shadow.arb.working, true, 'a shadow call still in flight counts as working (fresh start waits)');
await sleep(600);
assert.equal(shadow.arb.working, false);
gateDelay = 0;
assert.ok(log.includes(`v2gate:${VS}:dry`), 'v2 thinks as a dry run');
assert.ok(log.includes('S1v2:RESPOND'), log.join(' '));
assert.ok(log.includes(`dry:${VS}:shadow`) && log.includes('S2v2:WOULD_SAY'), 'it would speak: it writes the line, as a dry run');
assert.deepEqual(shadow.sent.map(a => a.text), ['v1 says hi'], 'and never sends it');
repo.setConfig('v2_shadow_lines', '0');
log.length = 0;
shadow.arb.onMessage(msg(VS, 'b', 'another one'));
await sleep(700);
assert.ok(log.includes('S1v2:RESPOND') && !log.includes('S2v2:WOULD_SAY'), 'setting off: decisions only');
repo.setConfig('v2_shadow_lines', '1');
repo.setBrainVersion(VS, 'v1');
log.length = 0;
shadow.arb.onMessage(msg(VS, 'a', 'back to plain v1'));
await sleep(600);
assert.ok(!log.some(l => l.startsWith(`v2gate:${VS}`)), 'plain v1: no shadow calls');

fs.rmSync(dir, { recursive: true, force: true });
console.log('arbiter routing: all checks passed');
process.exit(0);
