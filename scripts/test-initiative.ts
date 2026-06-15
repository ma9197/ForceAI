import { openDb } from '../src/memory/db.js';
import { Repo } from '../src/memory/repo.js';

// Validates the influence_lessons + initiative_principles SQL (no AI call → no tokens).
const db = openDb();
const repo = new Repo(db);
console.log('--- migration OK (influence_lessons + initiative_principles created) ---');

const before = repo.countUndistilledLessons();
repo.insertInfluenceLesson('x@g.us', 'drop a joke', 'convo went flat', null, 'm1 ali: ...\nm2 veli: ...');
repo.insertInfluenceLesson('x@g.us', '', 'he said goodnight, send warmth', 'goodnight everyone', 'm3 josef: goodnight');
console.log('undistilled (expect', before + 2, '):', repo.countUndistilledLessons());
const lessons = repo.getUndistilledLessons();
console.log('getUndistilledLessons returns rows:', lessons.length >= 2, '— sample why:', lessons.at(-1)?.why);

// principles: insert + dedup + supersede + active query + delete
const id1 = repo.insertInitiativePrinciple('When the chat goes flat, inject energy or switch topic.', null);
const dup = repo.insertInitiativePrinciple('When the chat goes flat, inject energy or switch topic.', null);
console.log('dedup on identical content (expect a number then null):', id1, dup);
const id2 = repo.insertInitiativePrinciple('When someone shares an emotional moment, respond with warmth.', 'a goodnight, a milestone');
if (id1) repo.supersedeInitiativePrinciple(id1, id2!);
const active = repo.getActiveInitiativePrinciples();
console.log('active principles after supersede (expect 1 — the superseded one is hidden):', active.length, active.map(p => p.content));

// mark lessons distilled, confirm they leave the queue
repo.markLessonsDistilled(lessons.map(l => l.id));
console.log('undistilled after mark (expect', before, '):', repo.countUndistilledLessons());

// cleanup the test principles
for (const p of repo.getActiveInitiativePrinciples()) if (p.content.startsWith('When ')) repo.deleteInitiativePrinciple(p.id);
if (id1) repo.deleteInitiativePrinciple(id1);
console.log('\n--- initiative repo methods OK ---');
