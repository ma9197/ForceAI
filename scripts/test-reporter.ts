import { openDb } from '../src/memory/db.js';
import { Repo } from '../src/memory/repo.js';

// Exercises the reporter's input + persistence repo methods (no AI call → no tokens).
const db = openDb();
const repo = new Repo(db);

const counts = repo.getActiveMemberCounts(0);
console.log('active members (all-time):', counts.size);

for (const p of repo.getPeople().slice(0, 3)) {
  const jid = p.jid;
  console.log(`\n${p.display_name ?? jid}:`);
  console.log('  window count :', counts.get(jid) ?? 0);
  console.log('  facts        :', repo.getFactsForMember(jid).length);
  console.log('  style notes  :', repo.getMemberStyleNotes(jid).length);
  console.log('  msg sample10 :', repo.getMemberMessageSample(jid, 0, 10).length);
}

// snapshot write/read/upsert/delete roundtrip on a throwaway jid (touches no real person)
const t = 'test@codestat';
const wk = 1700000000000;
repo.insertMemberReport(t, wk, 'bio v1', 'summary', 'style');
repo.insertStatSnapshot(t, wk, 'iq', 94, 'sharp', 'baseline');
repo.insertStatSnapshot(t, wk, 'iq', 98, 'sharper', 'won the debate'); // same week+key → upsert
repo.insertStatSnapshot(t, wk + 7 * 86_400_000, 'iq', 96, 'steady', 'cooled off');
const hist = repo.getStatHistory(t, 'iq');
console.log('\niq history (expect 2 weeks → 94→98 collapsed to 98, then 96):', hist.map(h => h.value));
console.log('latest iq (expect 96):', repo.getLatestStats(t).find(s => s.stat_key === 'iq')?.value);
repo.setStatLock(t, 'iq', true);
console.log('locks after lock:', repo.getStatLocks(t));
repo.deleteMemberReport(t);
console.log('history after delete (expect 0):', repo.getStatHistory(t, 'iq').length, '· locks:', repo.getStatLocks(t).length);

console.log('\n--- reporter repo methods OK ---');
