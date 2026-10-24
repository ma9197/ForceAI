import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { openDb } from '../src/memory/db.js';
import { Repo } from '../src/memory/repo.js';
import {
  anonymizeVoiceItems, backupDb, clearImages, countImages, countRows, estimateRewriteCostUsd, getKeptVoiceItems, getKnownNames, wipeMemory,
} from '../src/memory/freshStart.js';
import { createBackupArchive } from '../src/memory/backup.js';

// Fresh start on a THROWAWAY database in a temp folder (never data/forceai.db): seed every table,
// wipe, then check what stayed and what went. No AI call: the name rewrites are faked.
if (process.env.DEMO_MODE === '1') throw new Error('run without DEMO_MODE (it would open an in-memory DB)');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forceai-fresh-'));
const imagesDir = path.join(dir, 'images');
fs.mkdirSync(imagesDir);
fs.mkdirSync(path.join(dir, 'stickers'));
const db = openDb(path.join(dir, 'forceai.db'));
const repo = new Repo(db);

const G1 = 'g1@g.us', G2 = 'g2@g.us';
const MURAD = 'murad@s.whatsapp.net', KANAN = 'kanan@s.whatsapp.net';
const t0 = Date.now() - 86_400_000;

// ---- seed: one or more rows in every table ----
repo.upsertMember(MURAD, 'Murad', null, t0);
repo.upsertMember(KANAN, 'Kanan', null, t0);
repo.setMemberName(KANAN, 'Kanan');
repo.setMemberInstructions(MURAD, 'never joke about his exam');
db.prepare('INSERT INTO member_ignored(jid, created_at) VALUES(?, ?)').run('ghost@s.whatsapp.net', t0);
for (const [i, who] of [[0, MURAD], [1, KANAN]] as const) {
  repo.insertMessage({
    id: `m${i}`, shortId: `m${i + 1}`, chatJid: G1, senderJid: who, senderName: who.split('@')[0],
    fromMe: false, isBot: false, isOwner: false, type: 'text', text: 'hello', mentionedJids: [], ts: t0 + i,
    raw: { key: { id: `m${i}`, remoteJid: G1, fromMe: false } },
  } as any);
}
repo.addBotMessage('bot1', t0);
repo.insertDecision(G1, 'T1', 'RESPOND', 'test');
repo.setPollVote('poll1', MURAD, 'Murad', ['yes']);
repo.insertFact(G1, MURAD, 'Barca fan', 'preference', 0.9, null);
repo.setSummary(G1, 'Murad vs Kanan football rivalry', t0);
repo.insertMemberReport(MURAD, t0, 'bio', 'summary', 'style');
repo.insertStatSnapshot(MURAD, t0, 'mood', 70, 'upbeat', 'reason');
repo.setStatLock(MURAD, 'mood', true);
repo.insertMemberObservation(MURAD, G1, 'was tired');
repo.insertInfluenceLesson(G1, 'hype them', 'energy', null, 'ctx');
repo.insertInitiativePrinciple('stoke debates', null);

const slang = repo.insertVoiceItem(G1, 'slang', 'washed = past their prime', 'they are washed', null)!;
const joke = repo.insertVoiceItem(G1, 'joke', 'making Kanan go quiet', 'Kanan went quiet 💀', null)!;
const ref = repo.insertVoiceItem(G1, 'reference', 'the Murad car thing', null, null)!;
const ref2 = repo.insertVoiceItem(G1, 'reference', 'the car thing', null, null)!; // rewrite of ref collides with this
const oldPhrase = repo.insertVoiceItem(G1, 'phrase', 'Murad says bro bro', null, null)!;
const newPhrase = repo.insertVoiceItem(G1, 'phrase', 'bro bro', null, null)!;
repo.supersedeVoiceItem(oldPhrase, newPhrase);
const pattern = repo.insertVoiceItem(G2, 'pattern', 'mixes AZ and RU mid sentence', null, null)!;
repo.insertVoiceItem(G1, 'member_style', 'Kanan: short cocky one-liners', null, KANAN);
db.prepare('UPDATE voice_items SET member_jid = ? WHERE id = ?').run(MURAD, slang); // a stray link to a person
repo.setVoiceOverview(G1, 'loud football group led by Murad');

repo.insertSticker(path.join(dir, 'stickers', 'a.webp'), 'sha-a');
fs.writeFileSync(path.join(dir, 'stickers', 'a.webp'), 'x');
repo.bumpStat('messages_read', 5);
repo.storeLidPn('123@lid', '456@s.whatsapp.net');
const settings: Record<string, string> = {
  anthropic_api_key: 'sk-test', daily_budget_usd: '3', rate_per_min: '4', linked_group_jids: JSON.stringify([G1, G2]),
  [`paused_${G2}`]: '1', [`asleep_${G1}`]: '1', [`intro_sent_${G1}`]: '1', msg_seq: '42', clock_cities: '[]',
  persona_mode: 'savage', persona_custom: 'roast Murad', [`extract_ts_${G1}`]: String(t0), [`voice_ts_${G2}`]: String(t0),
  member_report_ts: String(t0),
};
for (const [k, v] of Object.entries(settings)) repo.setConfig(k, v);
fs.writeFileSync(path.join(imagesDir, 'm0.jpg'), 'img');
fs.writeFileSync(path.join(imagesDir, 'm1.webp'), 'img');

// ---- preview helpers ----
const kept = getKeptVoiceItems(db);
assert.deepEqual(kept.map(k => k.id).sort((a, b) => a - b), [slang, joke, ref, ref2, newPhrase, pattern].sort((a, b) => a - b));
assert.deepEqual(getKnownNames(db).sort(), ['Kanan', 'Murad']);
assert.ok(estimateRewriteCostUsd(kept) > 0 && estimateRewriteCostUsd(kept) < 0.05, 'cost estimate is cents');
assert.equal(estimateRewriteCostUsd([]), 0);
assert.equal(countImages(imagesDir), 2);

// ---- AI name pass, with a fake client: only real, known, non-empty changes come back ----
const calls: any[] = [];
const fakeAi = (answer: (ids: number[]) => any, stop = 'end_turn') => ({
  recordUsage: () => undefined,
  client: { messages: { parse: async (req: any) => {
    calls.push(req);
    const ids = [...req.messages[0].content.matchAll(/\[id (\d+)\]/g)].map((m: any) => Number(m[1]));
    return { usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: stop, parsed_output: answer(ids) };
  } } },
}) as any;
const rw = await anonymizeVoiceItems(fakeAi(() => ({ items: [
  { id: joke, content: 'making the loser go quiet', example: null },
  { id: 9999, content: 'unknown id', example: null },
  { id: slang, content: 'washed = past their prime', example: 'they are washed' }, // unchanged
  { id: ref, content: '   ', example: null }, // empty
] })), kept, ['Murad', 'Kanan']);
assert.deepEqual(rw, [{ id: joke, content: 'making the loser go quiet', example: null }]);
assert.ok(calls[0].messages[0].content.includes('- Murad'), 'names are sent as hints');
calls.length = 0;
const many = Array.from({ length: 130 }, (_, i) => ({ id: i + 1000, category: 'slang', content: `w${i}`, example: null }));
await anonymizeVoiceItems(fakeAi(() => ({ items: [] })), many, []);
assert.equal(calls.length, 3, '130 items go in 3 calls');
await assert.rejects(anonymizeVoiceItems(fakeAi(() => ({ items: [] }), 'max_tokens'), kept, []), /cut off/);
await assert.rejects(anonymizeVoiceItems(fakeAi(() => null), kept, []), /no usable answer/);

// ---- safety copy ----
const now = Date.now();
const backup = backupDb(db, dir, now);
assert.ok(fs.existsSync(backup), 'backup file exists');

// ---- wipe ----
const res = wipeMemory(db, {
  now,
  groups: [G1, G2],
  rewrites: [
    { id: joke, content: 'making the loser go quiet', example: 'he went quiet 💀' },
    { id: ref, content: 'the car thing', example: null }, // collides with ref2: dropped as duplicate
  ],
});
const removedImages = clearImages(imagesDir);
console.log('before:', res.before);
console.log('after: ', res.after);

// wiped
for (const t of ['members', 'facts', 'group_summary', 'member_reports', 'member_stat_history', 'member_stat_locks',
  'member_observations', 'member_ignored', 'influence_lessons', 'initiative_principles', 'messages', 'bot_messages',
  'decisions', 'poll_votes']) {
  assert.ok(res.before[t] > 0, `${t} was seeded`);
  assert.equal(res.after[t], 0, `${t} wiped`);
}
assert.equal(res.after.voice_member_style, 0, 'member_style wiped');
assert.equal(res.after.voice_old_versions, 0, 'old versions wiped');
assert.equal(res.after.voice_linked_to_person, 0, 'no voice item links to a person');
assert.equal(res.after.voice_overviews, 0, 'voice overview wiped');
assert.equal(repo.getConfig('persona_mode'), 'default');
assert.equal(repo.getConfig('persona_custom'), '');
assert.equal(removedImages, 2);
assert.equal(countImages(imagesDir), 0);

// kept
assert.equal(res.rewritten, 1);
assert.equal(res.merged, 1);
assert.equal(res.after.voice_kept, 5, 'slang, joke, ref2, phrase, pattern stay');
const jokeRow = db.prepare('SELECT content, example, checked FROM voice_items WHERE id = ?').get(joke) as any;
assert.deepEqual(jokeRow, { content: 'making the loser go quiet', example: 'he went quiet 💀', checked: 0 });
assert.ok(db.prepare('SELECT 1 FROM voice_items WHERE id = ?').get(slang), 'slang kept');
assert.equal(res.after.stickers, 1);
assert.ok(fs.existsSync(path.join(dir, 'stickers', 'a.webp')), 'sticker file kept');
assert.equal(res.after.stats, res.before.stats);
assert.equal(res.after.lid_pn_map, 1);
for (const [k, v] of Object.entries(settings)) {
  if (['persona_mode', 'persona_custom'].includes(k) || k.startsWith('extract_ts_') || k.startsWith('voice_ts_') || k === 'member_report_ts') continue;
  assert.equal(repo.getConfig(k), v, `${k} kept`);
}

// checkpoints at the wipe time, for existing keys and every linked group
for (const k of [`extract_ts_${G1}`, `extract_ts_${G2}`, `voice_ts_${G1}`, `voice_ts_${G2}`, 'member_report_ts', 'fresh_start_at']) {
  assert.equal(repo.getConfig(k), String(now), `${k} = wipe time`);
}

// the safety copy still holds everything
const old = openDb(backup);
assert.equal(countRows(old).members, 2, 'backup still has the people');
assert.equal(countRows(old).voice_member_style, 1);
old.close();

// ---- backup download: tar.gz in the import layout, live DB swapped for a snapshot ----
const tgz = path.join(dir, 'out.tar.gz');
await new Promise<void>((resolve, reject) => {
  const out = fs.createWriteStream(tgz);
  createBackupArchive(db, dir).pipe(out);
  out.on('finish', () => resolve());
  out.on('error', reject);
});
const listing = execFileSync('tar', ['-tzf', tgz]).toString().split('\n').filter(Boolean);
assert.ok(listing.includes('forceai.db'), 'archive has the DB at its root');
assert.ok(listing.some(n => n.startsWith('stickers/')), 'archive has stickers/');
assert.ok(!listing.some(n => n.includes('forceai.db-wal')), 'no live WAL file');
const restored = path.join(dir, 'restore');
fs.mkdirSync(restored);
execFileSync('tar', ['-xzf', tgz, '-C', restored]);
const back = openDb(path.join(restored, 'forceai.db'));
assert.equal(countRows(back).voice_kept, 5, 'restored DB matches');
back.close();

db.close();
fs.rmSync(dir, { recursive: true, force: true });
console.log('\nfresh start: all checks passed');
