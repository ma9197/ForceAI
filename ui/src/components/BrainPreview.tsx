import { useEffect, useState } from 'react';
import { api, post } from '../api';

type Preview =
  | { error: string }
  | {
    v1: { gate: string; actions: string[]; note: string };
    v2: { gate: string; thought: string | null; scene: string | null; read: string | null; angles: string[]; actions: string[]; fixes: string[] };
  };

interface Stats { spoke: number; unprompted: number; pauses: number; reacted: number; quiet: number; vetoed: number; rewrites: number; chattiness?: string }

interface ReplayPoint { ts: number; upTo: string; who: string; text: string; decision: string; why: string; urge: number; bar: number; thought: string | null; react: string | null; actual: string }
type Replay = { error: string } | { points: ReplayPoint[]; hours: number };

const DECISION_LABEL: Record<string, string> = {
  RESPOND: '💬 would speak', REACT: '😀 would react', WAIT: '⏳ would wait', IGNORE: '🤐 would stay quiet', FAILED: '✗ failed',
};

/** "Compare v1 / v2": what each brain would say right now, plus a replay of the last hours. Nothing is sent to the group. */
export function BrainPreview({ jid, onClose }: { jid: string; onClose: () => void }) {
  const [data, setData] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [stats, setStats] = useState<Stats | null>(null);
  const [replay, setReplay] = useState<Replay | null>(null);
  const [replaying, setReplaying] = useState(false);
  const [chattiness, setChattiness] = useState('default');

  useEffect(() => {
    api<Stats>(`/api/brain/stats?jid=${encodeURIComponent(jid)}`).then(s => {
      setStats(s && 'spoke' in s ? s : null);
      setChattiness(s?.chattiness ?? 'default');
    }).catch(() => setStats(null));
  }, [jid]);

  const changeChattiness = (value: string) => {
    const before = chattiness;
    setChattiness(value);
    void post('/api/brain/chattiness', { jid, value }).catch(() => setChattiness(before));
  };

  const runReplay = async () => {
    setReplaying(true);
    try {
      const res = await api<Replay & { demo?: boolean }>('/api/brain/replay', { method: 'POST', body: JSON.stringify({ jid }) });
      setReplay(res.demo ? { error: 'Not available in the demo.' } : res);
    } catch (err) {
      setReplay({ error: err instanceof Error ? err.message : String(err) });
    } finally {
      setReplaying(false);
    }
  };

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
      <label className="hint brain-chat">
        v2 chattiness in this group:{' '}
        <select value={chattiness} onChange={e => changeChattiness(e.target.value)}>
          <option value="default">Same as Settings</option>
          <option value="quiet">Quiet</option>
          <option value="balanced">Balanced</option>
          <option value="chatty">Chatty</option>
        </select>
      </label>
      <div className="brain-buttons">
        <button className="primary" disabled={busy} onClick={() => void run()}>{busy ? 'Thinking…' : data ? 'Run again' : 'Run comparison'}</button>
        <button disabled={replaying} onClick={() => void runReplay()} title="What v2 would have done at a few moments of the last hours, next to what really happened. About 6 small AI calls. Nothing is sent.">
          {replaying ? 'Replaying…' : 'Replay last hours with v2'}
        </button>
      </div>
      {replay && 'error' in replay && <div className="hint" style={{ color: 'var(--danger)' }}>✗ {replay.error}</div>}
      {replay && 'points' in replay && (
        <div className="brain-replay">
          <div className="brain-title">Replay: last {replay.hours} hours</div>
          {replay.points.map(p => (
            <div key={p.ts} className="brain-msg">
              <div className="hint">
                {new Date(p.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} #{p.upTo} {p.who}: {p.text}
              </div>
              <div>
                <b>{DECISION_LABEL[p.decision] ?? p.decision}{p.react ? ` ${p.react}` : ''}</b>
                {p.decision !== 'FAILED' && <span className="muted"> (urge {p.urge} vs bar {p.bar}; {p.why})</span>}
              </div>
              {p.thought && <div>Thought: {p.thought}</div>}
              <div className="muted">Really: {p.actual}</div>
            </div>
          ))}
        </div>
      )}
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
