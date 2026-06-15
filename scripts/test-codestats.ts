import { openDb } from '../src/memory/db.js';
import { Repo } from '../src/memory/repo.js';

// Validates the new member-report tables (openDb runs the CREATE statements) and the
// code-stats engine against whatever local DB exists. Safe / read-only beyond table creation.
const db = openDb();
const repo = new Repo(db);

console.log('--- schema OK (tables created without error) ---');

const people = repo.getPeople();
console.log('people (humans):', people.length);

const code = repo.computeAllCodeStats();
console.log('code-stat entries:', code.size);

for (const p of people.slice(0, 8)) {
  const c = code.get(p.jid);
  const name = p.display_name ?? p.jid.split('@')[0];
  if (!c) { console.log(`  ${name}: (no recent activity)`); continue; }
  console.log(`  ${name}: ${c.messages_window} msgs/90d · starts ${c.starts} / joins ${c.contributions} (${Math.round(c.starter_ratio * 100)}% starter) · peak ${c.top_hour}:00 ${c.top_day} · avg ${c.avg_len}ch · ${c.emoji_rate.toFixed(1)} emoji/msg · ${Math.round(c.question_rate * 100)}% Q · replies→${c.reply_network.length}`);
}

// exercise the report-read methods too (empty until phase 2, but must not throw)
if (people[0]) {
  const j = people[0].jid;
  console.log('latestReport:', repo.getLatestReport(j) ?? '(none)');
  console.log('latestStats:', repo.getLatestStats(j).length);
  console.log('groups:', repo.getMemberGroups(j));
}
console.log('--- all member-report methods ran OK ---');
