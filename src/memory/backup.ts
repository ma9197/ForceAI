import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { Readable } from 'node:stream';
import type Database from 'better-sqlite3';
import { logger } from '../logger.js';

const LIVE_DB_FILES = new Set(['forceai.db', 'forceai.db-wal', 'forceai.db-shm']);

/**
 * The whole data/ folder as a tar.gz stream, in the same layout /api/admin/import extracts, so a
 * download can be imported back as is. The live DB is swapped for a consistent snapshot (VACUUM INTO)
 * because copying the open file could miss what is still in the WAL. Holds the WhatsApp login and
 * the API keys: owner-only. `onDone` runs once tar has written the whole archive.
 */
export function createBackupArchive(db: Database.Database, dataDir: string, onDone?: () => void): Readable {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forceai-backup-'));
  try {
    db.prepare('VACUUM INTO ?').run(path.join(tmp, 'forceai.db'));
  } catch (err) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw err;
  }
  // leftovers like _import.tar.gz start with "_"
  const entries = fs.readdirSync(dataDir).filter(n => !LIVE_DB_FILES.has(n) && !n.startsWith('_'));
  const args = ['-czf', '-', ...(entries.length ? ['-C', dataDir, ...entries] : []), '-C', tmp, 'forceai.db'];
  const child = spawn('tar', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.on('data', (d: Buffer) => logger.warn({ tar: d.toString().trim() }, 'backup: tar warning'));
  child.on('close', (code) => {
    fs.rmSync(tmp, { recursive: true, force: true });
    if (code === 0) {
      logger.info({ entries: entries.length }, 'backup download finished');
      onDone?.();
    } else logger.error({ code }, 'backup: tar failed, the download is incomplete');
  });
  child.on('error', (err) => {
    fs.rmSync(tmp, { recursive: true, force: true });
    logger.error({ err }, 'backup: could not start tar');
  });
  return child.stdout;
}
