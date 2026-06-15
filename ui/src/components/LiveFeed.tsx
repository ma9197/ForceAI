import { useEffect, useRef, useState } from 'react';

export type FeedItem =
  | { kind: 'message'; id: string; shortId: string; senderName: string; isBot: boolean; isOwner: boolean; type: string; text: string; quotedText?: string; reactionEmoji?: string; ts: number }
  | { kind: 'decision'; ts: number; tier: string; decision: string; reason: string };

function time(ts: number): string {
  return new Date(ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

/** Stable, distinct color per member name (hash → HSL). Members only; bot/owner have fixed colors. */
function nameColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360}, 70%, 72%)`;
}

export interface ReplyTarget { shortId: string; sender: string; text: string }

/** Renders the actual image/sticker for a message; falls back to a label if the media can't load. */
function MediaImage({ id, kind, caption }: { id: string; kind: 'image' | 'sticker'; caption?: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return <div className="msg-fallback">{kind === 'sticker' ? '🩵 sticker' : `🖼️ image${caption ? ' · ' + caption : ''}`}</div>;
  }
  return (
    <>
      <img
        className={kind === 'sticker' ? 'msg-sticker' : 'msg-img'}
        src={`/api/media/${encodeURIComponent(id)}`}
        loading="lazy"
        alt={kind}
        onError={() => setFailed(true)}
      />
      {kind === 'image' && caption ? <div className="msg-caption">{caption}</div> : null}
    </>
  );
}

export function LiveFeed({ items, selectedShortId, onSelect }: {
  items: FeedItem[];
  selectedShortId?: string | null;
  onSelect?: (target: ReplyTarget) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [items.length]);

  // collapse the name title for consecutive messages from the same sender (messaging-app style)
  let lastSenderKey: string | null = null;

  return (
    <div className="feed" ref={ref}>
      {items.map((item, i) => {
        if (item.kind === 'decision') {
          lastSenderKey = null; // a system row breaks the run
          return (
            <div key={`d${i}`} className="decision-row" title={new Date(item.ts).toLocaleString()}>
              <b>{item.tier} {item.decision}</b> — {item.reason}
            </div>
          );
        }
        const m = item;
        const outgoing = m.isBot || m.isOwner; // bot + owner share this account → right side
        const senderKey = m.isBot ? '__bot' : m.isOwner ? '__owner' : m.senderName;
        const continuation = senderKey === lastSenderKey;
        lastSenderKey = senderKey;

        const whoLabel = m.isBot ? 'ForceAI' : m.isOwner ? 'You (admin)' : m.senderName;
        const whoColor = m.isBot ? 'var(--accent)' : m.isOwner ? 'var(--warn)' : nameColor(m.senderName);
        const isMedia = m.type === 'image' || m.type === 'sticker';

        return (
          <div
            key={m.id}
            className={`msg ${outgoing ? 'out' : 'in'} ${m.isBot ? 'bot' : ''} ${m.isOwner ? 'owner' : ''} type-${m.type} ${m.shortId === selectedShortId ? 'selected' : ''} ${continuation ? 'continuation' : ''}`}
            title="Click to make ForceAI reply to this message"
            onClick={() => onSelect?.({ shortId: m.shortId, sender: m.senderName, text: m.text })}
          >
            {!continuation && (
              <div className="who" style={{ color: whoColor }}>
                {whoLabel} <span className="muted">#{m.shortId}</span>
              </div>
            )}
            {m.quotedText && <div className="quoted">↪ {m.quotedText.slice(0, 90)}</div>}
            <div className="msg-content">
              {isMedia ? <MediaImage id={m.id} kind={m.type as 'image' | 'sticker'} caption={m.text} />
                : m.type === 'reaction' ? <span className="msg-meta">reacted {m.text || '👍'}</span>
                : m.type === 'poll' ? <span>📊 {m.text}</span>
                : m.type === 'audio' ? <span className="msg-meta">🎤 voice note</span>
                : m.type === 'text' ? m.text
                : `[${m.type}] ${m.text}`}
            </div>
            <span className="msg-time">{time(m.ts)}</span>
          </div>
        );
      })}
      {items.length === 0 && <p className="muted" style={{ textAlign: 'center', marginTop: 40 }}>No activity yet — messages and bot decisions will appear here live.</p>}
    </div>
  );
}
