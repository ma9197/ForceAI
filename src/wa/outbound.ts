import fs from 'node:fs';
import { jidNormalizedUser, type WASocket, type WAMessage } from 'baileys';
import { DEFAULT_MSG_PREFIX, DEFAULT_MSG_SUFFIX, ELEVENLABS, IMAGE_GEN, OUTBOUND, resolveStickerPath, type ImageModelChoice } from '../config.js';
import { logger } from '../logger.js';
import { elevenLabsTts } from '../voice/tts.js';
import { geminiGenerateImage } from '../images/gen.js';
import type { AiClient } from '../ai/client.js';
import type { Repo } from '../memory/repo.js';
import type { BotAction } from '../types.js';
import type { MessageStore } from './store.js';

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

function jitter(base: number, ratio: number): number {
  return base * (1 - ratio + Math.random() * ratio * 2);
}

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

export interface SentInfo {
  action: BotAction;
  waMessage: WAMessage | null;
}

/**
 * Executes action plans sequentially with human-like pacing.
 * Single queue — two plans can never interleave.
 */
export class Outbound {
  private queue: Promise<void> = Promise.resolve();
  /** set by arbiter so it can abort remaining actions mid-plan */
  abortCurrentPlan = false;
  /** set by App: called with every message the bot sends (so it enters DB/feed without relying on echo) */
  onBotMessage: ((msg: WAMessage) => void) | null = null;

  constructor(
    private getSock: () => WASocket | null,
    private repo: Repo,
    private store: MessageStore,
    private ai: AiClient,
  ) {}

  /** Wrap bot text in the configured marker so members instantly see it's the AI, not the owner. */
  private decorate(text: string): string {
    const prefix = this.repo.getConfig('msg_prefix') ?? DEFAULT_MSG_PREFIX;
    const suffix = this.repo.getConfig('msg_suffix') ?? DEFAULT_MSG_SUFFIX;
    return `${prefix}${text}${suffix}`;
  }

  /** Send a plain text message immediately (intro, sticker-learning prompts). Still human-paced. */
  async sendText(chatJid: string, text: string, opts?: { skipTyping?: boolean }): Promise<WAMessage | null> {
    return this.enqueue(async () => {
      const sock = this.getSock();
      if (!sock) return null;
      const decorated = this.decorate(text);
      if (!opts?.skipTyping) await this.simulateTyping(sock, chatJid, decorated);
      const sent = await sock.sendMessage(chatJid, { text: decorated });
      this.recordBotMessage(sent ?? null);
      return sent ?? null;
    });
  }

  /** Execute a full action plan. onSent fires after each successful action. */
  async executePlan(
    chatJid: string,
    actions: BotAction[],
    onSent?: (info: SentInfo) => void,
  ): Promise<void> {
    this.abortCurrentPlan = false;
    return this.enqueue(async () => {
      const sock = this.getSock();
      if (!sock) return;

      let first = true;
      for (const action of actions) {
        if (action.type === 'nothing') continue;
        if (this.abortCurrentPlan) {
          logger.info('plan aborted mid-send (hard trigger arrived)');
          break;
        }
        if (!first) await sleep(rand(OUTBOUND.GAP_MIN, OUTBOUND.GAP_MAX));
        first = false;

        try {
          const sent = await this.executeOne(sock, chatJid, action);
          this.recordBotMessage(sent);
          onSent?.({ action, waMessage: sent });
        } catch (err) {
          logger.error({ err, action }, 'failed to execute action');
        }
      }
      if (this.typingOn()) { try { await sock.sendPresenceUpdate('paused', chatJid); } catch { /* ignore */ } }
    });
  }

  private async executeOne(sock: WASocket, chatJid: string, action: BotAction): Promise<WAMessage | null> {
    switch (action.type) {
      case 'message': {
        const text = this.decorate(action.text);
        await this.simulateTyping(sock, chatJid, text);
        return (await sock.sendMessage(chatJid, { text })) ?? null;
      }
      case 'reply': {
        const target = this.store.resolve(action.target_message_id);
        const text = this.decorate(action.text);
        await this.simulateTyping(sock, chatJid, text);
        if (target) {
          return (await sock.sendMessage(chatJid, { text }, { quoted: target })) ?? null;
        }
        // degrade: plain message if the target can't be resolved
        return (await sock.sendMessage(chatJid, { text })) ?? null;
      }
      case 'reaction': {
        const target = this.store.resolve(action.target_message_id);
        if (!target?.key) {
          logger.warn({ ref: action.target_message_id }, 'reaction target not found — skipping');
          return null;
        }
        await sleep(rand(OUTBOUND.REACT_MIN, OUTBOUND.REACT_MAX));
        return (await sock.sendMessage(chatJid, { react: { text: action.emoji, key: target.key } })) ?? null;
      }
      case 'sticker': {
        const sticker = this.repo.getSticker(action.sticker_id);
        const stickerFile = sticker ? resolveStickerPath(sticker.file_path) : '';
        if (!sticker || !fs.existsSync(stickerFile)) {
          logger.warn({ id: action.sticker_id }, 'sticker file not found — skipping');
          return null;
        }
        await sleep(rand(OUTBOUND.REACT_MIN, OUTBOUND.REACT_MAX) + 800);
        const buffer = fs.readFileSync(stickerFile);
        const target = action.target_message_id ? this.store.resolve(action.target_message_id) : null;
        const sent = await sock.sendMessage(
          chatJid,
          { sticker: buffer },
          target ? { quoted: target } : undefined,
        );
        this.repo.bumpStickerUse(action.sticker_id);
        return sent ?? null;
      }
      case 'poll': {
        const options = action.options.map(o => o.trim()).filter(Boolean).slice(0, 12);
        if (options.length < 2) {
          logger.warn({ action }, 'poll needs at least 2 options — skipping');
          return null;
        }
        // typing a poll takes a moment too
        await this.simulateTyping(sock, chatJid, action.question + options.join(''));
        return (await sock.sendMessage(chatJid, {
          poll: {
            name: this.decorate(action.question),
            values: options,
            selectableCount: action.multi_select ? options.length : 1,
          },
        })) ?? null;
      }
      case 'image': {
        // daily cap + budget guard
        const perDay = Number(this.repo.getConfig('images_per_day') ?? IMAGE_GEN.DEFAULT_PER_DAY);
        if (this.repo.imagesToday() >= perDay) {
          logger.warn({ perDay }, 'daily image cap reached — skipping generation');
          return null;
        }
        if (this.ai.isOverBudget()) {
          logger.warn('over budget — skipping image generation');
          return null;
        }
        const model = (this.repo.getConfig('image_model') ?? 'flash') as ImageModelChoice;

        // optional edit source: transform an existing image message
        let editImage: { data: Buffer; mimeType: string } | undefined;
        if (action.edit_message_id) {
          const row = this.repo.getMessageByShortId(action.edit_message_id) ?? this.repo.getMessageById(action.edit_message_id);
          if (row?.media_path && fs.existsSync(row.media_path)) {
            editImage = { data: fs.readFileSync(row.media_path), mimeType: 'image/jpeg' };
          }
        }

        if (this.typingOn()) { try { await this.getSock()?.sendPresenceUpdate('composing', chatJid); } catch { /* ignore */ } }
        const gen = await geminiGenerateImage(action.prompt, model, editImage);
        if (!gen) {
          const text = this.decorate('couldn\'t cook that image up 💀');
          return (await sock.sendMessage(chatJid, { text })) ?? null;
        }
        this.repo.imagesToday(true);
        this.ai.recordImageCost(IMAGE_GEN.COST_MICRO[model], jidNormalizedUser(chatJid));

        const target = action.target_message_id ? this.store.resolve(action.target_message_id) : null;
        return (await sock.sendMessage(
          chatJid,
          { image: gen.buffer, caption: action.caption ? this.decorate(action.caption) : undefined },
          target ? { quoted: target } : undefined,
        )) ?? null;
      }
      case 'voice': {
        const voiceId = this.repo.getConfig('voice_id') || ELEVENLABS.DEFAULT_VOICE_ID;
        // "recording" presence while TTS renders (only if typing indicators enabled)
        if (this.typingOn()) { try { await sock.sendPresenceUpdate('recording', chatJid); } catch { /* ignore */ } }
        const audio = await elevenLabsTts(action.text, voiceId);
        if (!audio) {
          logger.warn('TTS failed — falling back to text message');
          const text = this.decorate(action.text);
          return (await sock.sendMessage(chatJid, { text })) ?? null;
        }
        // a human needs a moment to record what they're saying
        await sleep(Math.min(Math.max(action.text.length * 45, 1500), 8000));
        const target = action.target_message_id ? this.store.resolve(action.target_message_id) : null;
        return (await sock.sendMessage(
          chatJid,
          { audio, ptt: true, mimetype: 'audio/ogg; codecs=opus' },
          target ? { quoted: target } : undefined,
        )) ?? null;
      }
      default:
        return null;
    }
  }

  /** Typing/recording indicators tell WhatsApp the account is "active on a linked device",
   *  which silences phone notification sounds. OFF by default so the phone keeps notifying. */
  private typingOn(): boolean {
    return this.repo.getConfig('typing_indicators') === '1';
  }

  private async simulateTyping(sock: WASocket, chatJid: string, text: string): Promise<void> {
    const duration = Math.min(
      Math.max(jitter(text.length * OUTBOUND.TYPING_MS_PER_CHAR, OUTBOUND.TYPING_JITTER), OUTBOUND.TYPING_MIN),
      OUTBOUND.TYPING_MAX,
    );
    // keep the human-like pause before sending, but only emit the "typing…" presence if enabled
    if (!this.typingOn()) {
      await sleep(duration);
      return;
    }
    const start = Date.now();
    try {
      await sock.sendPresenceUpdate('composing', chatJid);
    } catch { /* can fail right after fresh QR login — fine */ }
    while (Date.now() - start < duration) {
      const remaining = duration - (Date.now() - start);
      await sleep(Math.min(remaining, OUTBOUND.COMPOSING_REFRESH));
      if (Date.now() - start < duration) {
        try { await sock.sendPresenceUpdate('composing', chatJid); } catch { /* ignore */ }
      }
    }
  }

  private recordBotMessage(sent: WAMessage | null): void {
    // Insert into bot_messages BEFORE the upsert echo can be processed,
    // so fromMe echoes are classified as bot (not owner) messages.
    if (sent?.key?.id) {
      this.repo.addBotMessage(sent.key.id, Date.now());
      this.repo.bumpStat('messages_sent');
      if (sent.key.remoteJid) {
        this.repo.bumpStat(`messages_sent:${jidNormalizedUser(sent.key.remoteJid)}`);
      }
      try { this.onBotMessage?.(sent); } catch { /* feed update is best-effort */ }
    }
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn);
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }
}
