import { useCallback, useEffect, useState } from 'react';
import { api, post, type Status } from './api';
import { useWs, type WsEvent } from './useWs';
import { QrLogin } from './components/QrLogin';
import { GroupPicker } from './components/GroupPicker';
import { LiveFeed, type FeedItem, type ReplyTarget } from './components/LiveFeed';
import { MemoryBrowser } from './components/MemoryBrowser';
import { VoiceProfilePanel } from './components/VoiceProfilePanel';
import { StickerGrid } from './components/StickerGrid';
import { StatsPanel } from './components/StatsPanel';
import { SettingsPanel } from './components/SettingsPanel';

type Tab = 'memory' | 'voice' | 'stickers' | 'stats' | 'settings';

export default function App() {
  const [status, setStatus] = useState<Status | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [tab, setTab] = useState<Tab>('memory');
  const [influence, setInfluence] = useState('');
  const [memoryVersion, setMemoryVersion] = useState(0);
  const [showPicker, setShowPicker] = useState(false);
  const [selectedJid, setSelectedJid] = useState<string | null>(null);
  const [replyTarget, setReplyTarget] = useState<ReplyTarget | null>(null);
  const [mobileView, setMobileView] = useState<'chat' | 'side'>('chat'); // mobile: chat vs side panel

  const refreshStatus = useCallback(() => {
    api<Status>('/api/status').then(setStatus).catch(() => undefined);
  }, []);

  useEffect(() => { refreshStatus(); }, [refreshStatus]);

  // keep a valid tab selected as groups come and go
  useEffect(() => {
    const jids = status?.groups.map(g => g.jid) ?? [];
    if (selectedJid && jids.includes(selectedJid)) return;
    setSelectedJid(jids[0] ?? null);
  }, [status?.groups, selectedJid]);

  // (re)load the feed when the selected tab changes
  useEffect(() => {
    setFeed([]);
    setReplyTarget(null);
    if (!selectedJid) return;
    api<{ messages: any[]; decisions: any[] }>(`/api/feed?jid=${encodeURIComponent(selectedJid)}&limit=100`)
      .then(({ messages, decisions }) => {
        const items: FeedItem[] = [
          ...messages.map(m => ({ kind: 'message' as const, ...m })),
          ...decisions.map(d => ({ kind: 'decision' as const, ...d })),
        ].sort((a, b) => a.ts - b.ts);
        setFeed(items);
      })
      .catch(() => undefined);
  }, [selectedJid]);

  useWs((e: WsEvent) => {
    switch (e.kind) {
      case 'qr': setQr(e.dataUrl); break;
      case 'connection': refreshStatus(); break;
      case 'status': setStatus(e.status); break;
      case 'message':
        setFeed(f => (e.chatJid === selectedJid ? [...f.slice(-300), { kind: 'message', ...e.message }] : f));
        break;
      case 'decision':
        setFeed(f => (e.chatJid === selectedJid
          ? [...f.slice(-300), { kind: 'decision', ts: e.ts, tier: e.tier, decision: e.decision, reason: e.reason }]
          : f));
        break;
      case 'stats':
        setStatus(s => (s ? { ...s, stats: { ...s.stats, ...e.stats } } : s));
        break;
      case 'fact':
      case 'voice':
      case 'sticker':
        setMemoryVersion(v => v + 1);
        break;
    }
  });

  const conn = status?.connection ?? 'connecting';
  const groups = status?.groups ?? [];
  const selected = groups.find(g => g.jid === selectedJid) ?? null;
  const hideInfluence = !!status?.settings?.token_reduction;

  const sendInfluence = async () => {
    const text = influence.trim();
    if ((!text && !replyTarget) || !selectedJid) return;
    await post('/api/influence', { jid: selectedJid, text, target: replyTarget?.shortId });
    setInfluence('');
    setReplyTarget(null);
  };

  const unlink = async (jid: string) => {
    if (!confirm('Unlink this group? Its memory is kept and restored if you relink.')) return;
    await post('/api/group/unlink', { jid });
  };

  return (
    <>
      <div className="topbar">
        <div className="logo">Force<span>AI</span></div>
        <span className={`dot ${conn}`} title={conn} />
        <span className="muted">{conn}</span>
        <div className="grow" />
        {status && status.online && selected && (
          <>
            <span className="phase-chip">{selected.phase}</span>
            <button
              className={selected.paused ? 'primary' : 'danger'}
              onClick={() => post(selected.paused ? '/api/resume' : '/api/pause', { jid: selected.jid })}
            >
              {selected.paused ? '▶ Start' : 'Pause'}
            </button>
          </>
        )}
        {status && (status.online ? (
          <button
            className="danger"
            title="Fully disconnect WhatsApp (linked device goes offline). Memory + states are kept."
            onClick={() => { if (confirm('Shut down ForceAI? It fully disconnects from WhatsApp (your linked device goes offline) so you can test phone notifications. Nothing is lost — Power On resumes everything.')) post('/api/shutdown'); }}
          >⏻ Shut down</button>
        ) : (
          <button className="primary" onClick={() => post('/api/startup')}>⏻ Power On</button>
        ))}
      </div>

      {status && !status.online ? (
        <div className="center-screen">
          <div style={{ fontSize: 40 }}>🔌</div>
          <h2>ForceAI is shut down</h2>
          <p className="muted" style={{ maxWidth: 460, textAlign: 'center' }}>
            WhatsApp is fully disconnected — your linked device is offline, exactly like closing the app.
            Your phone notifications should now behave normally. All memory, groups and their states are
            saved; nothing was reset.
          </p>
          <button className="primary" onClick={() => post('/api/startup')}>⏻ Power On & resume</button>
        </div>
      ) : conn === 'waiting_qr' || conn === 'logged_out' ? (
        <QrLogin qr={qr} />
      ) : groups.length === 0 || showPicker ? (
        <GroupPicker
          connected={conn === 'open'}
          hasGroups={groups.length > 0}
          onDone={() => setShowPicker(false)}
        />
      ) : (
        <>
          <div className="grouptabs">
            {groups.map(g => {
              const state = g.paused ? 'paused' : g.asleep ? 'sleeping' : 'live';
              return (
                <div
                  key={g.jid}
                  className={`grouptab ${g.jid === selectedJid ? 'active' : ''} ${state}`}
                  onClick={() => setSelectedJid(g.jid)}
                  title={`${g.jid} — ${state}`}
                >
                  <span className="gstate" />
                  <span className="gname">{g.name ?? g.jid.split('@')[0]}</span>
                  {g.paused ? <span className="gpaused">⏸</span> : g.asleep ? <span className="gpaused">💤</span> : null}
                  <span className="gclose" title="Unlink group" onClick={(ev) => { ev.stopPropagation(); void unlink(g.jid); }}>✕</span>
                </div>
              );
            })}
            <button className="addtab" onClick={() => setShowPicker(true)}>+ Add group</button>
          </div>

          <div className="main" data-mobile={mobileView}>
            <div className="feed-col">
              <LiveFeed
                items={feed}
                selectedShortId={replyTarget?.shortId}
                onSelect={hideInfluence ? undefined : (t => setReplyTarget(cur => (cur?.shortId === t.shortId ? null : t)))}
              />
              {!hideInfluence && replyTarget && (
                <div className="reply-chip">
                  ↩ ForceAI will reply to <b>{replyTarget.sender}</b>: "{replyTarget.text.slice(0, 70)}{replyTarget.text.length > 70 ? '…' : ''}"
                  <span className="muted" style={{ marginLeft: 8 }}>(add optional guidance below, or just hit Influence)</span>
                  <span className="gclose" style={{ marginLeft: 'auto', cursor: 'pointer' }} onClick={() => setReplyTarget(null)}>✕</span>
                </div>
              )}
              <div className="controls">
                {!hideInfluence && (
                  <>
                    <input
                      placeholder={replyTarget
                        ? 'Optional: what should the reply be about? (empty = its own choice)'
                        : `Influence ${selected?.name ?? 'this group'}: tell ForceAI what to bring up…`}
                      value={influence}
                      onChange={e => setInfluence(e.target.value)}
                      onKeyDown={e => e.key === 'Enter' && sendInfluence()}
                    />
                    <button className="primary" onClick={sendInfluence}>{replyTarget ? 'Reply ↩' : 'Influence ⚡'}</button>
                  </>
                )}
                <button onClick={() => selectedJid && post('/api/continue', { jid: selectedJid })}>Continue ▶</button>
                <button onClick={() => selectedJid && post('/api/sleep', { jid: selectedJid })} title="Put ForceAI to sleep until someone says 'ForceAI'">Sleep 💤</button>
              </div>
            </div>
            <div className="side-col">
              <div className="tabs">
                {(['memory', 'voice', 'stickers', 'stats', 'settings'] as Tab[]).map(t => (
                  <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
                    {t === 'voice' ? 'Voice' : t[0].toUpperCase() + t.slice(1)}
                  </button>
                ))}
              </div>
              <div className="tab-body">
                {tab === 'memory' && selectedJid && <MemoryBrowser jid={selectedJid} version={memoryVersion} />}
                {tab === 'voice' && selectedJid && <VoiceProfilePanel jid={selectedJid} version={memoryVersion} />}
                {tab === 'stickers' && <StickerGrid version={memoryVersion} />}
                {tab === 'stats' && <StatsPanel group={selected} globalStats={status?.stats ?? {}} />}
                {tab === 'settings' && <SettingsPanel onSaved={refreshStatus} />}
              </div>
            </div>
          </div>

          {/* mobile-only bottom navigation */}
          <div className="mobilenav">
            <button
              className={mobileView === 'chat' ? 'active' : ''}
              onClick={() => setMobileView('chat')}
            >💬<span>Chat</span></button>
            {(['memory', 'voice', 'stickers', 'stats', 'settings'] as Tab[]).map(t => (
              <button
                key={t}
                className={mobileView === 'side' && tab === t ? 'active' : ''}
                onClick={() => { setTab(t); setMobileView('side'); }}
              >
                {t === 'memory' ? '🧠' : t === 'voice' ? '🗣️' : t === 'stickers' ? '🖼️' : t === 'stats' ? '📊' : '⚙️'}
                <span>{t === 'voice' ? 'Voice' : t[0].toUpperCase() + t.slice(1)}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </>
  );
}
