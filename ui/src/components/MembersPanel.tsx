import { useCallback, useEffect, useState } from 'react';
import {
  api, post, type GroupStatus, type PersonSummary, type PersonProfile,
  type StatHistoryEntry, type MemberStat, type MemberCodeStats,
} from '../api';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const STAT_META: { key: string; label: string; icon: string; hint: string }[] = [
  { key: 'mood', label: 'Mood & energy', icon: '🌤️', hint: '0 = low · 100 = upbeat' },
  { key: 'iq', label: 'Supposed IQ', icon: '🧠', hint: 'playful sharpness score' },
  { key: 'aggression', label: 'Aggression ↔ calm', icon: '🔥', hint: '0 = calm · 100 = heated' },
];

const pct = (x: number) => `${Math.round(x * 100)}%`;
const initial = (name: string) => (name.trim()[0] ?? '?').toUpperCase();

function Sparkline({ data, w = 96, h = 24 }: { data: number[]; w?: number; h?: number }) {
  if (!data.length || data.every(v => v === 0)) return <span className="muted" style={{ fontSize: 11 }}>—</span>;
  const max = Math.max(1, ...data);
  const n = data.length;
  const pts = data.map((v, i) => `${(i / Math.max(1, n - 1)) * w},${h - (v / max) * (h - 2) - 1}`).join(' ');
  return (
    <svg className="spark" width={w} height={h} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
      <polyline points={pts} fill="none" stroke="var(--accent2)" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

/** one AI-stat tile: value + lock toggle + an expandable weekly history timeline */
function StatTile({ jid, statKey, label, icon, hint, stat, onLock }: {
  jid: string; statKey: string; label: string; icon: string; hint: string;
  stat: MemberStat | undefined; onLock?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [history, setHistory] = useState<StatHistoryEntry[] | null>(null);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && history === null) {
      api<StatHistoryEntry[]>(`/api/people/${encodeURIComponent(jid)}/stat/${statKey}/history`)
        .then(setHistory).catch(() => setHistory([]));
    }
  };

  const has = stat && stat.value != null;
  return (
    <div className={`mstat ${open ? 'open' : ''}`}>
      <div className="mstat-head" onClick={toggle}>
        <span className="mstat-icon">{icon}</span>
        <div className="mstat-main">
          <div className="mstat-label">{label}</div>
          <div className="mstat-hint">{hint}</div>
        </div>
        <div className="mstat-val">{has ? Math.round(stat!.value!) : '—'}{has && stat!.label ? <span className="mstat-vlabel">{stat!.label}</span> : null}</div>
        {onLock && (
          <button
            className={`mstat-lockbtn ${stat?.locked ? 'on' : ''}`}
            title={stat?.locked ? "Locked — the weekly AI won't change it" : 'Lock this value'}
            onClick={e => { e.stopPropagation(); onLock(); }}
          >{stat?.locked ? '🔒' : '🔓'}</button>
        )}
        <span className="mstat-caret">{open ? '▾' : '▸'}</span>
      </div>
      {open && (
        <div className="mstat-body">
          {has && stat!.reason && <p className="mstat-reason">{stat!.reason}</p>}
          {history === null ? <p className="muted" style={{ fontSize: 12 }}>Loading…</p>
            : history.length === 0 ? <p className="muted" style={{ fontSize: 12 }}>No weekly history yet — builds up after Sunday reports.</p>
            : (
              <div className="mstat-timeline">
                {[...history].reverse().map((h, i) => (
                  <div key={i} className="mstat-week">
                    <div className="mstat-week-head">
                      <span className="mstat-week-date">{new Date(h.week_start).toLocaleDateString()}</span>
                      <span className="mstat-week-val">{h.value != null ? Math.round(h.value) : '—'}{h.label ? ` · ${h.label}` : ''}</span>
                    </div>
                    {h.reason && <div className="mstat-week-reason">{h.reason}</div>}
                  </div>
                ))}
              </div>
            )}
        </div>
      )}
    </div>
  );
}

function CodeStatsView({ code, replyNetwork }: { code: MemberCodeStats; replyNetwork: { jid: string; count: number; name: string }[]; }) {
  const denom = code.starts + code.contributions;
  const starterPct = denom > 0 ? code.starts / denom : 0;
  return (
    <>
      <div className="mcode-grid">
        <div className="stat"><div className="v">{code.messages_total.toLocaleString()}</div><div className="k">Messages (all-time)</div></div>
        <div className="stat"><div className="v">{code.messages_window.toLocaleString()}</div><div className="k">Last 90 days</div></div>
        <div className="stat"><div className="v">{code.top_hour != null ? `${code.top_hour}:00` : '—'}</div><div className="k">Peak hour</div></div>
        <div className="stat"><div className="v">{code.top_day != null ? DAYS[code.top_day] : '—'}</div><div className="k">Peak day</div></div>
      </div>

      <div className="mcode-row">
        <div className="mcode-label">Activity (last 14 days)</div>
        <Sparkline data={code.sparkline} w={180} h={30} />
      </div>

      <div className="mcode-row col">
        <div className="mcode-label">Conversation role <span className="muted">· {pct(starterPct)} starter</span></div>
        <div className="role-bar" title={`${code.starts} starts · ${code.contributions} contributions`}>
          <span className="role-start" style={{ width: `${starterPct * 100}%` }} />
        </div>
        <div className="role-legend"><span>🟢 starts {code.starts}</span><span>🔵 joins {code.contributions}</span></div>
      </div>

      {replyNetwork.length > 0 && (
        <div className="mcode-row col">
          <div className="mcode-label">Replies most to</div>
          <div className="reply-net">
            {replyNetwork.map(r => (
              <span key={r.jid} className="reply-chip-m">{r.name} <b>{r.count}</b></span>
            ))}
          </div>
        </div>
      )}

      <div className="mcode-grid">
        <div className="stat"><div className="v">{code.avg_len}</div><div className="k">Avg length (chars)</div></div>
        <div className="stat"><div className="v">{code.emoji_rate.toFixed(1)}</div><div className="k">Emojis / msg</div></div>
        <div className="stat"><div className="v">{pct(code.question_rate)}</div><div className="k">Questions</div></div>
      </div>
    </>
  );
}

export function MembersPanel({ version, groups }: { version: number; groups: GroupStatus[] }) {
  const [people, setPeople] = useState<PersonSummary[] | null>(null);
  const [openJid, setOpenJid] = useState<string | null>(null);
  const [profiles, setProfiles] = useState<Record<string, PersonProfile>>({});
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);

  const groupName = useCallback((jid: string) =>
    groups.find(g => g.jid === jid)?.name ?? jid.split('@')[0], [groups]);

  const reload = useCallback(async () => {
    await api<PersonSummary[]>('/api/people').then(setPeople).catch(() => undefined);
    setProfiles({}); // invalidate cached profiles; the open one refetches via the effect below
  }, []);

  useEffect(() => { void reload(); }, [reload, version]);

  // (re)fetch the open person's full profile whenever it's not cached
  useEffect(() => {
    if (openJid && !profiles[openJid]) {
      api<PersonProfile>(`/api/people/${encodeURIComponent(openJid)}`)
        .then(p => setProfiles(prev => ({ ...prev, [openJid]: p }))).catch(() => undefined);
    }
  }, [openJid, profiles]);

  const generate = async () => {
    if (busy) return;
    setBusy(true);
    setFeedback(null);
    try {
      const res = (await post('/api/people/report-now', {})) as { status: string; updated: number };
      setFeedback(
        res.status === 'ok' ? (res.updated > 0 ? `✓ Updated ${res.updated} ${res.updated === 1 ? 'dossier' : 'dossiers'}.` : '✓ Nothing to report this period.')
        : res.status === 'busy' ? 'Already running — give it a moment.'
        : res.status === 'budget' ? 'Skipped — daily budget reached.'
        : res.status === 'empty' ? 'No recent activity to analyze yet.'
        : 'Something went wrong — try again.');
      await reload();
    } catch {
      setFeedback('Something went wrong — try again.');
    } finally {
      setBusy(false);
    }
  };

  const toggleLock = async (jid: string, statKey: string, locked: boolean) => {
    const patch = (s: Record<string, MemberStat>) =>
      s[statKey] ? { ...s, [statKey]: { ...s[statKey], locked } } : s;
    setProfiles(prev => (prev[jid] ? { ...prev, [jid]: { ...prev[jid], stats: patch(prev[jid].stats) } } : prev));
    setPeople(ppl => ppl ? ppl.map(p => (p.jid === jid ? { ...p, stats: patch(p.stats) } : p)) : ppl);
    try { await post(`/api/people/${encodeURIComponent(jid)}/stat/${statKey}/lock`, { locked }); }
    catch { void reload(); }
  };

  const resetReport = async (jid: string, name: string) => {
    if (!confirm(`Reset ${name}'s dossier? Their bio + all stat history is deleted and rebuilds from scratch on the next report.`)) return;
    await fetch(`/api/people/${encodeURIComponent(jid)}/report`, { method: 'DELETE' });
    await reload();
  };

  if (people === null) return <p className="muted">Loading…</p>;

  return (
    <div className="members">
      <div className="voice-intro">
        <h3>👥 Members</h3>
        <p className="muted">
          A dossier for each person across <b>all</b> your groups — live analytics plus an AI report
          (bio, mood, sharpness, temperament) that updates every Sunday and keeps a weekly history.
          Click anyone to expand.
        </p>
      </div>

      <div className="voice-actions">
        <button disabled={busy} onClick={generate} title="Run the AI report now instead of waiting for Sunday (also does the first build)">
          {busy ? '⏳ Generating reports…' : '✨ Generate reports now'}
        </button>
        {feedback && <span className="voice-feedback">{feedback}</span>}
      </div>
      <p className="voice-actions-hint muted">
        Reports refresh automatically every Sunday morning. Generate on demand here — the first run builds everyone's dossier from your whole history.
      </p>

      {people.length === 0 && <p className="muted">No people yet — they appear here as they chat.</p>}

      <div className="member-roster">
        {people.map(p => {
          const open = openJid === p.jid;
          const prof = profiles[p.jid];
          const stats = prof?.stats ?? p.stats;
          const vibe = p.bio?.split(/(?<=[.!?])\s/)[0] ?? p.talking_style ?? (p.has_report ? null : 'Dossier builds on Sunday');
          return (
            <div key={p.jid} className={`member-card ${open ? 'open' : ''}`}>
              <div className="member-head" onClick={() => setOpenJid(open ? null : p.jid)}>
                <span className="member-avatar">{initial(p.name)}</span>
                <div className="member-id">
                  <div className="member-name">{p.name}</div>
                  <div className="member-vibe muted">{vibe}</div>
                </div>
                <div className="member-chips">
                  {STAT_META.map(s => {
                    const st = stats[s.key];
                    if (!st || st.value == null) return null;
                    return <span key={s.key} className="member-chip" title={s.label}>{s.icon} {Math.round(st.value)}</span>;
                  })}
                </div>
                {p.code && <Sparkline data={p.code.sparkline} />}
                <span className="member-caret">{open ? '▾' : '▸'}</span>
              </div>

              {open && (
                <div className="member-body">
                  <div className="member-section">
                    <div className="member-section-title">AI dossier</div>
                    {(prof?.bio ?? p.bio) ? <p className="member-bio">{prof?.bio ?? p.bio}</p>
                      : <p className="muted" style={{ fontSize: 12 }}>No report yet — hit <b>Generate reports now</b> above (or wait for Sunday). Live analytics below already track.</p>}
                    <div className="mstat-list">
                      {STAT_META.map(s => (
                        <StatTile key={s.key} jid={p.jid} statKey={s.key} label={s.label} icon={s.icon} hint={s.hint}
                          stat={stats[s.key]} onLock={() => toggleLock(p.jid, s.key, !(stats[s.key]?.locked))} />
                      ))}
                    </div>
                  </div>

                  <div className="member-section">
                    <div className="member-section-title">Live analytics <span className="muted">· no tokens</span></div>
                    {p.code ? <CodeStatsView code={prof?.code ?? p.code} replyNetwork={prof?.reply_network ?? []} />
                      : <p className="muted" style={{ fontSize: 12 }}>Not enough recent activity.</p>}
                  </div>

                  {prof && prof.groups.length > 0 && (
                    <div className="member-section">
                      <div className="member-section-title">Seen in</div>
                      <div className="reply-net">
                        {prof.groups.map(g => (
                          <span key={g.chat_jid} className="reply-chip-m">{groupName(g.chat_jid)} <b>{g.count}</b></span>
                        ))}
                      </div>
                    </div>
                  )}

                  {p.has_report && (
                    <button className="member-reset" onClick={() => resetReport(p.jid, p.name)}>Reset dossier</button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
