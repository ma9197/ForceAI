import makeWASocket, {
  DisconnectReason,
  fetchLatestWaWebVersion,
  useMultiFileAuthState,
  jidNormalizedUser,
  type WASocket,
  type WAMessage,
  type WAVersion,
} from 'baileys';
import type { Boom } from '@hapi/boom';
import QRCode from 'qrcode';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { AUTH_DIR } from '../config.js';
import { logger, waLogger } from '../logger.js';

export type ConnState = 'waiting_qr' | 'connecting' | 'open' | 'closed' | 'logged_out' | 'offline';

/**
 * Owns the Baileys socket lifecycle: QR, auth persistence, reconnect with backoff.
 * Emits: 'qr' (dataUrl), 'state' (ConnState), 'ready' (socket), 'messages' (WAMessage[], type)
 */
export class WaConnection extends EventEmitter {
  sock: WASocket | null = null;
  state: ConnState = 'connecting';
  private reconnectDelay = 1000;
  private stopped = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private openedAt = 0;
  /** last time WhatsApp closed the connection, and how many drops in a row (shown in the dashboard) */
  lastClose: { code: number | null; reason: string; at: number; streak: number } | null = null;
  private waVersion: { version: WAVersion; at: number } | null = null;

  /** set by App: lets Baileys re-fetch a sent message for decrypt retries / resends */
  getStoredMessage: ((id: string) => any | undefined) | null = null;

  async start(): Promise<void> {
    this.stopped = false;
    await this.connect();
  }

  /** The one place a reconnect is scheduled: a newer schedule replaces an older one, so two sockets
   *  can never be opened for the same login (they would kick each other off forever: 440). */
  private scheduleReconnect(ms: number): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch(e => logger.error(e));
    }, ms);
  }

  /** Fully disconnect the WhatsApp socket (linked device goes offline) WITHOUT logging out —
   *  creds stay on disk so start() resumes the same session with no QR. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    try { this.sock?.end(undefined); } catch { /* ignore */ }
    this.sock = null;
    this.setState('offline');
  }

  get ownJid(): string | undefined {
    return this.sock?.user?.id ? jidNormalizedUser(this.sock.user.id) : undefined;
  }

  get ownLid(): string | undefined {
    return this.sock?.user?.lid ? jidNormalizedUser(this.sock.user.lid) : undefined;
  }

  /** Mark offline without an active socket (used when booting in shutdown state). */
  setOffline(): void {
    this.stopped = true;
    this.setState('offline');
  }

  private setState(s: ConnState): void {
    if (this.state !== s) {
      this.state = s;
      this.emit('state', s);
    }
  }

  /**
   * The WhatsApp Web build to announce. Baileys rc13's built-in build (2.3000.1035194821) is too old:
   * WhatsApp closes the socket with 405 before any QR (Baileys issue #2679). So ask web.whatsapp.com
   * for the live build, cache it 6 h, keep the last good one on failure, else fall back to Baileys'.
   */
  private async resolveVersion(): Promise<WAVersion | undefined> {
    if (this.waVersion && Date.now() - this.waVersion.at < 6 * 3_600_000) return this.waVersion.version;
    const res = await fetchLatestWaWebVersion({ signal: AbortSignal.timeout(10_000) });
    if (res.isLatest) {
      this.waVersion = { version: res.version, at: Date.now() };
      logger.info({ version: res.version.join('.') }, 'using live WhatsApp Web version');
      return res.version;
    }
    logger.warn({ error: String((res.error as Error)?.message ?? res.error) }, 'live WhatsApp Web version unavailable, using the last known one');
    return this.waVersion?.version;
  }

  private async connect(): Promise<void> {
    if (this.stopped) return; // a reconnect that fires after Power off must not open a socket
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const version = await this.resolveVersion();
    if (this.stopped) return;
    // never two sockets: close the previous one first (its late events are ignored below)
    const previous = this.sock;
    this.sock = null;
    try { previous?.end(undefined); } catch { /* ignore */ }

    const sock = makeWASocket({
      ...(version ? { version } : {}),
      auth: state,
      logger: waLogger,
      markOnlineOnConnect: false, // don't suppress phone notifications; less bot-like
      syncFullHistory: false,
      getMessage: async (key) => {
        if (!key.id || !this.getStoredMessage) return undefined;
        return this.getStoredMessage(key.id);
      },
    });
    this.sock = sock;
    this.setState('connecting');

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      if (this.sock !== sock) return; // an old, replaced socket: its events must not reconnect anything
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        this.setState('waiting_qr');
        try {
          const dataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 300 });
          this.emit('qr', dataUrl);
        } catch (err) {
          logger.error({ err }, 'failed to render QR');
        }
      }

      if (connection === 'open') {
        this.openedAt = Date.now();
        this.setState('open');
        // Tell WhatsApp this linked device is NOT actively being watched, so the phone keeps
        // playing notification sounds (an active companion device silences them otherwise).
        try { await sock.sendPresenceUpdate('unavailable'); } catch { /* ignore */ }
        this.emit('ready', sock);
        logger.info({ user: sock.user?.id, lid: sock.user?.lid }, 'WhatsApp connection open');
      }

      if (connection === 'close') {
        const statusCode = (lastDisconnect?.error as Boom | undefined)?.output?.statusCode;
        if (this.stopped) return;
        // only a connection that stayed up for a minute resets the backoff, so a kick right after
        // every connect slows down instead of flapping every second
        if (this.openedAt && Date.now() - this.openedAt > 60_000) this.reconnectDelay = 1000;
        this.openedAt = 0;
        this.lastClose = {
          code: statusCode ?? null,
          reason: closeReason(statusCode, lastDisconnect?.error?.message),
          at: Date.now(),
          streak: (this.lastClose && Date.now() - this.lastClose.at < 10 * 60_000 ? this.lastClose.streak : 0) + 1,
        };

        if (statusCode === DisconnectReason.loggedOut) {
          logger.warn('logged out — wiping auth state, QR required');
          fs.rmSync(AUTH_DIR, { recursive: true, force: true });
          fs.mkdirSync(AUTH_DIR, { recursive: true });
          this.setState('logged_out');
          this.scheduleReconnect(1000);
          return;
        }

        if (statusCode === 405) this.waVersion = null; // "client too old": re-read the live version next time

        if (statusCode === DisconnectReason.restartRequired) {
          // Expected right after the first QR scan — reconnect immediately.
          logger.info('restart required (normal post-QR), reconnecting');
          this.scheduleReconnect(0);
          return;
        }

        this.setState('closed');
        // 440 = this login was opened somewhere else (another running copy of the bot, e.g. on a PC).
        // Fighting back every second just kicks each other forever, so wait much longer.
        const replaced = statusCode === DisconnectReason.connectionReplaced;
        const delay = replaced ? Math.max(this.reconnectDelay, 30_000) : this.reconnectDelay;
        this.reconnectDelay = Math.min(delay * 2, replaced ? 300_000 : 30_000);
        logger.warn({ statusCode, reason: this.lastClose.reason, streak: this.lastClose.streak, delay }, 'connection closed, reconnecting with backoff');
        this.scheduleReconnect(delay);
      }
    });

    sock.ev.on('messages.upsert', ({ messages, type }) => {
      if (this.sock !== sock) return;
      this.emit('messages', messages as WAMessage[], type);
    });

    sock.ev.on('lid-mapping.update', (mapping: unknown) => {
      this.emit('lid-mapping', mapping);
    });

    sock.ev.on('group-participants.update', (update) => {
      this.emit('group-participants', update);
    });
  }
}

/** Plain-words reason for a WhatsApp disconnect code (shown in the dashboard). */
function closeReason(code: number | undefined, message?: string): string {
  switch (code) {
    case DisconnectReason.connectionReplaced: return 'another device or copy of the bot opened this WhatsApp login';
    case DisconnectReason.loggedOut: return 'logged out from the phone';
    case DisconnectReason.restartRequired: return 'restart required (normal after scanning the QR)';
    case DisconnectReason.connectionClosed: return 'connection closed by WhatsApp';
    case DisconnectReason.connectionLost: return 'connection lost or timed out';
    case DisconnectReason.badSession: return 'bad session';
    case DisconnectReason.multideviceMismatch: return 'multi-device mismatch';
    case DisconnectReason.unavailableService: return 'WhatsApp service unavailable';
    case 405: return 'WhatsApp rejected the app version';
    default: return message ? `code ${code ?? '?'}: ${message.slice(0, 80)}` : `code ${code ?? '?'}`;
  }
}
