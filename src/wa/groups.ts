import type { WASocket, GroupMetadata } from 'baileys';
import { logger } from '../logger.js';

export interface GroupInfo {
  jid: string;
  subject: string;
  size: number;
}

export class Groups {
  private cache = new Map<string, GroupMetadata>();

  constructor(private getSock: () => WASocket | null) {}

  async listAll(): Promise<GroupInfo[]> {
    const sock = this.getSock();
    if (!sock) return [];
    try {
      const all = await sock.groupFetchAllParticipating();
      this.cache = new Map(Object.entries(all));
      return Object.values(all)
        .map(g => ({ jid: g.id, subject: g.subject, size: g.participants?.length ?? 0 }))
        .sort((a, b) => a.subject.localeCompare(b.subject));
    } catch (err) {
      logger.error({ err }, 'groupFetchAllParticipating failed');
      return [];
    }
  }

  async metadata(jid: string, refresh = false): Promise<GroupMetadata | null> {
    const sock = this.getSock();
    if (!refresh && this.cache.has(jid)) return this.cache.get(jid)!;
    if (!sock) return null;
    try {
      const meta = await sock.groupMetadata(jid);
      this.cache.set(jid, meta);
      return meta;
    } catch (err) {
      logger.error({ err, jid }, 'groupMetadata failed');
      return null;
    }
  }

  subjectOf(jid: string): string | null {
    return this.cache.get(jid)?.subject ?? null;
  }

  /** Inject a subject into the cache (used by demo-mode seeding, which has no real WhatsApp). */
  setCachedSubject(jid: string, subject: string): void {
    this.cache.set(jid, { id: jid, subject, participants: [] } as unknown as GroupMetadata);
  }
}
