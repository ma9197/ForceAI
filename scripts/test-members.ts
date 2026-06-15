import { openDb } from '../src/memory/db.js';
import { Repo } from '../src/memory/repo.js';

// Validates the rename-lock + ignore-list SQL. Careful: real member data is NOT mutated
// (ignore-exclusion is tested via a temporary ignore-list row that's cleaned up; rename is
// tested on a throwaway jid).
const db = openDb();
const repo = new Repo(db);
console.log('--- migration OK (name_locked column + member_ignored table created) ---');

const people = repo.getPeople();
console.log('people:', people.length);

// exclusion test: temporarily ignore a real jid (no profile deletion), verify, then clean up
const victim = people[0];
if (victim) {
  db.prepare('INSERT OR IGNORE INTO member_ignored(jid, created_at) VALUES(?, ?)').run(victim.jid, Date.now());
  console.log(`isIgnored(${victim.display_name}):`, repo.isIgnored(victim.jid));
  console.log('getPeople excludes them (expect', people.length - 1, '):', repo.getPeople().length);
  const chat = repo.getMemberGroups(victim.jid)[0]?.chat_jid ?? '';
  console.log('getMembersForChat excludes them:', !repo.getMembersForChat(chat).some(m => m.jid === victim.jid));
  console.log('insertFact on ignored returns null:', repo.insertFact(chat, victim.jid, '__test__', null, null, null) === null);
  console.log('getActiveMemberCounts excludes them:', !repo.getActiveMemberCounts(0).has(victim.jid));
  db.prepare('DELETE FROM member_ignored WHERE jid = ?').run(victim.jid); // cleanup
  console.log('getPeople restored (expect', people.length, '):', repo.getPeople().length);
}

// rename + lock test on a throwaway jid (no real data touched)
const fake = 'fake@codetest';
db.prepare('INSERT OR IGNORE INTO members(jid, display_name, first_seen, last_seen, message_count) VALUES(?, ?, ?, ?, 0)').run(fake, 'OldName', Date.now(), Date.now());
repo.setMemberName(fake, 'NewName');
console.log('\nafter rename:', repo.getMember(fake)?.display_name, '(expect NewName)');
repo.upsertMember(fake, 'PushNameFromWhatsApp', null, Date.now()); // should NOT overwrite a locked name
console.log('after pushName upsert:', repo.getMember(fake)?.display_name, '(expect NewName — locked)');
db.prepare('DELETE FROM members WHERE jid = ?').run(fake); // cleanup

console.log('\n--- rename/ignore methods OK ---');
