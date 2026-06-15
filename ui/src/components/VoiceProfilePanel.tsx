import { useCallback, useEffect, useState } from 'react';
import { api, post, type VoiceItem, type VoiceProfile } from '../api';

/** Friendly labels + icons for each voice-item category the profiler emits. */
const CATS: { key: string; label: string; icon: string; blurb: string }[] = [
  { key: 'phrase',       label: 'Phrases & sayings', icon: '💬', blurb: 'Recurring expressions the group says' },
  { key: 'slang',        label: 'Slang & vocab',     icon: '🔤', blurb: 'Their words & abbreviations — shared across all your groups' },
  { key: 'joke',         label: 'Inside jokes',      icon: '😂', blurb: 'Running bits & callbacks' },
  { key: 'reference',    label: 'References',         icon: '🔗', blurb: 'People, places & things they bring up' },
  { key: 'pattern',      label: 'Talking patterns',  icon: '🌀', blurb: 'How they text — rhythm, punctuation, energy' },
  { key: 'member_style', label: 'Per-member style',  icon: '🧑', blurb: 'How individuals sound' },
];

type LearnResult = { status: string; learned: number };

function messageFor(res: LearnResult, source: 'chat' | 'memory'): string {
  switch (res.status) {
    case 'ok':
      return res.learned > 0
        ? `✓ Learned ${res.learned} new voice ${res.learned === 1 ? 'note' : 'notes'} — review them below.`
        : '✓ Already up to date — nothing new found.';
    case 'empty':
      return source === 'chat' ? 'No chat history stored yet to scan.' : 'No memory to mine yet.';
    case 'busy':   return 'Already analyzing — give it a moment, then try again.';
    case 'budget': return 'Skipped — daily budget reached.';
    default:       return 'Something went wrong — try again.';
  }
}

export function VoiceProfilePanel({ jid, version }: { jid: string; version: number }) {
  const [profile, setProfile] = useState<VoiceProfile | null>(null);
  const [busy, setBusy] = useState<null | 'chat' | 'memory'>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editText, setEditText] = useState('');
  const [editError, setEditError] = useState<string | null>(null);

  const reload = useCallback(() => {
    return api<VoiceProfile>(`/api/voice?jid=${encodeURIComponent(jid)}`).then(setProfile).catch(() => undefined);
  }, [jid]);

  useEffect(() => { void reload(); }, [reload, version]);

  const patchItem = (id: number, patch: Partial<VoiceItem>) =>
    setProfile(p => (p ? { ...p, items: p.items.map(i => (i.id === id ? { ...i, ...patch } : i)) } : p));

  const learn = async (source: 'chat' | 'memory') => {
    if (busy) return;
    setBusy(source);
    setFeedback(null);
    try {
      const res = (await post('/api/voice/learn', { jid, source })) as LearnResult;
      setFeedback(messageFor(res, source));
      await reload();
    } catch {
      setFeedback('Something went wrong — try again.');
    } finally {
      setBusy(null);
    }
  };

  const check = async (id: number, checked: boolean) => {
    patchItem(id, { checked: checked ? 1 : 0 });
    try { await post(`/api/voice/${id}/check`, { checked }); }
    catch { void reload(); }
  };

  const checkAll = async () => {
    setProfile(p => (p ? { ...p, items: p.items.map(i => ({ ...i, checked: 1 })) } : p));
    try { await post('/api/voice/check-all', { jid }); }
    catch { void reload(); }
  };

  const startEdit = (it: VoiceItem) => { setEditingId(it.id); setEditText(it.content); setEditError(null); };
  const cancelEdit = () => { setEditingId(null); setEditError(null); };
  const saveEdit = async (id: number) => {
    const content = editText.trim();
    if (!content) return;
    try {
      await post(`/api/voice/${id}/edit`, { content });
      patchItem(id, { content });
      setEditingId(null);
      setEditError(null);
    } catch {
      setEditError('Could not save — that text may duplicate another note.');
    }
  };

  const deleteItem = async (id: number) => {
    await fetch(`/api/voice/${id}`, { method: 'DELETE' });
    setProfile(p => (p ? { ...p, items: p.items.filter(i => i.id !== id) } : p));
  };

  const items = profile?.items ?? [];
  const total = items.length;
  const unchecked = items.filter(i => !i.checked).length;

  return (
    <div className="voice">
      <div className="voice-intro">
        <h3>🗣️ Group voice</h3>
        <p className="muted">
          What ForceAI picks up about how <b>this group</b> texts — your slang, jokes, references
          and rhythm. New notes show up <span className="voice-new-pill">highlighted</span> until you
          review them. Check the ones you like, edit any that are off, delete the rest.
        </p>
      </div>

      <div className="voice-actions">
        <button disabled={!!busy} onClick={() => learn('chat')} title="Re-read your saved chat history and pull fresh voice notes">
          {busy === 'chat' ? '⏳ Scanning chat…' : '🔄 Learn from chat'}
        </button>
        <button disabled={!!busy} onClick={() => learn('memory')} title="Mine the bot's saved facts & summary for voice-relevant style">
          {busy === 'memory' ? '⏳ Mining memory…' : '🧠 Learn from memory'}
        </button>
        {feedback && <span className="voice-feedback">{feedback}</span>}
      </div>
      <p className="voice-actions-hint muted">
        Pull a fresh update on demand. Safe to run anytime — it only adds what's genuinely new, never duplicates.
      </p>

      {unchecked > 0 && (
        <div className="voice-review-bar">
          <span>🟡 {unchecked} new {unchecked === 1 ? 'note' : 'notes'} to review</span>
          <button onClick={checkAll}>✓ Check all</button>
        </div>
      )}

      {profile?.overview && (
        <div className="voice-overview">
          <span className="voice-overview-label">The vibe</span>
          <p>{profile.overview}</p>
        </div>
      )}

      {total === 0 ? (
        <p className="muted" style={{ fontSize: 13 }}>
          Nothing learned yet — chat for a bit, or hit <b>Learn from chat</b> / <b>Learn from memory</b> above to pull what's already stored.
        </p>
      ) : (
        <p className="muted" style={{ fontSize: 11, margin: '0 0 10px' }}>
          {total} voice {total === 1 ? 'note' : 'notes'} learned · for THIS group only
        </p>
      )}

      {CATS.map(cat => {
        const catItems = items.filter(i => i.category === cat.key);
        if (catItems.length === 0) return null;
        return (
          <div key={cat.key} className="voice-cat">
            <div className="voice-cat-head">
              <span className="voice-cat-icon">{cat.icon}</span>
              <div>
                <div className="voice-cat-title">
                  {cat.label} <span className="muted" style={{ fontWeight: 400 }}>· {catItems.length}</span>
                </div>
                <div className="voice-cat-blurb">{cat.blurb}</div>
              </div>
            </div>
            <div className="voice-items">
              {catItems.map(it => (
                <div key={it.id} className={`voice-item ${it.checked ? '' : 'voice-item--new'}`}>
                  {editingId === it.id ? (
                    <div className="voice-edit">
                      <input
                        value={editText}
                        autoFocus
                        onChange={e => setEditText(e.target.value)}
                        onKeyDown={e => {
                          if (e.key === 'Enter') void saveEdit(it.id);
                          if (e.key === 'Escape') cancelEdit();
                        }}
                      />
                      <div className="voice-edit-actions">
                        <button className="primary" onClick={() => saveEdit(it.id)}>Save</button>
                        <button onClick={cancelEdit}>Cancel</button>
                      </div>
                      {editError && <span className="voice-edit-error">{editError}</span>}
                    </div>
                  ) : (
                    <>
                      <div className="voice-item-body">
                        <div className="voice-content-row">
                          {it.member_name && <span className="voice-who">{it.member_name}</span>}
                          <span className="voice-content">{it.content}</span>
                        </div>
                        {it.example && <span className="voice-example">e.g. "{it.example}"</span>}
                      </div>
                      <div className="voice-item-actions">
                        <button
                          className={`voice-check ${it.checked ? 'on' : ''}`}
                          title={it.checked ? 'Reviewed — click to flag as new again' : 'Mark reviewed'}
                          onClick={() => check(it.id, !it.checked)}
                        >✓</button>
                        <button title="Edit text" onClick={() => startEdit(it)}>✎</button>
                        <button title="Forget this" onClick={() => deleteItem(it.id)}>✕</button>
                      </div>
                    </>
                  )}
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
