import crypto from 'node:crypto';
import { decryptPollVote, jidNormalizedUser, type WAMessage } from 'baileys';
import { logger } from '../logger.js';
import type { Repo } from '../memory/repo.js';
import type { MessageStore } from './store.js';

/**
 * Poll votes arrive as encrypted pollUpdateMessage payloads. This Baileys RC does not
 * auto-decrypt them, so we do it ourselves: fetch the poll creation message (it holds
 * the encryption secret), try the LID/PN identity combinations, and match the decrypted
 * SHA256 hashes back to option names. Results persist in poll_votes.
 */

/** Byte fields survive JSON round-trips in several shapes — normalize them all. */
export function reviveBytes(value: unknown): Uint8Array | null {
  if (!value) return null;
  if (value instanceof Uint8Array) return value;
  if (typeof value === 'string') return Buffer.from(value, 'base64'); // protobuf toJSON form
  if (typeof value === 'object') {
    const v = value as any;
    if (v.type === 'Buffer' && Array.isArray(v.data)) return Buffer.from(v.data); // Buffer.toJSON form
    const keys = Object.keys(v);
    if (keys.length && keys.every(k => /^\d+$/.test(k))) return Uint8Array.from(Object.values(v) as number[]); // plain Uint8Array JSON
  }
  return null;
}

export interface VoteResult {
  pollId: string;
  question: string;
  voterJid: string;
  voterName: string;
  selected: string[];
}

export class PollTracker {
  constructor(
    private repo: Repo,
    private store: MessageStore,
  ) {}

  isPollVote(msg: WAMessage): boolean {
    return !!msg.message?.pollUpdateMessage;
  }

  /** Decrypt and record a poll vote. Returns null when it can't be processed. */
  handleVote(msg: WAMessage, ownJids: (string | undefined)[]): VoteResult | null {
    const update = msg.message?.pollUpdateMessage;
    const creationKey = update?.pollCreationMessageKey;
    const enc = update?.vote;
    if (!update || !creationKey?.id || !enc?.encPayload || !enc.encIv) return null;

    const pollId = creationKey.id;
    const creation = this.store.resolve(pollId);
    if (!creation?.message) {
      logger.warn({ pollId }, 'poll vote: creation message not found — cannot decrypt');
      return null;
    }

    const content: any = creation.message;
    const poll = content.pollCreationMessage ?? content.pollCreationMessageV2 ?? content.pollCreationMessageV3;
    const secret = reviveBytes(content.messageContextInfo?.messageSecret);
    if (!poll?.name || !secret) {
      logger.warn({ pollId }, 'poll vote: missing poll content or messageSecret');
      return null;
    }

    const own = ownJids.filter(Boolean).map(j => jidNormalizedUser(j!));

    const candidates = (key: any, fromMe: boolean): string[] => {
      const list = fromMe
        ? own
        : [key?.participant, key?.participantAlt, key?.remoteJid].filter(Boolean).map((j: string) => jidNormalizedUser(j));
      return [...new Set(list)];
    };

    const creators = candidates(creation.key, !!creation.key?.fromMe);
    const voters = candidates(msg.key, !!msg.key?.fromMe);

    const encPayload = reviveBytes(enc.encPayload)!;
    const encIv = reviveBytes(enc.encIv)!;

    let selectedHashes: string[] | null = null;
    outer: for (const pollCreatorJid of creators) {
      for (const voterJid of voters) {
        try {
          const vote = decryptPollVote(
            { encPayload, encIv },
            { pollCreatorJid, pollMsgId: pollId, pollEncKey: secret, voterJid },
          );
          selectedHashes = (vote.selectedOptions ?? []).map(o => Buffer.from(o).toString('hex'));
          break outer;
        } catch { /* wrong identity combination — try next */ }
      }
    }

    if (selectedHashes === null) {
      logger.warn({ pollId, creators, voters }, 'poll vote: decryption failed for all identity combos');
      return null;
    }

    // map hashes → option names
    const options: string[] = (poll.options ?? []).map((o: any) => o.optionName).filter(Boolean);
    const byHash = new Map(options.map(name => [
      crypto.createHash('sha256').update(name).digest('hex'),
      name,
    ]));
    const selected = selectedHashes.map(h => byHash.get(h) ?? '(unknown option)');

    const voterJid = msg.key?.fromMe
      ? 'owner'
      : jidNormalizedUser(msg.key?.participant ?? msg.key?.remoteJid ?? 'unknown@s.whatsapp.net');
    const voterName = msg.key?.fromMe
      ? 'Said (owner)'
      : (msg.pushName || this.repo.getMember(voterJid)?.display_name || voterJid.split('@')[0]);

    this.repo.setPollVote(pollId, voterJid, voterName, selected);
    return { pollId, question: poll.name, voterJid, voterName, selected };
  }

  /** "yes": Eyyub, Said · "no": Ayxan — for transcripts and the dashboard. */
  formatResults(pollId: string): string {
    const votes = this.repo.getPollVotes(pollId);
    const byOption = new Map<string, string[]>();
    for (const v of votes) {
      for (const opt of v.options) {
        if (!byOption.has(opt)) byOption.set(opt, []);
        byOption.get(opt)!.push(v.voter_name);
      }
    }
    if (byOption.size === 0) return '';
    return [...byOption.entries()]
      .map(([opt, names]) => `"${opt}": ${names.join(', ')}`)
      .join(' · ');
  }
}
