import { useEffect, useState } from 'react';
import { api } from '../api';

interface Job { state: 'idle' | 'running' | 'done' | 'error'; step: string; message: string | null }

interface Preview {
  demo: boolean;
  running: boolean;
  job: Job;
  blocked: string | null;
  counts: Record<string, number>;
  images: number;
  rewrite_cost_usd: number;
  last_fresh_start: number | null;
  backup_downloaded_at: number | null;
  backup_fresh: boolean;
  confirm_phrase: string;
}

type Phase = 'idle' | 'open' | 'working' | 'done';

/** Pull the server's { error } text out of api()'s "409 {...}" message. */
function errorText(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  try {
    return JSON.parse(msg.slice(msg.indexOf(' ') + 1)).error ?? msg;
  } catch {
    return msg;
  }
}

const n = (v: number | undefined) => (v ?? 0).toLocaleString();

/** Settings section: download a full backup, and the owner-only fresh start (forget people, keep the voice). */
export function FreshStart() {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [typed, setTyped] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<string | null>(null);

  const load = () => api<Preview>('/api/admin/fresh-start').then((p) => { setPreview(p); return p; }).catch(() => null);
  useEffect(() => { void load(); }, []);

  // the job runs on the server; follow it until it is done, failed, or the bot has restarted
  useEffect(() => {
    if (phase !== 'working') return;
    let sawRestart = false;
    const timer = setInterval(async () => {
      const p = await load();
      if (!p) { sawRestart = true; return; } // server restarting after the wipe
      if (p.job.state === 'done') { setSummary(p.job.message); setPhase('done'); }
      else if (p.job.state === 'error') { setError(p.job.message); setPhase('open'); }
      else if (sawRestart && p.job.state === 'idle') { setPhase('done'); } // came back after the restart
    }, 3000);
    return () => clearInterval(timer);
  }, [phase]);

  // the server notes a finished download; re-check a few times so Fresh start unlocks by itself
  const download = () => {
    window.location.assign('/api/admin/export');
    for (const ms of [4000, 10_000, 25_000, 60_000]) setTimeout(() => void load(), ms);
  };

  if (!preview) return null;
  const c = preview.counts;
  const unavailable = preview.demo ? 'Not available in the demo.' : preview.blocked;
  const phraseOk = typed.trim().toUpperCase() === preview.confirm_phrase;
  const cost = preview.rewrite_cost_usd < 0.01 ? 'less than 1 cent' : `about $${preview.rewrite_cost_usd.toFixed(2)}`;

  const run = async () => {
    setPhase('working');
    setError(null);
    try {
      const res = await api<{ demo?: boolean }>(
        '/api/admin/fresh-start',
        { method: 'POST', body: JSON.stringify({ confirm: typed }) },
      );
      if (res.demo) { setPhase('open'); setError('Not available in the demo.'); return; }
      void load(); // progress is followed by the effect above
    } catch (err) {
      setError(errorText(err));
      setPhase('open');
      void load();
    }
  };

  return (
    <>
      <h3 style={{ margin: '18px 0 4px' }}>Backup &amp; fresh start</h3>

      <div className="settings-row">
        <div>
          <label>Download backup</label>
          <div className="hint">
            Saves everything to your PC as one file: memory, stickers, settings, WhatsApp login and API keys.
            <b style={{ color: 'var(--warn)' }}> Keep it private.</b> Never share it or put it on GitHub.
            {preview.backup_downloaded_at && <> Last download: {new Date(preview.backup_downloaded_at).toLocaleString()}.</>}
            {unavailable && <><br /><span style={{ color: 'var(--warn)' }}>{unavailable}</span></>}
          </div>
        </div>
        <button disabled={!!unavailable} onClick={download}>⬇ Download</button>
      </div>

      <div className="settings-row">
        <div>
          <label>Fresh start</label>
          <div className="hint">
            ForceAI forgets the people, its attitude and the old chats. It keeps the group's slang, jokes,
            stickers and all settings.
            {preview.last_fresh_start && <> Last fresh start: {new Date(preview.last_fresh_start).toLocaleString()}.</>}
            {phase === 'idle' && preview.job.state === 'running' && (
              <><br /><span style={{ color: 'var(--warn)' }}>Running now: {preview.job.step}…</span></>
            )}
            {phase === 'idle' && preview.job.state === 'error' && preview.job.message && (
              <><br /><span style={{ color: 'var(--danger)' }}>Last try failed: {preview.job.message}</span></>
            )}
            {!unavailable && !preview.backup_fresh && (
              <><br /><span style={{ color: 'var(--warn)' }}>Download a backup first. Fresh start unlocks for 24 hours after a download.</span></>
            )}
          </div>
        </div>
        {phase === 'idle' && (
          <button className="danger" disabled={!!unavailable || preview.running || !preview.backup_fresh} onClick={() => setPhase('open')}>
            Fresh start…
          </button>
        )}
      </div>

      {phase !== 'idle' && (
        <div className="settings-row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8, borderColor: 'var(--danger)' }}>
          {phase === 'done' ? (
            <>
              <label style={{ color: 'var(--accent)' }}>✓ Done. ForceAI is restarting.</label>
              <div className="hint">{summary} Reload this page in about a minute.</div>
              <div><button onClick={() => window.location.reload()}>↻ Reload</button></div>
            </>
          ) : (
            <>
              <div className="hint">
                <b style={{ color: 'var(--text)' }}>Keeps</b>
                <ul style={{ margin: '4px 0 8px', paddingLeft: 18 }}>
                  <li>Slang, phrases, jokes, references, patterns: {n(c.voice_kept)}. The AI removes names from them first ({cost}).</li>
                  <li>Stickers: {n(c.stickers)}.</li>
                  <li>All settings, linked groups, sleep and pause, stats. No new intro message.</li>
                </ul>
                <b style={{ color: 'var(--text)' }}>Wipes</b>
                <ul style={{ margin: '4px 0 8px', paddingLeft: 18 }}>
                  <li>People: {n(c.members)} (names, boundaries, reports, stats, notes).</li>
                  <li>How each friend texts: {n(c.voice_member_style)}. The group voice overview.</li>
                  <li>Facts: {n(c.facts)}. Group summaries: {n(c.group_summary)}.</li>
                  <li>Learned moves: {n((c.influence_lessons ?? 0) + (c.initiative_principles ?? 0))}. Mood goes back to Default.</li>
                  <li>Old messages: {n(c.messages)}. Chat images: {n(preview.images)}. The decision log.</li>
                </ul>
                Your backup is downloaded. A second safety copy of the database also stays on the server.
                The bot restarts and is offline for about a minute. Items the AI changed show as new in the Voice tab, so you can check them.
              </div>
              {error && <div className="hint" style={{ color: 'var(--danger)' }}>✗ {error}</div>}
              {phase === 'working' && (
                <div className="hint" style={{ color: 'var(--warn)' }}>
                  {preview.job.state === 'running' ? `${preview.job.step}…` : 'Restarting…'} This can take a few minutes. You can leave this page open.
                </div>
              )}
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <input
                  value={typed}
                  placeholder={`Type ${preview.confirm_phrase}`}
                  disabled={phase === 'working'}
                  onChange={e => setTyped(e.target.value)}
                  style={{ width: 170 }}
                />
                <button className="danger" disabled={!phraseOk || phase === 'working'} onClick={() => void run()}>
                  {phase === 'working' ? 'Working…' : 'Wipe now'}
                </button>
                <button disabled={phase === 'working'} onClick={() => { setPhase('idle'); setTyped(''); setError(null); }}>Cancel</button>
              </div>
            </>
          )}
        </div>
      )}
    </>
  );
}
