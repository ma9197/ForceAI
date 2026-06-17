import { useEffect, useState } from 'react';
import { api, type Member } from '../api';

export function MemoryBrowser({ jid, version }: { jid: string; version: number }) {
  const [members, setMembers] = useState<Member[]>([]);

  useEffect(() => {
    api<Member[]>(`/api/members?jid=${encodeURIComponent(jid)}`).then(setMembers).catch(() => undefined);
  }, [jid, version]);

  const deleteFact = async (id: number) => {
    await fetch(`/api/facts/${id}`, { method: 'DELETE' });
    setMembers(ms => ms.map(m => ({ ...m, facts: m.facts.filter(f => f.id !== id) })));
  };

  const known = members;

  return (
    <div>
      <div className="voice-intro">
        <h3>🧠 Memory</h3>
        <p className="muted">
          Facts ForceAI has picked up about each person <b>in this group</b> — who supports which team,
          running jokes, jobs, and so on. It uses these to make replies personal. Groups never share
          memory. Delete anything that's wrong or you'd rather it forget.
        </p>
      </div>
      {known.length === 0 && <p className="muted">Nobody learned yet — members appear here as they talk.</p>}
      {known.map(m => (
        <div key={m.jid} className="card">
          <h3>
            {m.display_name ?? m.jid.split('@')[0]}{' '}
            <span className="muted" style={{ fontWeight: 400, fontSize: 11 }}>
              {m.message_count} msgs
            </span>
          </h3>
          {m.personality_notes && <p className="muted" style={{ fontSize: 12 }}>{m.personality_notes}</p>}
          {m.facts.length === 0 ? (
            <p className="muted" style={{ fontSize: 12 }}>No facts yet.</p>
          ) : (
            m.facts.map(f => (
              <div key={f.id} className="fact">
                {f.category && <span className="cat">{f.category}</span>}
                <span style={{ flex: 1 }}>{f.fact}</span>
                <button title="Forget this fact" onClick={() => deleteFact(f.id)}>✕</button>
              </div>
            ))
          )}
        </div>
      ))}
    </div>
  );
}
