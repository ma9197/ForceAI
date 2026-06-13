import { useEffect, useState } from 'react';
import { api, post, type GroupInfo } from '../api';

interface Props {
  connected: boolean;
  hasGroups: boolean;
  onDone?: () => void;
}

export function GroupPicker({ connected, hasGroups, onDone }: Props) {
  const [groups, setGroups] = useState<GroupInfo[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState('');

  const load = () => {
    api<GroupInfo[]>('/api/groups').then(setGroups).catch(() => setGroups([]));
  };

  useEffect(() => {
    if (connected) load();
  }, [connected]);

  const pick = async (g: GroupInfo) => {
    if (busy || g.linked) return;
    setBusy(true);
    try {
      await post('/api/group', { jid: g.jid });
      onDone?.();
    } finally {
      setBusy(false);
    }
  };

  const shown = (groups ?? []).filter(g => g.subject.toLowerCase().includes(filter.toLowerCase()));

  return (
    <div className="center-screen">
      <h2>{hasGroups ? 'Add a group' : 'Pick the first group'}</h2>
      <p className="muted" style={{ maxWidth: 520, textAlign: 'center' }}>
        ForceAI runs in every linked group simultaneously — each gets its own tab, its own memory,
        and its own stats. Groups never share what they learn. The intro message is sent the first
        time a group is linked.
      </p>
      {!connected ? (
        <p className="muted">Waiting for WhatsApp connection…</p>
      ) : groups === null ? (
        <p className="muted">Loading groups…</p>
      ) : (
        <>
          <input placeholder="Search groups…" value={filter} onChange={e => setFilter(e.target.value)} style={{ width: 480 }} />
          <div className="group-list">
            {shown.map(g => (
              <div
                key={g.jid}
                className="group-item"
                style={g.linked ? { opacity: 0.5, cursor: 'default' } : undefined}
                onClick={() => pick(g)}
              >
                <div style={{ fontWeight: 600 }}>
                  {g.subject}
                  {g.linked && <span style={{ color: 'var(--accent)', marginLeft: 8, fontSize: 11 }}>● linked</span>}
                </div>
                <div className="grow" />
                <div className="muted">{g.size} members</div>
              </div>
            ))}
            {shown.length === 0 && <p className="muted">No groups found.</p>}
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <button onClick={load}>Refresh</button>
            {hasGroups && <button onClick={() => onDone?.()}>Cancel</button>}
          </div>
        </>
      )}
    </div>
  );
}
