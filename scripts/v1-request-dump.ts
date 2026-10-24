// Prints a hash of everything brain v1 sends to Claude (persona, memory block, gatekeeper prompt, schemas,
// both full requests) for a fixed seeded chat on a throwaway DB. To prove a change leaves v1 untouched:
//   git worktree add /tmp/main origin/main && ln -s $PWD/node_modules /tmp/main/node_modules
//   cp scripts/v1-request-dump.ts /tmp/main/scripts/ && (cd /tmp/main && npx tsx scripts/v1-request-dump.ts /tmp/main)
//   npx tsx scripts/v1-request-dump.ts $PWD    -> the two outputs must be identical
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const root = process.argv[2];
const { openDb } = await import(`${root}/src/memory/db.ts`);
const { Repo } = await import(`${root}/src/memory/repo.ts`);
const { PromptBuilder, GATEKEEPER_SYSTEM } = await import(`${root}/src/ai/prompts.ts`);
const { Generator } = await import(`${root}/src/ai/generator.ts`);
const { Gatekeeper } = await import(`${root}/src/ai/gatekeeper.ts`);
const { zodOutputFormat } = await import('@anthropic-ai/sdk/helpers/zod');
const schemas = await import(`${root}/src/ai/schemas.ts`);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-'));
const repo = new Repo(openDb(path.join(dir, 'forceai.db')));
const G = 'g@g.us';
repo.upsertMember('a@s', 'Murad', null, 1);
repo.insertFact(G, 'a@s', 'Barca fan', 'preference', 0.9, null);
repo.insertVoiceItem(G, 'slang', 'washed = past it', null, null);
for (let i = 0; i < 20; i++) repo.insertMessage({ id: `x${i}`, shortId: `m${i}`, chatJid: G, senderJid: 'a@s', senderName: 'Murad', fromMe: false, isBot: false, isOwner: false, type: 'text', text: `msg ${i}`, mentionedJids: [], ts: 1_700_000_000_000 + i * 1000, raw: {} } as any);
const reqs: any[] = [];
const ai: any = { gatekeeperModel: 'claude-sonnet-4-6', generationModel: 'claude-sonnet-4-6', utilityModel: 'claude-sonnet-4-6', effort: 'low',
  tuning: (_m: string, mt: number) => ({ max_tokens: mt, effort: 'low' }), recordUsage: () => {},
  client: { messages: { parse: async (r: any) => { reqs.push(r); return { usage: {}, parsed_output: null }; } } } };
const prompts = new PromptBuilder(repo);
await new Gatekeeper(ai, repo, prompts).decide(G, 1_700_000_015_000, 30, false);
await new Generator(ai, repo, prompts).generate({ chatJid: G, consumedUpToTs: 1_700_000_015_000, addressIds: ['m19'], gatekeeperReason: 'x' });
const strip = (r: any) => JSON.stringify({ ...r, messages: JSON.stringify(r.messages).replace(/\d\d:\d\d \w+ \(UTC[^)]*\)|[A-Z][a-z]{2} \d+ [A-Z][a-z]{2}[^\\]*/g, '') });
const parts: Record<string, string> = {
  blockA: prompts.getBlockA(), blockB: prompts.getBlockB(G), gatekeeperSystem: GATEKEEPER_SYSTEM,
  actionSchema: JSON.stringify(zodOutputFormat(schemas.ActionPlanSchema)), gateSchema: JSON.stringify(zodOutputFormat(schemas.GateResultSchema)),
  gateRequest: strip(reqs[0]), genRequest: strip(reqs[1]),
};
for (const [k, v] of Object.entries(parts)) console.log(k.padEnd(18), crypto.createHash('sha256').update(v).digest('hex').slice(0, 16), v.length);
