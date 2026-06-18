import { ADMIN_PREFIX, BOT_NAME_REGEX } from '../config.js';
import type { Repo } from '../memory/repo.js';
import type { JidResolver } from '../wa/jid.js';
import type { NormalizedMessage } from '../types.js';

/** Strip emoji, variation selectors, ZWJ, whitespace and punctuation; what's left is "content". */
const NON_CONTENT = /[\p{Extended_Pictographic}\p{Emoji_Component}‍️\s\p{P}]+/gu;

export function isReactionLike(m: NormalizedMessage): boolean {
  if (m.type === 'reaction') return true;
  if (m.type !== 'text') return false;
  const content = m.text.replace(NON_CONTENT, '');
  if (content.length === 0) return true; // pure emoji / punctuation
  if (m.text.trim().length < 5) return true; // "lol", "xd", "ha"
  return false;
}

/** "Admin:" works in plain text AND in an image/video caption — anything that carries text. */
function carriesText(m: NormalizedMessage): boolean {
  return m.type !== 'reaction' && m.type !== 'sticker' && !!m.text;
}

export function parseAdminCommand(m: NormalizedMessage): string | null {
  if (!m.isOwner || !carriesText(m)) return null;
  const match = m.text.match(ADMIN_PREFIX);
  if (!match) return null;
  const instruction = m.text.slice(match[0].length).trim();
  // a bare "Admin:" on an image with no instruction still means "look at this"
  if (instruction.length > 0) return instruction;
  return m.type === 'image' || m.type === 'video' ? 'look at the image/video I just sent' : null;
}

/** A non-owner trying to use the owner's "Admin:" command — never obeyed, always mocked. */
export function isFakeAdminAttempt(m: NormalizedMessage): boolean {
  return !m.isOwner && !m.isBot && carriesText(m) && ADMIN_PREFIX.test(m.text);
}

/**
 * While ASLEEP, ONLY the literal bot name ("ForceAI" / "force ai" / "forceai") wakes the bot —
 * nothing else. Deliberately EXCLUDES @mentions AND replies: the bot shares the owner's WhatsApp
 * account, so an @mention of — or a reply to — the owner-as-person is indistinguishable from one
 * aimed at the bot, and those must NOT wake it (replying to any of the owner's/bot's messages used
 * to wake it, which the owner did not want). Awake behavior is unchanged — isHardTrigger still
 * treats @mentions and replies-to-bot as triggers.
 */
export function isWakeTrigger(m: NormalizedMessage): boolean {
  if (m.isBot || m.isOwner || m.type === 'reaction') return false;
  return BOT_NAME_REGEX.test(m.text);
}

export function isHardTrigger(m: NormalizedMessage, repo: Repo, jids: JidResolver): boolean {
  if (m.isBot || m.isOwner) return false;
  if (m.type === 'reaction') return false; // reactions to the bot are aftermath, not triggers
  // @mention of the bot
  if (m.mentionedJids.some(j => jids.isOwnJid(j))) return true;
  // quoted reply targeting one of the bot's messages
  if (m.quotedId && repo.isBotMessage(m.quotedId)) return true;
  // bot name in text
  if (BOT_NAME_REGEX.test(m.text)) return true;
  // owner impersonation attempt — always answered (with mockery)
  if (isFakeAdminAttempt(m)) return true;
  return false;
}
