import { useEffect, useRef, useState } from 'react';

export type FeedItem =
  | { kind: 'message'; id: string; shortId: string; senderName: string; isBot: boolean; isOwner: boolean; type: string; text: string; quotedText?: string; reactionEmoji?: string; ts: number }
  | { kind: 'decision'; ts: number; tier: string; decision: string; reason: string };

function time(ts: number): string {
  return new Date(ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

/** Distinct, readable member-name colors (WhatsApp-style). Assigned per person by first appearance
 *  so two members never collide — unlike a hash, which could map both to the same hue. */
const NAME_PALETTE = [
  '#53bdeb', '#e542a3', '#5ad469', '#ffab00', '#a78bfa', '#ff7e6b',
  '#00d5c0', '#f6c445', '#7aa2ff', '#ff8fb1', '#9ad36b', '#f0883e',
  '#4fd1c5', '#d98cff', '#ffd166', '#8ecae6',
];

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

  // assign each distinct member a palette color (by first appearance) so colors never collide
  const colorByName = new Map<string, string>();
  let ci = 0;
  for (const it of items) {
    if (it.kind === 'message' && !it.isBot && !it.isOwner && !colorByName.has(it.senderName)) {
      colorByName.set(it.senderName, NAME_PALETTE[ci % NAME_PALETTE.length]);
      ci += 1;
    }
  }

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
        const whoColor = m.isBot ? 'var(--accent)' : m.isOwner ? 'var(--warn)' : (colorByName.get(m.senderName) ?? '#53bdeb');
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
