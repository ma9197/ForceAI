import { useEffect, useState } from 'react';
import { api } from '../api';

type Preview =
  | { error: string }
  | {
    v1: { gate: string; actions: string[]; note: string };
    v2: { gate: string; thought: string | null; scene: string | null; read: string | null; angles: string[]; actions: string[]; fixes: string[] };
  };

/** "Compare v1 / v2": what each brain would say right now. Nothing is sent to the group. */
interface Stats { spoke: number; unprompted: number; pauses: number; reacted: number; quiet: number; vetoed: number; rewrites: number }

export function BrainPreview({ jid, onClose }: { jid: string; onClose: () => void }) {
  const [data, setData] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [stats, setStats] = useState<Stats | null>(null);

  useEffect(() => {
    api<Stats>(`/api/brain/stats?jid=${encodeURIComponent(jid)}`).then(s => setStats(s && 'spoke' in s ? s : null)).catch(() => setStats(null));
  }, [jid]);

  const run = async () => {
    setBusy(true);
    try {
      const res = await api<Preview & { demo?: boolean }>('/api/brain/preview', { method: 'POST', body: JSON.stringify({ jid }) });
      setData(res.demo ? { error: 'Not available in the demo.' } : res);
    } catch (err) {
      setData({ error: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="brain-preview">
      <div className="brain-preview-head">
        <b>Compare brains</b>
        <span className="muted">What v1 and v2 would send right now to the latest messages. Nothing is sent. About 4 small AI calls.</span>
        <span className="gclose" onClick={onClose}>✕</span>
      </div>
      {stats && (stats.spoke + stats.reacted + stats.quiet + stats.pauses) > 0 && (
        <div className="hint">
          v2 in this group, last 24 hours: spoke {stats.spoke} times ({stats.unprompted} unprompted, {stats.pauses} at a pause),
          reacted {stats.reacted}, stayed quiet {stats.quiet}. Second opinion said skip {stats.vetoed}, rewrote {stats.rewrites}.
        </div>
      )}
      <button className="primary" disabled={busy} onClick={() => void run()}>{busy ? 'Thinking…' : data ? 'Run again' : 'Run comparison'}</button>
      {data && 'error' in data && <div className="hint" style={{ color: 'var(--danger)' }}>✗ {data.error}</div>}
      {data && !('error' in data) && (
        <div className="brain-cols">
          <div className="brain-col">
            <div className="brain-title">Brain v1</div>
            <div className="hint">Would decide: {data.v1.gate}</div>
            {data.v1.actions.map((a, i) => <div key={i} className="brain-msg">{a}</div>)}
            {data.v1.note && <div className="hint">{data.v1.note}</div>}
          </div>
          <div className="brain-col">
            <div className="brain-title">Brain v2</div>
            <div className="hint">Would decide: {data.v2.gate}</div>
            {data.v2.scene && <div className="hint">Scene: {data.v2.scene}</div>}
            {data.v2.thought && <div className="hint">Inner thought: {data.v2.thought}</div>}
            {data.v2.read && <div className="hint">Read: {data.v2.read}</div>}
            {data.v2.actions.map((a, i) => <div key={i} className="brain-msg">{a}</div>)}
            {data.v2.angles.length > 0 && <div className="hint">Angles: {data.v2.angles.join(' | ')}</div>}
            {data.v2.fixes.length > 0 && <div className="hint">Fixed: {data.v2.fixes.join('; ')}</div>}
          </div>
        </div>
      )}
    </div>
  );
}
