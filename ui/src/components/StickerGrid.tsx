import { useEffect, useState } from 'react';
import { api, type Sticker } from '../api';

export function StickerGrid({ version }: { version: number }) {
  const [stickers, setStickers] = useState<Sticker[]>([]);
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState('');

  const load = () => api<Sticker[]>('/api/stickers').then(setStickers).catch(() => undefined);
  useEffect(() => { load(); }, [version]);

  const save = async (id: number) => {
    await fetch(`/api/stickers/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: draft }),
    });
    setEditing(null);
    load();
  };

  return (
    <div>
      <div className="voice-intro">
        <h3>🖼️ Stickers</h3>
        <p className="muted">
          The stickers ForceAI can send, and what each one means. To teach a new one: open your WhatsApp
          self-chat (message yourself), send the word <b>"Sticker"</b>, then the sticker, then a short
          description of when to use it.
        </p>
      </div>
      <div className="sticker-grid">
        {stickers.map(s => (
          <div
            key={s.id}
            className="sticker-card"
            style={editing === s.id ? { gridColumn: '1 / -1', display: 'flex', gap: 12, alignItems: 'flex-start', textAlign: 'left' } : undefined}
          >
            <img src={`/api/stickers/${s.id}/image`} alt={s.description ?? `sticker ${s.id}`} />
            {editing === s.id ? (
              <div style={{ flex: 1 }}>
                <textarea
                  value={draft}
                  onChange={e => setDraft(e.target.value)}
                  rows={3}
                  autoFocus
                  onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); save(s.id); } }}
                  style={{ width: '100%', fontSize: 13, resize: 'vertical', fontFamily: 'inherit', boxSizing: 'border-box' }}
                />
                <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                  <button className="primary" onClick={() => save(s.id)}>Save</button>
                  <button onClick={() => setEditing(null)}>Cancel</button>
                </div>
              </div>
            ) : (
              <div className="desc" onClick={() => { setEditing(s.id); setDraft(s.description ?? ''); }} title="Click to edit">
                {s.description ?? <i>(no description — click to add)</i>}
              </div>
            )}
            {editing !== s.id && <div className="muted" style={{ fontSize: 10, marginTop: 2 }}>used ×{s.times_used}</div>}
          </div>
        ))}
      </div>
      {stickers.length === 0 && <p className="muted">No stickers learned yet.</p>}
    </div>
  );
}
