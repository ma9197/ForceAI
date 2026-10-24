import type { MsgRow } from './signals.js';

/**
 * Brain v2 replay (dashboard): which moments of the last hours to ask v2 about, and what the live bot
 * really did right after each one. Pure, so it is tested without a WhatsApp connection.
 */

/**
 * Up to `n` moments, evenly spread, each at the end of a burst of human messages (the next message
 * is from someone else, or comes 20+ seconds later), the way the arbiter's debounce sees the chat.
 * The latest burst is always included.
 */
export function pickReplayCuts(rows: MsgRow[], n: number): MsgRow[] {
  const chat = rows.filter(r => r.type !== 'reaction');
  const human = (r: MsgRow) => !r.is_bot && !r.is_owner;
  const ends = chat.filter((r, i) => human(r) && r.type === 'text' && (!chat[i + 1] || chat[i + 1].sender_jid !== r.sender_jid || chat[i + 1].ts - r.ts >= 20_000));
  if (ends.length === 0 || n <= 0) return [];
  const k = Math.min(n, ends.length);
  const picks = Array.from({ length: k }, (_, i) => ends[Math.round(((i + 1) * (ends.length - 1)) / k)]);
  return [...new Map(picks.map(p => [p.id ?? String(p.ts), p])).values()];
}

/** What the live bot did between a cut and the next one (at most 3 minutes later). */
export function actualAfter(rows: MsgRow[], cutTs: number, nextTs: number): string {
  const after = rows.filter(r => r.is_bot && r.ts > cutTs && r.ts <= Math.min(nextTs, cutTs + 3 * 60_000));
  if (after.length === 0) return 'stayed quiet';
  return after.map(r => (r.type === 'reaction' ? `reacted ${r.text ?? ''}` : r.type === 'text' ? `said: ${String(r.text ?? '').slice(0, 120)}` : `sent a ${r.type}`)).join(' / ');
}
