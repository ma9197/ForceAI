import { useEffect, useState } from 'react';
import { api, type VoiceProfile } from '../api';

/** Friendly labels + icons for each voice-item category the profiler emits. */
const CATS: { key: string; label: string; icon: string; blurb: string }[] = [
  { key: 'phrase',       label: 'Phrases & sayings', icon: '💬', blurb: 'Recurring expressions the group says' },
  { key: 'slang',        label: 'Slang & vocab',     icon: '🔤', blurb: 'Their words, abbreviations & spellings' },
  { key: 'joke',         label: 'Inside jokes',      icon: '😂', blurb: 'Running bits & callbacks' },
  { key: 'reference',    label: 'References',         icon: '🔗', blurb: 'People, places & things they bring up' },
  { key: 'pattern',      label: 'Talking patterns',  icon: '🌀', blurb: 'How they text — rhythm, punctuation, energy' },
  { key: 'member_style', label: 'Per-member style',  icon: '🧑', blurb: 'How individuals sound' },
];

export function VoiceProfilePanel({ jid, version }: { jid: string; version: number }) {
  const [profile, setProfile] = useState<VoiceProfile | null>(null);

  useEffect(() => {
    api<VoiceProfile>(`/api/voice?jid=${encodeURIComponent(jid)}`).then(setProfile).catch(() => undefined);
  }, [jid, version]);

  const deleteItem = async (id: number) => {
    await fetch(`/api/voice/${id}`, { method: 'DELETE' });
    setProfile(p => (p ? { ...p, items: p.items.filter(i => i.id !== id) } : p));
  };

  const items = profile?.items ?? [];
  const total = items.length;

  return (
    <div className="voice">
      <div className="voice-intro">
        <h3>🗣️ Group voice</h3>
        <p className="muted">
          What ForceAI picks up about how <b>this group</b> texts — your slang, jokes, references
          and rhythm. It blends this into its replies to sound like one of you, while keeping its
          own personality. Learned automatically as you chat — even while it's asleep.
        </p>
      </div>

      {profile?.overview && (
        <div className="voice-overview">
          <span className="voice-overview-label">The vibe</span>
          <p>{profile.overview}</p>
        </div>
      )}

      {total === 0 ? (
        <p className="muted" style={{ fontSize: 13 }}>
          Nothing learned yet — once the group racks up ~50 messages, ForceAI starts taking notes here.
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
                <div key={it.id} className="voice-item">
                  <div className="voice-item-body">
                    <div className="voice-content-row">
                      {it.member_name && <span className="voice-who">{it.member_name}</span>}
                      <span className="voice-content">{it.content}</span>
                    </div>
                    {it.example && <span className="voice-example">e.g. "{it.example}"</span>}
                  </div>
                  <button title="Forget this" onClick={() => deleteItem(it.id)}>✕</button>
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
