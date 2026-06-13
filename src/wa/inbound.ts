import { jidNormalizedUser, type WAMessage } from 'baileys';
import type { Repo } from '../memory/repo.js';
import type { JidResolver } from './jid.js';
import type { NormalizedMessage } from '../types.js';

/** Extract displayable text from the many places WhatsApp hides it. */
export function extractText(msg: WAMessage): string {
  const m = msg.message;
  if (!m) return '';
  const poll = (m as any).pollCreationMessage ?? (m as any).pollCreationMessageV2 ?? (m as any).pollCreationMessageV3;
  if (poll?.name) {
    const opts = (poll.options ?? []).map((o: any) => o.optionName).filter(Boolean);
    return `${poll.name}${opts.length ? ` (${opts.join(' / ')})` : ''}`;
  }
  return (
    m.conversation ??
    m.extendedTextMessage?.text ??
    m.imageMessage?.caption ??
    m.videoMessage?.caption ??
    m.documentMessage?.caption ??
    ''
  );
}

function messageType(msg: WAMessage): NormalizedMessage['type'] {
  const m = msg.message;
  if (!m) return 'other';
  if (m.reactionMessage) return 'reaction';
  if (m.stickerMessage) return 'sticker';
  if ((m as any).pollCreationMessage || (m as any).pollCreationMessageV2 || (m as any).pollCreationMessageV3) return 'poll';
  if (m.imageMessage) return 'image';
  if (m.videoMessage) return 'video';
  if (m.audioMessage) return 'audio';
  if (m.documentMessage) return 'document';
  if (m.conversation || m.extendedTextMessage) return 'text';
  return 'other';
}

export class Normalizer {
  private seq: number;

  constructor(private repo: Repo, private jids: JidResolver) {
    this.seq = Number(repo.getConfig('msg_seq') ?? '0');
  }

  private nextShortId(): string {
    this.seq += 1;
    this.repo.setConfig('msg_seq', String(this.seq));
    return `m${this.seq}`;
  }

  /** Returns null for messages we can't process (no content / undecryptable). */
  normalize(msg: WAMessage): NormalizedMessage | null {
    if (!msg.key?.remoteJid) return null;
    const m = msg.message;
    if (!m) return null; // undecryptable ("waiting for this message") — skip

    const chatJid = jidNormalizedUser(msg.key.remoteJid);
    const fromMe = !!msg.key.fromMe;
    const isBot = fromMe && this.repo.isBotMessage(msg.key.id ?? '');
    const isOwner = fromMe && !isBot;

    // sender: in groups it's key.participant (+participantAlt); for fromMe it's us
    let senderJid: string;
    let pn: string | null = null;
    if (fromMe) {
      const r = this.jids.canonical(msg.key.participant ?? undefined, (msg.key as any).participantAlt ?? undefined);
      senderJid = r.canonical !== 'unknown@s.whatsapp.net' ? r.canonical : chatJid;
    } else {
      const r = this.jids.canonical(
        msg.key.participant ?? msg.key.remoteJid ?? undefined,
        (msg.key as any).participantAlt ?? (msg.key as any).remoteJidAlt ?? undefined,
      );
      senderJid = r.canonical;
      pn = r.pn;
    }

    const type = messageType(msg);
    const text = extractText(msg);
    // skip truly empty non-media messages (protocol noise)
    if (!text && type === 'other') return null;

    const ctx = m.extendedTextMessage?.contextInfo ?? m.stickerMessage?.contextInfo ?? m.imageMessage?.contextInfo;
    const reaction = m.reactionMessage;

    const senderName = fromMe ? 'You' : (msg.pushName || senderJid.split('@')[0]);
    const ts = typeof msg.messageTimestamp === 'number'
      ? msg.messageTimestamp * 1000
      : Number(msg.messageTimestamp ?? 0) * 1000 || Date.now();

    const norm: NormalizedMessage = {
      id: msg.key.id ?? `${chatJid}:${ts}`,
      shortId: this.nextShortId(),
      chatJid,
      senderJid,
      senderName,
      fromMe,
      isBot,
      isOwner,
      type,
      text: reaction ? (reaction.text ?? '') : text,
      // reactions reference their target via quotedId so transcript lookups work uniformly
      quotedId: reaction?.key?.id ?? ctx?.stanzaId ?? undefined,
      quotedText: ctx?.quotedMessage ? (
        ctx.quotedMessage.conversation ?? ctx.quotedMessage.extendedTextMessage?.text ?? '[media]'
      ) : undefined,
      quotedSenderJid: ctx?.participant ? jidNormalizedUser(ctx.participant) : undefined,
      reactionTargetId: reaction?.key?.id ?? undefined,
      reactionEmoji: reaction?.text ?? undefined,
      mentionedJids: (ctx?.mentionedJid ?? []).map(j => jidNormalizedUser(j)),
      ts,
      raw: msg,
    };

    // persist member info (skip self)
    if (!fromMe && senderJid.includes('@')) {
      this.repo.upsertMember(senderJid, msg.pushName ?? null, pn, ts);
      this.repo.bumpMemberMessageCount(senderJid);
    }

    return norm;
  }
}
