import { useEffect, useRef } from 'react';

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
  const hue = h % 360;
  // keep saturation/lightness in a readable band on the dark theme
  return `hsl(${hue}, 68%, 66%)`;
}

export interface ReplyTarget { shortId: string; sender: string; text: string }

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

  // track the previous message's sender so consecutive messages from the same person
  // collapse their name title (messaging-app style). Decision rows don't break the run.
  let lastSenderKey: string | null = null;

  return (
    <div className="feed" ref={ref}>
      {items.map((item, i) => {
        if (item.kind === 'decision') {
          return (
            <div key={`d${i}`} className="decision-row" title={new Date(item.ts).toLocaleString()}>
              <b>{item.tier} {item.decision}</b> — {item.reason}
            </div>
          );
        }
        const m = item;
        const senderKey = m.isBot ? '__bot' : m.isOwner ? '__owner' : m.senderName;
        const continuation = senderKey === lastSenderKey;
        lastSenderKey = senderKey;

        const whoColor = m.isBot ? undefined : m.isOwner ? 'var(--warn)' : nameColor(m.senderName);

        const body =
          m.type === 'reaction' ? `reacted ${m.text || '👍'}` :
          m.type === 'sticker' ? '🩵 [sticker]' :
          m.type === 'poll' ? `📊 ${m.text}` :
          m.type === 'audio' ? `🎤 [voice note]` :
          m.type === 'image' ? `🖼️ [image]${m.text ? ' ' + m.text : ''}` :
          m.type === 'text' ? m.text : `[${m.type}] ${m.text}`;
        return (
          <div
            key={m.id}
            className={`msg ${m.isBot ? 'bot' : ''} ${m.isOwner ? 'owner' : ''} ${m.shortId === selectedShortId ? 'selected' : ''} ${continuation ? 'continuation' : ''}`}
            title="Click to make ForceAI reply to this message"
            onClick={() => onSelect?.({ shortId: m.shortId, sender: m.senderName, text: m.text })}
          >
            {!continuation && (
              <div className="who" style={whoColor ? { color: whoColor } : undefined}>
                {m.isOwner ? 'You (admin)' : m.senderName} <span className="muted">#{m.shortId}</span>
              </div>
            )}
            {m.quotedText && <div className="quoted">↪ {m.quotedText.slice(0, 80)}</div>}
            <div>{body}</div>
            <div className="time">{time(m.ts)}</div>
          </div>
        );
      })}
      {items.length === 0 && <p className="muted" style={{ textAlign: 'center', marginTop: 40 }}>No activity yet — messages and bot decisions will appear here live.</p>}
    </div>
  );
}
