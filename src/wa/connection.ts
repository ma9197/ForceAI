import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  jidNormalizedUser,
  type WASocket,
  type WAMessage,
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

  /** set by App: lets Baileys re-fetch a sent message for decrypt retries / resends */
  getStoredMessage: ((id: string) => any | undefined) | null = null;

  async start(): Promise<void> {
    this.stopped = false;
    await this.connect();
  }

  /** Fully disconnect the WhatsApp socket (linked device goes offline) WITHOUT logging out —
   *  creds stay on disk so start() resumes the same session with no QR. */
  async stop(): Promise<void> {
    this.stopped = true;
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

  private async connect(): Promise<void> {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

    const sock = makeWASocket({
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
        this.reconnectDelay = 1000;
        this.setState('open');
        this.emit('ready', sock);
        logger.info({ user: sock.user?.id, lid: sock.user?.lid }, 'WhatsApp connection open');
      }

      if (connection === 'close') {
        const statusCode = (lastDisconnect?.error as Boom | undefined)?.output?.statusCode;
        if (this.stopped) return;

        if (statusCode === DisconnectReason.loggedOut) {
          logger.warn('logged out — wiping auth state, QR required');
          fs.rmSync(AUTH_DIR, { recursive: true, force: true });
          fs.mkdirSync(AUTH_DIR, { recursive: true });
          this.setState('logged_out');
          setTimeout(() => this.connect().catch(e => logger.error(e)), 1000);
          return;
        }

        if (statusCode === DisconnectReason.restartRequired) {
          // Expected right after the first QR scan — reconnect immediately.
          logger.info('restart required (normal post-QR) — reconnecting');
          this.connect().catch(e => logger.error(e));
          return;
        }

        this.setState('closed');
        const delay = this.reconnectDelay;
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000);
        logger.warn({ statusCode, delay }, 'connection closed — reconnecting with backoff');
        setTimeout(() => this.connect().catch(e => logger.error(e)), delay);
      }
    });

    sock.ev.on('messages.upsert', ({ messages, type }) => {
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
