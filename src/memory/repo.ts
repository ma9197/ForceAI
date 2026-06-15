import type Database from 'better-sqlite3';
import type { FactRow, MemberRow, NormalizedMessage, StickerRow } from '../types.js';

export class Repo {
  constructor(public db: Database.Database) {}

  // ---- config ----
  getConfig(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM config WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setConfig(key: string, value: string): void {
    this.db.prepare(
      'INSERT INTO config(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    ).run(key, value);
  }

  // ---- members ----
  upsertMember(jid: string, name: string | null, pnJid: string | null, ts: number): void {
    this.db.prepare(`
      INSERT INTO members(jid, pn_jid, display_name, first_seen, last_seen, message_count)
      VALUES(?, ?, ?, ?, ?, 0)
      ON CONFLICT(jid) DO UPDATE SET
        display_name = COALESCE(excluded.display_name, members.display_name),
        pn_jid = COALESCE(excluded.pn_jid, members.pn_jid),
        last_seen = excluded.last_seen
    `).run(jid, pnJid, name, ts, ts);
  }

  bumpMemberMessageCount(jid: string): void {
    this.db.prepare('UPDATE members SET message_count = message_count + 1 WHERE jid = ?').run(jid);
  }

  getMembers(): MemberRow[] {
    return this.db.prepare('SELECT * FROM members ORDER BY message_count DESC').all() as MemberRow[];
  }

  getMember(jid: string): MemberRow | undefined {
    return this.db.prepare('SELECT * FROM members WHERE jid = ?').get(jid) as MemberRow | undefined;
  }

  setMemberNotes(jid: string, notes: string): void {
    this.db.prepare('UPDATE members SET personality_notes = ? WHERE jid = ?').run(notes, jid);
  }

  // ---- lid/pn map ----
  storeLidPn(lid: string, pn: string): void {
    this.db.prepare('INSERT OR REPLACE INTO lid_pn_map(lid, pn) VALUES(?, ?)').run(lid, pn);
  }

  getLidForPn(pn: string): string | null {
    const row = this.db.prepare('SELECT lid FROM lid_pn_map WHERE pn = ?').get(pn) as { lid: string } | undefined;
    return row?.lid ?? null;
  }

  getPnForLid(lid: string): string | null {
    const row = this.db.prepare('SELECT pn FROM lid_pn_map WHERE lid = ?').get(lid) as { pn: string } | undefined;
    return row?.pn ?? null;
  }

  // ---- messages ----
  insertMessage(m: NormalizedMessage): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO messages(id, short_id, chat_jid, sender_jid, sender_name, from_me, is_bot, is_owner, text, type, quoted_id, ts, raw)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      m.id, m.shortId, m.chatJid, m.senderJid, m.senderName,
      m.fromMe ? 1 : 0, m.isBot ? 1 : 0, m.isOwner ? 1 : 0,
      m.text, m.type, m.quotedId ?? null, m.ts, JSON.stringify(m.raw)
    );
  }

  setMediaPath(messageId: string, path: string): void {
    this.db.prepare('UPDATE messages SET media_path = ? WHERE id = ?').run(path, messageId);
  }

  /** Most recent image messages in a group that have a downloaded file, newest first. */
  getRecentImageMessages(chatJid: string, sinceTs: number, limit: number): any[] {
    return this.db.prepare(`
      SELECT * FROM messages
      WHERE chat_jid = ? AND type = 'image' AND media_path IS NOT NULL AND ts >= ?
      ORDER BY ts DESC LIMIT ?
    `).all(chatJid, sinceTs, limit);
  }

  getRecentMessages(chatJid: string, limit: number): any[] {
    return this.db.prepare(
      'SELECT * FROM messages WHERE chat_jid = ? ORDER BY ts DESC LIMIT ?'
    ).all(chatJid, limit).reverse();
  }

  getMessageById(id: string): any | undefined {
    return this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id);
  }

  getMessageByShortId(shortId: string): any | undefined {
    return this.db.prepare('SELECT * FROM messages WHERE short_id = ?').get(shortId);
  }

  countMessagesSince(chatJid: string, ts: number): number {
    const row = this.db.prepare(
      'SELECT COUNT(*) AS c FROM messages WHERE chat_jid = ? AND ts > ? AND is_bot = 0'
    ).get(chatJid, ts) as { c: number };
    return row.c;
  }

  getMessagesBetween(chatJid: string, fromTs: number, toTs: number): any[] {
    return this.db.prepare(
      'SELECT * FROM messages WHERE chat_jid = ? AND ts > ? AND ts <= ? ORDER BY ts ASC'
    ).all(chatJid, fromTs, toTs);
  }

  // ---- bot messages ----
  addBotMessage(messageId: string, ts: number): void {
    this.db.prepare('INSERT OR IGNORE INTO bot_messages(message_id, ts) VALUES(?, ?)').run(messageId, ts);
  }

  isBotMessage(messageId: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM bot_messages WHERE message_id = ?').get(messageId);
  }

  // ---- facts (scoped per group — groups never share memory) ----
  insertFact(chatJid: string, memberJid: string, fact: string, category: string | null, confidence: number | null, sourceMessageId: string | null): number | null {
    try {
      const res = this.db.prepare(`
        INSERT INTO facts(chat_jid, member_jid, fact, category, confidence, source_message_id, created_at)
        VALUES(?, ?, ?, ?, ?, ?, ?)
      `).run(chatJid, memberJid, fact, category, confidence, sourceMessageId, Date.now());
      return Number(res.lastInsertRowid);
    } catch {
      return null; // UNIQUE violation — duplicate fact in this group
    }
  }

  supersedeFact(oldId: number, newId: number): void {
    this.db.prepare('UPDATE facts SET superseded_by = ? WHERE id = ?').run(newId, oldId);
  }

  getActiveFacts(chatJid: string, memberJid?: string): FactRow[] {
    if (memberJid) {
      return this.db.prepare(
        'SELECT * FROM facts WHERE chat_jid = ? AND member_jid = ? AND superseded_by IS NULL ORDER BY created_at ASC'
      ).all(chatJid, memberJid) as FactRow[];
    }
    return this.db.prepare(
      'SELECT * FROM facts WHERE chat_jid = ? AND superseded_by IS NULL ORDER BY member_jid, created_at ASC'
    ).all(chatJid) as FactRow[];
  }

  /** Members who have actually spoken in this group — keeps group memory views isolated. */
  getMembersForChat(chatJid: string): MemberRow[] {
    return this.db.prepare(`
      SELECT * FROM members WHERE jid IN (
        SELECT DISTINCT sender_jid FROM messages WHERE chat_jid = ? AND is_bot = 0 AND is_owner = 0
      ) ORDER BY message_count DESC
    `).all(chatJid) as MemberRow[];
  }

  deleteFact(id: number): void {
    this.db.prepare('DELETE FROM facts WHERE id = ?').run(id);
  }

  // ---- voice profiler (per-group learned texting style) ----
  insertVoiceItem(chatJid: string, category: string, content: string, example: string | null, memberJid: string | null): number | null {
    try {
      const res = this.db.prepare(`
        INSERT INTO voice_items(chat_jid, category, content, example, member_jid, created_at)
        VALUES(?, ?, ?, ?, ?, ?)
      `).run(chatJid, category, content, example, memberJid, Date.now());
      return Number(res.lastInsertRowid);
    } catch {
      return null; // UNIQUE violation — already learned this exact item in this group
    }
  }

  supersedeVoiceItem(oldId: number, newId: number): void {
    this.db.prepare('UPDATE voice_items SET superseded_by = ? WHERE id = ?').run(newId, oldId);
  }

  getVoiceItems(chatJid: string): import('../types.js').VoiceItemRow[] {
    return this.db.prepare(
      'SELECT * FROM voice_items WHERE chat_jid = ? AND superseded_by IS NULL ORDER BY category, created_at ASC'
    ).all(chatJid) as import('../types.js').VoiceItemRow[];
  }

  deleteVoiceItem(id: number): void {
    this.db.prepare('DELETE FROM voice_items WHERE id = ?').run(id);
  }

  /** Mark a single voice item reviewed/unreviewed. */
  setVoiceItemChecked(id: number, checked: boolean): void {
    this.db.prepare('UPDATE voice_items SET checked = ? WHERE id = ?').run(checked ? 1 : 0, id);
  }

  /** Mark every active voice item in a group as reviewed. Returns how many were flipped. */
  checkAllVoiceItems(chatJid: string): number {
    const res = this.db.prepare(
      'UPDATE voice_items SET checked = 1 WHERE chat_jid = ? AND superseded_by IS NULL AND checked = 0'
    ).run(chatJid);
    return res.changes;
  }

  /** Edit a voice item's text. Returns false if the new content collides with an existing item. */
  updateVoiceItemContent(id: number, content: string): boolean {
    try {
      this.db.prepare('UPDATE voice_items SET content = ? WHERE id = ?').run(content, id);
      return true;
    } catch {
      return false; // UNIQUE(chat_jid, category, content) collision
    }
  }

  getVoiceOverview(chatJid: string): string | null {
    return this.getConfig(`voice_overview:${chatJid}`);
  }

  setVoiceOverview(chatJid: string, text: string): void {
    this.setConfig(`voice_overview:${chatJid}`, text);
  }

  // ---- stickers ----
  insertSticker(filePath: string, sha256: string): { id: number; existed: boolean } {
    const existing = this.db.prepare('SELECT id FROM stickers WHERE sha256 = ?').get(sha256) as { id: number } | undefined;
    if (existing) return { id: existing.id, existed: true };
    const res = this.db.prepare(
      'INSERT INTO stickers(file_path, sha256, added_at) VALUES(?, ?, ?)'
    ).run(filePath, sha256, Date.now());
    return { id: Number(res.lastInsertRowid), existed: false };
  }

  setStickerDescription(id: number, description: string, usageHint: string | null): void {
    this.db.prepare('UPDATE stickers SET description = ?, usage_hint = ? WHERE id = ?').run(description, usageHint, id);
  }

  getStickers(): StickerRow[] {
    return this.db.prepare('SELECT * FROM stickers ORDER BY id ASC').all() as StickerRow[];
  }

  getSticker(id: number): StickerRow | undefined {
    return this.db.prepare('SELECT * FROM stickers WHERE id = ?').get(id) as StickerRow | undefined;
  }

  bumpStickerUse(id: number): void {
    this.db.prepare('UPDATE stickers SET times_used = times_used + 1 WHERE id = ?').run(id);
  }

  // ---- poll votes ----
  setPollVote(pollId: string, voterJid: string, voterName: string, options: string[]): void {
    this.db.prepare(`
      INSERT INTO poll_votes(poll_id, voter_jid, voter_name, options, ts) VALUES(?, ?, ?, ?, ?)
      ON CONFLICT(poll_id, voter_jid) DO UPDATE SET
        options = excluded.options, voter_name = excluded.voter_name, ts = excluded.ts
    `).run(pollId, voterJid, voterName, JSON.stringify(options), Date.now());
  }

  getPollVotes(pollId: string): { voter_jid: string; voter_name: string; options: string[] }[] {
    const rows = this.db.prepare('SELECT voter_jid, voter_name, options FROM poll_votes WHERE poll_id = ?')
      .all(pollId) as { voter_jid: string; voter_name: string; options: string }[];
    return rows.map(r => ({ ...r, options: JSON.parse(r.options ?? '[]') as string[] }));
  }

  // ---- group summary ----
  getSummary(chatJid: string): { summary: string; last_message_ts: number } | undefined {
    return this.db.prepare('SELECT summary, last_message_ts FROM group_summary WHERE chat_jid = ?').get(chatJid) as any;
  }

  setSummary(chatJid: string, summary: string, lastMessageTs: number): void {
    this.db.prepare(`
      INSERT INTO group_summary(chat_jid, summary, last_message_ts, updated_at) VALUES(?, ?, ?, ?)
      ON CONFLICT(chat_jid) DO UPDATE SET summary = excluded.summary,
        last_message_ts = excluded.last_message_ts, updated_at = excluded.updated_at
    `).run(chatJid, summary, lastMessageTs, Date.now());
  }

  // ---- stats ----
  bumpStat(key: string, delta = 1): void {
    this.db.prepare(`
      INSERT INTO stats(key, value) VALUES(?, ?)
      ON CONFLICT(key) DO UPDATE SET value = value + excluded.value
    `).run(key, delta);
  }

  getStats(): Record<string, number> {
    const rows = this.db.prepare('SELECT key, value FROM stats').all() as { key: string; value: number }[];
    return Object.fromEntries(rows.map(r => [r.key, r.value]));
  }

  /** Images generated today (resets at local midnight). Returns the count after optional increment. */
  imagesToday(increment = false): number {
    const today = new Date().toISOString().slice(0, 10);
    if (this.getConfig('img_count_date') !== today) {
      this.setConfig('img_count_date', today);
      this.setConfig('img_count_today', '0');
    }
    let n = Number(this.getConfig('img_count_today') ?? '0');
    if (increment) {
      n += 1;
      this.setConfig('img_count_today', String(n));
    }
    return n;
  }

  // ---- decisions ----
  insertDecision(chatJid: string | null, tier: string, decision: string, reason: string, tokensIn = 0, tokensOut = 0): void {
    this.db.prepare(
      'INSERT INTO decisions(ts, chat_jid, tier, decision, reason, tokens_in, tokens_out) VALUES(?, ?, ?, ?, ?, ?, ?)'
    ).run(Date.now(), chatJid, tier, decision, reason, tokensIn, tokensOut);
  }

  getRecentDecisions(limit: number, chatJid?: string | null): any[] {
    if (chatJid) {
      return this.db.prepare('SELECT * FROM decisions WHERE chat_jid = ? ORDER BY ts DESC LIMIT ?')
        .all(chatJid, limit).reverse();
    }
    return this.db.prepare('SELECT * FROM decisions ORDER BY ts DESC LIMIT ?').all(limit).reverse();
  }
}
