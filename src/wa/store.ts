import type { WAMessage } from 'baileys';
import type { Repo } from '../memory/repo.js';
import { reviveBytes } from './polls.js';

/**
 * LRU of recent raw WAMessage objects so reply/reaction targets resolve to real keys.
 * Falls back to reconstructing from the messages.raw column after a restart.
 */
export class MessageStore {
  private byId = new Map<string, WAMessage>(); // insertion order = LRU
  private shortToId = new Map<string, string>();
  private max = 500;

  constructor(private repo: Repo) {}

  put(id: string, shortId: string, raw: WAMessage): void {
    if (this.byId.has(id)) this.byId.delete(id);
    this.byId.set(id, raw);
    this.shortToId.set(shortId, id);
    while (this.byId.size > this.max) {
      const oldest = this.byId.keys().next().value as string;
      this.byId.delete(oldest);
    }
    while (this.shortToId.size > this.max * 2) {
      const oldest = this.shortToId.keys().next().value as string;
      this.shortToId.delete(oldest);
    }
  }

  /** Accepts either a short id (m42) or a raw WhatsApp message id. */
  resolve(ref: string): WAMessage | null {
    const id = this.shortToId.get(ref) ?? ref;
    const cached = this.byId.get(id);
    if (cached) return cached;
    // fallback: rebuild from DB raw JSON (post-restart)
    const row = this.repo.getMessageByShortId(ref) ?? this.repo.getMessageById(id);
    if (row?.raw) {
      try {
        const parsed = JSON.parse(row.raw) as WAMessage;
        // byte fields don't survive JSON — restore the one decryption needs
        const ctx = (parsed.message as any)?.messageContextInfo;
        if (ctx?.messageSecret) ctx.messageSecret = reviveBytes(ctx.messageSecret);
        return parsed;
      } catch { return null; }
    }
    return null;
  }
}
