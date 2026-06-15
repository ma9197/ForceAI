import { useEffect, useState } from 'react';
import { api, post } from '../api';

interface InitiativeData {
  principles: { id: number; content: string; example: string | null }[];
  pending: number;
  enabled: boolean;
}

/** Review + curate the bot's learned "initiative principles" (distilled from flagged Influences). */
export function InitiativePrinciples() {
  const [data, setData] = useState<InitiativeData | null>(null);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);

  const load = () => api<InitiativeData>('/api/initiative').then(setData).catch(() => undefined);
  useEffect(() => { void load(); }, []);

  const distill = async () => {
    if (busy) return;
    setBusy(true);
    setFeedback(null);
    try {
      const res = (await post('/api/initiative/distill', {})) as { status: string; learned: number };
      setFeedback(
        res.status === 'ok' ? (res.learned > 0 ? `✓ Learned ${res.learned} new ${res.learned === 1 ? 'principle' : 'principles'}.` : '✓ Nothing new to distill.')
        : res.status === 'empty' ? 'No flagged moves to distill yet.'
        : res.status === 'busy' ? 'Already running — give it a moment.'
        : res.status === 'budget' ? 'Skipped — daily budget reached.'
        : 'Something went wrong — try again.');
      await load();
    } catch {
      setFeedback('Something went wrong — try again.');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: number) => {
    await fetch(`/api/initiative/${id}`, { method: 'DELETE' });
    setData(d => (d ? { ...d, principles: d.principles.filter(p => p.id !== id) } : d));
  };

  if (!data) return null;
  return (
    <div className="initiative-panel">
      <div className="voice-actions">
        <button disabled={busy} onClick={distill} title="Turn your flagged 'Teach this move' Influences into reusable principles">
          {busy ? '⏳ Distilling…' : `✨ Distill now${data.pending ? ` (${data.pending} flagged)` : ''}`}
        </button>
        {feedback && <span className="voice-feedback">{feedback}</span>}
      </div>
      {data.principles.length === 0 ? (
        <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>
          No principles yet — flag good Influence moves with <b>"Teach this move"</b>, then distill them here.
        </p>
      ) : (
        <div className="initiative-list">
          {data.principles.map(p => (
            <div key={p.id} className="initiative-item">
              <span style={{ flex: 1 }}>{p.content}{p.example ? <span className="muted"> — e.g. {p.example}</span> : null}</span>
              <button title="Delete this principle" onClick={() => remove(p.id)}>✕</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
