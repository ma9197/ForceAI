import type Database from 'better-sqlite3';
import type { FactRow, MemberRow, MemberCodeStats, MemberReportRow, MemberStatHistoryRow, NormalizedMessage, StickerRow } from '../types.js';
import { REPORT } from '../config.js';

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

  /**
   * All active slang/vocab items across EVERY group. Slang is shared brain-wide — a word the bot
   * learns in one chat is usable everywhere — while storage stays per-group for provenance/management.
   */
  getAllSlang(): import('../types.js').VoiceItemRow[] {
    return this.db.prepare(
      "SELECT * FROM voice_items WHERE category = 'slang' AND superseded_by IS NULL ORDER BY created_at ASC"
    ).all() as import('../types.js').VoiceItemRow[];
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

  // ---- member reports (per-PERSON dossiers, global across groups) ----

  /** Every real human who has spoken in any group (excludes the bot + owner). */
  getPeople(): MemberRow[] {
    return this.db.prepare(`
      SELECT * FROM members WHERE jid IN (
        SELECT DISTINCT sender_jid FROM messages WHERE is_bot = 0 AND is_owner = 0
      ) ORDER BY message_count DESC
    `).all() as MemberRow[];
  }

  /** Which groups a person appears in (+ how much), for the profile view. */
  getMemberGroups(memberJid: string): { chat_jid: string; count: number }[] {
    return this.db.prepare(`
      SELECT chat_jid, COUNT(*) AS count FROM messages
      WHERE sender_jid = ? AND is_bot = 0 AND is_owner = 0
      GROUP BY chat_jid ORDER BY count DESC
    `).all(memberJid) as { chat_jid: string; count: number }[];
  }

  /**
   * Token-free analytics for every human, computed in one pass over the recent message log.
   * Cross-group: a person's stats pool every group they're in. Bounded by REPORT.CODE_STATS_WINDOW_DAYS.
   */
  computeAllCodeStats(): Map<string, MemberCodeStats> {
    const dayMs = 86_400_000;
    const sinceTs = Date.now() - REPORT.CODE_STATS_WINDOW_DAYS * dayMs;
    const sparkStart = Date.now() - REPORT.SPARKLINE_DAYS * dayMs;
    const rows = this.db.prepare(`
      SELECT id, chat_jid, sender_jid, text, type, quoted_id, ts
        FROM messages
        WHERE is_bot = 0 AND is_owner = 0 AND type != 'reaction' AND ts > ?
        ORDER BY chat_jid, ts ASC
    `).all(sinceTs) as Array<{ id: string; chat_jid: string; sender_jid: string; text: string | null; type: string; quoted_id: string | null; ts: number }>;

    const emojiRe = /\p{Extended_Pictographic}/gu;
    type Acc = {
      count: number; starts: number; contributions: number;
      lenSum: number; textCount: number; emoji: number; questions: number;
      hours: number[]; days: number[]; spark: number[]; replies: Map<string, number>;
    };
    const acc = new Map<string, Acc>();
    const senderOf = new Map<string, string>(); // message id -> sender, for reply-network resolution
    const get = (jid: string): Acc => {
      let a = acc.get(jid);
      if (!a) {
        a = { count: 0, starts: 0, contributions: 0, lenSum: 0, textCount: 0, emoji: 0, questions: 0,
          hours: new Array(24).fill(0), days: new Array(7).fill(0), spark: new Array(REPORT.SPARKLINE_DAYS).fill(0), replies: new Map() };
        acc.set(jid, a);
      }
      return a;
    };

    let curGroup = '';
    let lastTs = 0; // last message ts within the current group (for the quiet-timer)
    for (const m of rows) {
      senderOf.set(m.id, m.sender_jid);
      if (m.chat_jid !== curGroup) { curGroup = m.chat_jid; lastTs = 0; }
      const a = get(m.sender_jid);
      a.count += 1;

      // starter vs contributor: a non-reply after group silence kicks off a conversation
      const quiet = lastTs === 0 || (m.ts - lastTs) > REPORT.QUIET_MS;
      const isReply = !!m.quoted_id;
      if (quiet && !isReply) a.starts += 1; else a.contributions += 1;
      lastTs = m.ts;

      const d = new Date(m.ts);
      a.hours[d.getHours()] += 1;
      a.days[d.getDay()] += 1;
      if (m.ts >= sparkStart) {
        const bucket = Math.min(REPORT.SPARKLINE_DAYS - 1, Math.floor((m.ts - sparkStart) / dayMs));
        a.spark[bucket] += 1;
      }

      const text = m.text ?? '';
      if (text) {
        a.textCount += 1;
        a.lenSum += text.length;
        if (text.includes('?')) a.questions += 1;
        const em = text.match(emojiRe);
        if (em) a.emoji += em.length;
      }

      if (isReply && m.quoted_id) {
        const target = senderOf.get(m.quoted_id);
        if (target && target !== m.sender_jid) a.replies.set(target, (a.replies.get(target) ?? 0) + 1);
      }
    }

    const argmax = (arr: number[]): number | null => {
      let bi = -1, bv = 0;
      for (let i = 0; i < arr.length; i++) if (arr[i] > bv) { bv = arr[i]; bi = i; }
      return bi >= 0 ? bi : null;
    };
    const out = new Map<string, MemberCodeStats>();
    for (const [jid, a] of acc) {
      const denom = a.starts + a.contributions;
      out.set(jid, {
        messages_total: this.getMember(jid)?.message_count ?? a.count,
        messages_window: a.count,
        starts: a.starts,
        contributions: a.contributions,
        starter_ratio: denom > 0 ? a.starts / denom : 0,
        top_hour: argmax(a.hours),
        top_day: argmax(a.days),
        sparkline: a.spark,
        avg_len: a.textCount > 0 ? Math.round(a.lenSum / a.textCount) : 0,
        emoji_rate: a.textCount > 0 ? a.emoji / a.textCount : 0,
        question_rate: a.textCount > 0 ? a.questions / a.textCount : 0,
        reply_network: [...a.replies.entries()].sort((x, y) => y[1] - x[1]).slice(0, 5).map(([j, c]) => ({ jid: j, count: c })),
      });
    }
    return out;
  }

  // ---- weekly report snapshots (written by the reporter job in phase 2) ----
  getLatestReport(memberJid: string): MemberReportRow | undefined {
    return this.db.prepare(
      'SELECT * FROM member_reports WHERE member_jid = ? ORDER BY week_start DESC LIMIT 1'
    ).get(memberJid) as MemberReportRow | undefined;
  }

  /** Newest value for each tracked stat. */
  getLatestStats(memberJid: string): MemberStatHistoryRow[] {
    return this.db.prepare(`
      SELECT h.* FROM member_stat_history h
      JOIN (SELECT stat_key, MAX(week_start) AS mw FROM member_stat_history WHERE member_jid = ? GROUP BY stat_key) t
        ON h.stat_key = t.stat_key AND h.week_start = t.mw
      WHERE h.member_jid = ?
    `).all(memberJid, memberJid) as MemberStatHistoryRow[];
  }

  /** Full weekly timeline for one stat (drives the expandable history). */
  getStatHistory(memberJid: string, statKey: string): MemberStatHistoryRow[] {
    return this.db.prepare(
      'SELECT * FROM member_stat_history WHERE member_jid = ? AND stat_key = ? ORDER BY week_start ASC'
    ).all(memberJid, statKey) as MemberStatHistoryRow[];
  }

  insertMemberReport(memberJid: string, weekStart: number, bio: string | null, summary: string | null, talkingStyle: string | null): void {
    this.db.prepare(`
      INSERT INTO member_reports(member_jid, week_start, bio, summary, talking_style, created_at)
      VALUES(?, ?, ?, ?, ?, ?)
      ON CONFLICT(member_jid, week_start) DO UPDATE SET
        bio = excluded.bio, summary = excluded.summary, talking_style = excluded.talking_style
    `).run(memberJid, weekStart, bio, summary, talkingStyle, Date.now());
  }

  insertStatSnapshot(memberJid: string, weekStart: number, statKey: string, value: number, label: string | null, reason: string | null): void {
    this.db.prepare(`
      INSERT INTO member_stat_history(member_jid, week_start, stat_key, value, label, reason, created_at)
      VALUES(?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(member_jid, week_start, stat_key) DO UPDATE SET
        value = excluded.value, label = excluded.label, reason = excluded.reason
    `).run(memberJid, weekStart, statKey, value, label, reason, Date.now());
  }

  getStatLocks(memberJid: string): string[] {
    return (this.db.prepare('SELECT stat_key FROM member_stat_locks WHERE member_jid = ?').all(memberJid) as { stat_key: string }[]).map(r => r.stat_key);
  }

  setStatLock(memberJid: string, statKey: string, locked: boolean): void {
    if (locked) this.db.prepare('INSERT OR IGNORE INTO member_stat_locks(member_jid, stat_key) VALUES(?, ?)').run(memberJid, statKey);
    else this.db.prepare('DELETE FROM member_stat_locks WHERE member_jid = ? AND stat_key = ?').run(memberJid, statKey);
  }

  deleteMemberReport(memberJid: string): void {
    this.db.prepare('DELETE FROM member_reports WHERE member_jid = ?').run(memberJid);
    this.db.prepare('DELETE FROM member_stat_history WHERE member_jid = ?').run(memberJid);
    this.db.prepare('DELETE FROM member_stat_locks WHERE member_jid = ?').run(memberJid);
  }

  // ForceAI's private per-reply observations (fuel for the weekly report)
  insertMemberObservation(memberJid: string, chatJid: string | null, observation: string): void {
    this.db.prepare('INSERT INTO member_observations(member_jid, chat_jid, observation, ts) VALUES(?, ?, ?, ?)')
      .run(memberJid, chatJid, observation, Date.now());
  }

  getMemberObservations(memberJid: string, sinceTs: number): { observation: string; ts: number }[] {
    return this.db.prepare(
      'SELECT observation, ts FROM member_observations WHERE member_jid = ? AND ts > ? ORDER BY ts ASC'
    ).all(memberJid, sinceTs) as { observation: string; ts: number }[];
  }

  pruneMemberObservations(beforeTs: number): void {
    this.db.prepare('DELETE FROM member_observations WHERE ts < ?').run(beforeTs);
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
