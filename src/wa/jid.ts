import { isLidUser, isPnUser, jidNormalizedUser } from 'baileys';
import type { Repo } from '../memory/repo.js';

/**
 * v7 LID/PN duality: the same human can appear as `...@lid` or `...@s.whatsapp.net`.
 * Canonical member key = LID when known, otherwise PN.
 * All sender identity flows through this class so facts never split across duplicates.
 */
export class JidResolver {
  private ownJids = new Set<string>();

  constructor(private repo: Repo) {}

  setOwnIdentity(idJid: string | undefined, lidJid: string | undefined): void {
    this.ownJids.clear();
    if (idJid) this.ownJids.add(jidNormalizedUser(idJid));
    if (lidJid) this.ownJids.add(jidNormalizedUser(lidJid));
    if (idJid && lidJid && isLidUser(lidJid) && isPnUser(idJid)) {
      this.repo.storeLidPn(jidNormalizedUser(lidJid), jidNormalizedUser(idJid));
    }
  }

  isOwnJid(jid: string | undefined | null): boolean {
    if (!jid) return false;
    const n = jidNormalizedUser(jid);
    if (this.ownJids.has(n)) return true;
    // also match across the LID/PN mapping
    const mapped = isLidUser(n) ? this.repo.getPnForLid(n) : this.repo.getLidForPn(n);
    return mapped ? this.ownJids.has(mapped) : false;
  }

  storeMapping(lid: string, pn: string): void {
    this.repo.storeLidPn(jidNormalizedUser(lid), jidNormalizedUser(pn));
  }

  /**
   * Resolve any (jid, altJid) pair to the canonical key (prefer LID),
   * recording the mapping when both sides are present.
   */
  canonical(jid: string | undefined, altJid?: string | undefined): { canonical: string; pn: string | null } {
    const a = jid ? jidNormalizedUser(jid) : undefined;
    const b = altJid ? jidNormalizedUser(altJid) : undefined;

    let lid: string | undefined;
    let pn: string | undefined;
    for (const j of [a, b]) {
      if (!j) continue;
      if (isLidUser(j)) lid = j;
      else if (isPnUser(j)) pn = j;
    }

    if (lid && pn) this.repo.storeLidPn(lid, pn);
    if (lid) return { canonical: lid, pn: pn ?? this.repo.getPnForLid(lid) };
    if (pn) {
      const mappedLid = this.repo.getLidForPn(pn);
      return mappedLid ? { canonical: mappedLid, pn } : { canonical: pn, pn };
    }
    return { canonical: a ?? b ?? 'unknown@s.whatsapp.net', pn: null };
  }
}
