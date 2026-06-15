import { useCallback, useEffect, useState } from 'react';
import {
  api, type GroupStatus, type PersonSummary, type PersonProfile,
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

/** tiny inline sparkline */
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

/** one AI-stat tile with an expandable weekly history timeline */
function StatTile({ jid, statKey, label, icon, hint, stat }: {
  jid: string; statKey: string; label: string; icon: string; hint: string; stat: MemberStat | undefined;
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
          <div className="mstat-label">{label}{stat?.locked && <span className="mstat-lock" title="Locked">🔒</span>}</div>
          <div className="mstat-hint">{hint}</div>
        </div>
        <div className="mstat-val">{has ? Math.round(stat!.value!) : '—'}{has && stat!.label ? <span className="mstat-vlabel">{stat!.label}</span> : null}</div>
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

  const groupName = useCallback((jid: string) =>
    groups.find(g => g.jid === jid)?.name ?? jid.split('@')[0], [groups]);

  useEffect(() => {
    api<PersonSummary[]>('/api/people').then(setPeople).catch(() => setPeople([]));
  }, [version]);

  const toggle = (jid: string) => {
    const next = openJid === jid ? null : jid;
    setOpenJid(next);
    if (next && !profiles[next]) {
      api<PersonProfile>(`/api/people/${encodeURIComponent(next)}`)
        .then(p => setProfiles(prev => ({ ...prev, [next]: p }))).catch(() => undefined);
    }
  };

  if (people === null) return <p className="muted">Loading…</p>;

  return (
    <div className="members">
      <div className="voice-intro">
        <h3>👥 Members</h3>
        <p className="muted">
          A dossier for each person across <b>all</b> your groups — live analytics now, plus an AI
          report (bio, mood, sharpness, temperament) that updates every Sunday and keeps a weekly
          history. Click anyone to expand.
        </p>
      </div>

      {people.length === 0 && <p className="muted">No people yet — they appear here as they chat.</p>}

      <div className="member-roster">
        {people.map(p => {
          const open = openJid === p.jid;
          const prof = profiles[p.jid];
          const vibe = p.bio?.split(/(?<=[.!?])\s/)[0] ?? p.talking_style ?? (p.has_report ? null : 'Dossier builds on Sunday');
          return (
            <div key={p.jid} className={`member-card ${open ? 'open' : ''}`}>
              <div className="member-head" onClick={() => toggle(p.jid)}>
                <span className="member-avatar">{initial(p.name)}</span>
                <div className="member-id">
                  <div className="member-name">{p.name}</div>
                  <div className="member-vibe muted">{vibe}</div>
                </div>
                <div className="member-chips">
                  {STAT_META.map(s => {
                    const st = p.stats[s.key];
                    if (!st || st.value == null) return null;
                    return <span key={s.key} className="member-chip" title={s.label}>{s.icon} {Math.round(st.value)}</span>;
                  })}
                </div>
                {p.code && <Sparkline data={p.code.sparkline} />}
                <span className="member-caret">{open ? '▾' : '▸'}</span>
              </div>

              {open && (
                <div className="member-body">
                  {/* AI dossier */}
                  <div className="member-section">
                    <div className="member-section-title">AI dossier</div>
                    {p.bio ? <p className="member-bio">{prof?.bio ?? p.bio}</p>
                      : <p className="muted" style={{ fontSize: 12 }}>No weekly report yet — the AI dossier (bio + mood/IQ/temperament) activates with the report job. Live analytics below are already tracking.</p>}
                    <div className="mstat-list">
                      {STAT_META.map(s => (
                        <StatTile key={s.key} jid={p.jid} statKey={s.key} label={s.label} icon={s.icon} hint={s.hint} stat={p.stats[s.key]} />
                      ))}
                    </div>
                  </div>

                  {/* live code analytics */}
                  <div className="member-section">
                    <div className="member-section-title">Live analytics <span className="muted">· no tokens</span></div>
                    {p.code ? <CodeStatsView code={prof?.code ?? p.code} replyNetwork={prof?.reply_network ?? []} />
                      : <p className="muted" style={{ fontSize: 12 }}>Not enough recent activity.</p>}
                  </div>

                  {/* groups */}
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
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
