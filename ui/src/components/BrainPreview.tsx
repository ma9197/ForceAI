import { useEffect, useState } from 'react';
import { api, post } from '../api';

type Preview =
  | { error: string }
  | {
    v1: { gate: string; actions: string[]; note: string };
    v2: { gate: string; thought: string | null; scene: string | null; read: string | null; angles: string[]; actions: string[]; fixes: string[] };
  };

interface Ab { v1: number; v2: number; tie: number }
interface Stats {
  spoke: number; unprompted: number; pauses: number; reacted: number; quiet: number; vetoed: number; rewrites: number; chattiness?: string;
  shadow?: { spoke: number; reacted: number; quiet: number; waited: number; wrote?: number }; v1Spoke?: number; ab?: Ab;
}
interface Taste { rules: string[]; at: number | null; newRatings: number; every: number }
/** Blind test: the two answers shown as A and B; `flip` = A is v2. Revealed after the owner picks. */
interface Blind { flip: boolean; picked: 'A' | 'B' | 'tie' | null }

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
  const [blind, setBlind] = useState<Blind | null>(null);
  const [taste, setTaste] = useState<Taste | null>(null);
  const [tasteBusy, setTasteBusy] = useState(false);
  const [tasteError, setTasteError] = useState<string | null>(null);

  useEffect(() => {
    api<Stats>(`/api/brain/stats?jid=${encodeURIComponent(jid)}`).then(s => {
      setStats(s && 'spoke' in s ? s : null);
      setChattiness(s?.chattiness ?? 'default');
    }).catch(() => setStats(null));
  }, [jid]);

  useEffect(() => {
    api<Taste>(`/api/brain/taste?jid=${encodeURIComponent(jid)}`).then(t => setTaste(t && Array.isArray(t.rules) ? t : null)).catch(() => setTaste(null));
  }, [jid]);

  const tasteAction = async (action: 'learn' | 'clear') => {
    setTasteBusy(true);
    setTasteError(null);
    try {
      const res = await api<Taste & { error?: string; demo?: boolean }>('/api/brain/taste', { method: 'POST', body: JSON.stringify({ jid, action }) });
      if (res.demo) setTasteError('Not available in the demo.');
      else if (res.error) setTasteError(res.error);
      else setTaste(res);
    } catch (err) {
      setTasteError(err instanceof Error ? err.message : String(err));
    } finally {
      setTasteBusy(false);
    }
  };

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

  const run = async (blindTest = false) => {
    setBusy(true);
    setData(null); // never show (or vote on) the previous answers while the new ones load
    setBlind(blindTest ? { flip: Math.random() < 0.5, picked: null } : null);
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
      {stats?.shadow && (stats.shadow.spoke + stats.shadow.reacted + stats.shadow.quiet + stats.shadow.waited) > 0 && (
        <div className="hint">
          v2 shadow, last 24 hours: would have spoken {stats.shadow.spoke} times{stats.shadow.wrote ? ` (its lines are in the feed: ${stats.shadow.wrote})` : ''}, reacted {stats.shadow.reacted}, stayed quiet {stats.shadow.quiet}.
          In the same moments v1 chose to speak {stats.v1Spoke ?? 0} times.
        </div>
      )}
      {taste && (
        <div className="hint">
          {taste.rules.length > 0 ? (
            <>
              <div>House rules v2 learned from your ratings here:</div>
              {taste.rules.map((r, i) => <div key={i}>- {r}</div>)}
            </>
          ) : (
            <div>No house rules yet. Tap 👍 or 👎 on v2's lines and decisions; every {taste.every} ratings it learns a few rules for this group.</div>
          )}
          <div className="brain-buttons" style={{ marginTop: 4 }}>
            <button disabled={tasteBusy} onClick={() => void tasteAction('learn')} title="One small AI call: turns your latest ratings in this group into a few house rules">
              {tasteBusy ? 'Learning…' : `Learn from my ratings now${taste.newRatings ? ` (${taste.newRatings} new)` : ''}`}
            </button>
            {taste.rules.length > 0 && <button disabled={tasteBusy} onClick={() => void tasteAction('clear')}>Clear rules</button>}
          </div>
          {tasteError && <div style={{ color: 'var(--danger)' }}>✗ {tasteError}</div>}
        </div>
      )}
      {stats?.ab && (stats.ab.v1 + stats.ab.v2 + stats.ab.tie) > 0 && (
        <div className="hint">Blind tests in this group: v2 won {stats.ab.v2}, v1 won {stats.ab.v1}, same {stats.ab.tie}.</div>
      )}
      <div className="brain-buttons">
        <button className="primary" disabled={busy} onClick={() => void run()}>{busy && !blind ? 'Thinking…' : data && !blind ? 'Run again' : 'Run comparison'}</button>
        <button disabled={busy} onClick={() => void run(true)} title="Both brains answer, shown as A and B without saying which is which. You pick the better one; the tally shows which brain wins. About 4 small AI calls.">
          {busy && blind ? 'Thinking…' : 'Blind test'}
        </button>
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
      {data && !('error' in data) && blind && blind.picked === null && [...data.v1.actions, ...data.v2.actions].some(a => a.includes('(generation failed)')) && (
        <div className="hint" style={{ color: 'var(--danger)' }}>✗ One brain failed this time, so there is nothing fair to pick. Run the blind test again.</div>
      )}
      {data && !('error' in data) && blind && blind.picked === null && ![...data.v1.actions, ...data.v2.actions].some(a => a.includes('(generation failed)')) && (
        <div className="brain-replay">
          <div className="brain-title">Which would you rather see in the chat?</div>
          <div className="brain-cols">
            {(['A', 'B'] as const).map(side => {
              const v2side = (side === 'A') === blind.flip;
              const lines = v2side ? data.v2.actions : data.v1.actions;
              return (
                <div key={side} className="brain-col">
                  <div className="brain-title">Option {side}</div>
                  {lines.map((a, i) => <div key={i} className="brain-msg">{a}</div>)}
                </div>
              );
            })}
          </div>
          <div className="brain-ab-pick">
            {(['A', 'B', 'tie'] as const).map(pick => (
              <button key={pick} disabled={busy} onClick={() => {
                const winner = pick === 'tie' ? 'tie' : (pick === 'A') === blind.flip ? 'v2' : 'v1';
                setBlind({ ...blind, picked: pick });
                void api<{ ok: boolean; ab?: Ab }>('/api/brain/ab', { method: 'POST', body: JSON.stringify({ jid, winner }) })
                  .then(res => { if (res.ab && stats) setStats({ ...stats, ab: res.ab }); })
                  .catch(() => undefined);
              }}>{pick === 'tie' ? 'Same' : `${pick} is better`}</button>
            ))}
          </div>
        </div>
      )}
      {data && !('error' in data) && blind && blind.picked !== null && (
        <div className="hint">
          You picked {blind.picked === 'tie' ? 'same' : `${blind.picked} (= brain ${(blind.picked === 'A') === blind.flip ? 'v2' : 'v1'})`}. A was brain {blind.flip ? 'v2' : 'v1'}.
        </div>
      )}
      {data && !('error' in data) && (!blind || blind.picked !== null) && (
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
