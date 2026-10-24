import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { PRICING, VOICE_PROFILE, VOICE_PROFILE_MODEL } from '../config.js';
import { logger } from '../logger.js';
import type { AiClient } from '../ai/client.js';
import { VOICE_ANONYMIZER_SYSTEM } from '../ai/prompts.js';
import { VoiceAnonymizeSchema } from '../ai/schemas.js';

/**
 * Fresh start: ForceAI keeps how the group talks (voice items, stickers, every setting) but forgets
 * the people, its own attitude and the old chats. The DB part is synchronous and runs in one
 * transaction; the AI name-removal pass runs before it (see App.freshStart for the order).
 */

/** Voice categories that survive (the group's style). member_style (how each friend texts) is wiped. */
export const KEEP_VOICE_CATEGORIES = ['phrase', 'slang', 'joke', 'reference', 'pattern'] as const;
const KEEP_IN = KEEP_VOICE_CATEGORIES.map(c => `'${c}'`).join(', ');

/** Emptied completely. Order matters: facts before members (facts.member_jid references members). */
const WIPE_TABLES = [
  'facts', 'group_summary',
  'member_reports', 'member_stat_history', 'member_stat_locks', 'member_observations', 'member_ignored', 'members',
  'influence_lessons', 'initiative_principles',
  'messages', 'bot_messages', 'decisions', 'poll_votes',
] as const;
/** Untouched; counted so the log proves it. (config is kept too, minus the keys handled below.) */
const KEEP_TABLES = ['stickers', 'stats', 'lid_pn_map', 'config'] as const;

export const CONFIRM_PHRASE = 'FRESH START';
/** Fresh start needs a backup downloaded this recently (owner rule: never wipe without a backup). */
export const BACKUP_MAX_AGE_MS = 24 * 3_600_000;

export type RowCounts = Record<string, number>;

export function countRows(db: Database.Database): RowCounts {
  const n = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
  const out: RowCounts = {};
  for (const t of [...WIPE_TABLES, ...KEEP_TABLES]) out[t] = n(`SELECT COUNT(*) AS n FROM ${t}`);
  out.voice_kept = n(`SELECT COUNT(*) AS n FROM voice_items WHERE category IN (${KEEP_IN}) AND superseded_by IS NULL`);
  out.voice_old_versions = n('SELECT COUNT(*) AS n FROM voice_items WHERE superseded_by IS NOT NULL');
  out.voice_member_style = n("SELECT COUNT(*) AS n FROM voice_items WHERE category = 'member_style' AND superseded_by IS NULL");
  out.voice_linked_to_person = n('SELECT COUNT(*) AS n FROM voice_items WHERE member_jid IS NOT NULL');
  out.voice_overviews = n("SELECT COUNT(*) AS n FROM config WHERE key GLOB 'voice_overview:*'");
  return out;
}

export interface KeptVoiceItem { id: number; category: string; content: string; example: string | null }
export interface VoiceRewrite { id: number; content: string; example: string | null }

/** The active voice items that survive, i.e. what the AI pass checks for names. */
export function getKeptVoiceItems(db: Database.Database): KeptVoiceItem[] {
  return db.prepare(
    `SELECT id, category, content, example FROM voice_items WHERE category IN (${KEEP_IN}) AND superseded_by IS NULL ORDER BY id`,
  ).all() as KeptVoiceItem[];
}

/** Every name ForceAI knows a person by (hints for the AI pass; it also catches nicknames itself). */
export function getKnownNames(db: Database.Database): string[] {
  const rows = db.prepare("SELECT DISTINCT display_name AS name FROM members WHERE display_name IS NOT NULL AND TRIM(display_name) != ''").all() as { name: string }[];
  return rows.map(r => r.name.trim());
}

const REWRITE_CHUNK = 60;

/** Rough cost of the AI pass in USD, shown before the owner confirms. */
export function estimateRewriteCostUsd(items: KeptVoiceItem[]): number {
  if (items.length === 0) return 0;
  const p = PRICING[VOICE_PROFILE_MODEL];
  const chars = items.reduce((sum, i) => sum + i.content.length + (i.example?.length ?? 0) + 20, 0);
  const inTok = chars / 3.5 + Math.ceil(items.length / REWRITE_CHUNK) * 700;
  const outTok = (chars / 3.5) * 0.6; // most items come back only if they named someone
  return (inTok * p.in + outTok * p.out) / 1_000_000;
}

/**
 * AI pass: rewrites kept items that name or point to a person. Returns only real changes.
 * Throws on any failure so the caller aborts before touching the DB.
 */
export async function anonymizeVoiceItems(ai: AiClient, items: KeptVoiceItem[], names: string[]): Promise<VoiceRewrite[]> {
  const out: VoiceRewrite[] = [];
  const nameList = names.length ? names.map(n => `- ${n}`).join('\n') : '(none saved; still look for names and nicknames)';
  for (let i = 0; i < items.length; i += REWRITE_CHUNK) {
    const chunk = items.slice(i, i + REWRITE_CHUNK);
    const byId = new Map(chunk.map(it => [it.id, it]));
    const list = chunk.map(it => `[id ${it.id}] (${it.category}) ${it.content}${it.example ? ` | example: ${it.example}` : ''}`).join('\n');

    const response = await ai.client.messages.parse({
      model: VOICE_PROFILE_MODEL,
      max_tokens: VOICE_PROFILE.MAX_OUTPUT_TOKENS,
      system: VOICE_ANONYMIZER_SYSTEM,
      messages: [{
        role: 'user',
        content: `PEOPLE'S NAMES (remove these and any nickname for them):\n${nameList}\n\nITEMS:\n${list}`,
      }],
      output_config: { format: zodOutputFormat(VoiceAnonymizeSchema) },
    });
    ai.recordUsage(VOICE_PROFILE_MODEL, response.usage, 'voice');
    if (response.stop_reason === 'max_tokens') throw new Error('the AI answer was cut off');
    const parsed = response.parsed_output;
    if (!parsed) throw new Error('the AI returned no usable answer');

    for (const r of parsed.items) {
      const orig = byId.get(r.id);
      const content = r.content?.trim();
      if (!orig || !content) continue; // unknown id or empty text: keep the original
      const example = r.example?.trim() || null;
      if (content === orig.content && example === orig.example) continue;
      out.push({ id: r.id, content, example });
    }
    logger.info({ chunk: chunk.length, changed: out.length }, 'fresh start: voice items checked for names');
  }
  return out;
}

/** Bytes the DB needs for a full copy (live pages, not the file size). */
export function dbBytes(db: Database.Database): number {
  const pages = db.pragma('page_count', { simple: true }) as number;
  const size = db.pragma('page_size', { simple: true }) as number;
  return pages * size;
}

/** Free bytes on the disk holding `dir`, or null when the platform can't tell. */
export function freeBytes(dir: string): number | null {
  try {
    const s = fs.statfsSync(dir);
    return s.bavail * s.bsize;
  } catch {
    return null;
  }
}

/** Consistent copy of the live DB (WAL included) next to it. Returns the new file's path. */
export function backupDb(db: Database.Database, dir: string, now: number): string {
  const stamp = new Date(now).toISOString().slice(0, 16).replace(/[:T]/g, '-');
  const file = path.join(dir, `forceai.db.pre-fresh-start-${stamp}`);
  db.prepare('VACUUM INTO ?').run(file);
  return file;
}

export interface WipeResult { before: RowCounts; after: RowCounts; rewritten: number; merged: number }

/** The wipe itself: one transaction, so it either fully happens or not at all. */
export function wipeMemory(db: Database.Database, opts: { now: number; rewrites: VoiceRewrite[]; groups: string[] }): WipeResult {
  const before = countRows(db);
  let rewritten = 0;
  let merged = 0;

  db.transaction(() => {
    // 1. kept voice items: apply the AI rewrites (rewritten ones show as unreviewed in the Voice tab)
    const update = db.prepare(
      `UPDATE voice_items SET content = ?, example = ?, checked = 0 WHERE id = ? AND category IN (${KEEP_IN}) AND superseded_by IS NULL`,
    );
    const remove = db.prepare('DELETE FROM voice_items WHERE id = ?');
    for (const r of opts.rewrites) {
      try {
        rewritten += update.run(r.content, r.example, r.id).changes;
      } catch {
        remove.run(r.id); // the anonymous version already exists in this group: keep that one
        merged += 1;
      }
    }
    // old versions are never shown or used, and may still name people
    db.exec('DELETE FROM voice_items WHERE superseded_by IS NOT NULL');
    db.exec("DELETE FROM voice_items WHERE category = 'member_style'");
    db.exec('UPDATE voice_items SET member_jid = NULL WHERE member_jid IS NOT NULL'); // no link to a person

    // 2. people, facts, attitude, old chats
    for (const t of WIPE_TABLES) db.exec(`DELETE FROM ${t}`);

    // 3. config: voice overview goes, mood resets, settings stay
    db.exec("DELETE FROM config WHERE key GLOB 'voice_overview:*'");
    const set = db.prepare('INSERT INTO config(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    set.run('persona_mode', 'default');
    set.run('persona_custom', '');

    // 4. learner checkpoints at the wipe time, so nothing relearns from before it
    const ts = String(opts.now);
    db.prepare("UPDATE config SET value = ? WHERE key GLOB 'extract_ts_*' OR key GLOB 'voice_ts_*'").run(ts);
    for (const jid of opts.groups) {
      set.run(`extract_ts_${jid}`, ts);
      set.run(`voice_ts_${jid}`, ts);
    }
    set.run('member_report_ts', ts);
    set.run('fresh_start_at', ts);
  })();

  return { before, after: countRows(db), rewritten, merged };
}

/** Downloaded chat images (data/images). Sticker files live in data/stickers and are never touched. */
export function countImages(dir: string): number {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isFile()).length;
  } catch {
    return 0;
  }
}

export function clearImages(dir: string): number {
  let removed = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isFile()) continue;
    try { fs.rmSync(path.join(dir, e.name)); removed += 1; } catch (err) { logger.warn({ err, file: e.name }, 'fresh start: image not removed'); }
  }
  return removed;
}
