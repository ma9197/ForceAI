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
Object.assign(ARBITER as any, { DEBOUNCE_BASE: 150, DEBOUNCE_PER_MSG: 0, DEBOUNCE_MAX: 300, SAME_SENDER_EXTRA: 0 });
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
function harness(chatJid: string) {
  const sent: any[] = [];
  const fakeBrain: any = {
    gate: async () => {
      log.push(`v2gate:${chatJid}`);
      const out = { scene: { topic: 't', threads: '', vibe: 'banter', running_bit: null, bit_played_out: false }, addressed: false,
        thought: { text: 'saved line', why: '' }, scores: { relevance: 8, novelty: 8, humor: 8, timing: 3, fit: 8 },
        reason: 'r', address_message_ids: ['m1'], wait_ms: null, ...v2Gate };
      return { out, policy: { decision: v2Gate.decision, motivation: 7, threshold: 6.5, saveThought: true, why: 'test' } };
    },
    generate: async (input: any) => {
      log.push(`v2gen:${chatJid}:${input.thought ?? ''}`);
      log.push(`unprompted:${!!input.unprompted}:${input.thoughtWhen ?? ''}`);
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

fs.rmSync(dir, { recursive: true, force: true });
console.log('arbiter routing: all checks passed');
process.exit(0);
