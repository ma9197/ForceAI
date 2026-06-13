import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { downloadMediaMessage, type WASocket } from 'baileys';
import { MEMORY, STICKER_DIR } from '../config.js';
import { logger, waLogger } from '../logger.js';
import type { Repo } from '../memory/repo.js';
import type { Outbound } from '../wa/outbound.js';
import type { NormalizedMessage } from '../types.js';
import type { PromptBuilder } from '../ai/prompts.js';

type LearnPhase = 'IDLE' | 'AWAITING_STICKER' | 'AWAITING_DESCRIPTION';

export interface StickerEvents {
  onSticker(id: number, description: string | null): void;
}

/**
 * Sticker teaching via the user's self-chat ("message yourself"):
 *   "Sticker" → send a sticker → describe it → saved to the library.
 */
export class StickerLearning {
  private phase: LearnPhase = 'IDLE';
  private pendingStickerId: number | null = null;
  private timeout: NodeJS.Timeout | null = null;

  constructor(
    private repo: Repo,
    private outbound: Outbound,
    private prompts: PromptBuilder,
    private events: StickerEvents,
    private getSock: () => WASocket | null,
  ) {}

  /** Handle a message in the self-chat. Returns true if it was part of the learning flow. */
  async onSelfChatMessage(m: NormalizedMessage): Promise<boolean> {
    if (m.isBot) return false;

    if (this.phase === 'IDLE') {
      if (m.type === 'text' && /^sticker$/i.test(m.text.trim())) {
        this.phase = 'AWAITING_STICKER';
        this.armTimeout();
        await this.outbound.sendText(m.chatJid, 'sticker learning mode 🫡 send me the sticker', { skipTyping: true });
        return true;
      }
      return false;
    }

    if (this.phase === 'AWAITING_STICKER') {
      if (m.type !== 'sticker') {
        if (m.type === 'text' && /^(cancel|stop)$/i.test(m.text.trim())) {
          this.reset();
          await this.outbound.sendText(m.chatJid, 'aight cancelled 💀', { skipTyping: true });
          return true;
        }
        await this.outbound.sendText(m.chatJid, 'bro send a STICKER 💀 (or "cancel")', { skipTyping: true });
        return true;
      }
      try {
        const sock = this.getSock();
        const buffer = await downloadMediaMessage(m.raw, 'buffer', {}, sock ? {
          logger: waLogger,
          reuploadRequest: sock.updateMediaMessage,
        } : undefined as any);
        const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
        const filePath = path.join(STICKER_DIR, `${sha256.slice(0, 16)}.webp`);
        fs.writeFileSync(filePath, buffer);
        const { id, existed } = this.repo.insertSticker(filePath, sha256);
        this.pendingStickerId = id;
        this.phase = 'AWAITING_DESCRIPTION';
        this.armTimeout();
        await this.outbound.sendText(
          m.chatJid,
          existed
            ? 'already know this one 👀 send me a new description and i\'ll update it'
            : 'got it 🔥 now tell me what it means / when i should use it',
          { skipTyping: true },
        );
      } catch (err) {
        logger.error({ err }, 'sticker download failed');
        this.reset();
        await this.outbound.sendText(m.chatJid, 'couldn\'t download that one 💀 try again with "Sticker"', { skipTyping: true });
      }
      return true;
    }

    if (this.phase === 'AWAITING_DESCRIPTION') {
      if (m.type !== 'text' || !m.text.trim()) {
        await this.outbound.sendText(m.chatJid, 'describe it with words bro 💀', { skipTyping: true });
        return true;
      }
      const id = this.pendingStickerId!;
      this.repo.setStickerDescription(id, m.text.trim(), null);
      this.prompts.memoryVersion += 1;
      this.events.onSticker(id, m.text.trim());
      this.reset();
      await this.outbound.sendText(m.chatJid, `saved 🫡 sticker #${id}: "${m.text.trim()}". send "Sticker" to teach me another`, { skipTyping: true });
      return true;
    }

    return false;
  }

  private armTimeout(): void {
    if (this.timeout) clearTimeout(this.timeout);
    this.timeout = setTimeout(() => this.reset(), MEMORY.STICKER_LEARN_TIMEOUT);
  }

  private reset(): void {
    this.phase = 'IDLE';
    this.pendingStickerId = null;
    if (this.timeout) {
      clearTimeout(this.timeout);
      this.timeout = null;
    }
  }
}
