import type { WAMessage } from 'baileys';

/** A normalized inbound message, regardless of WhatsApp's wire format. */
export interface NormalizedMessage {
  /** WhatsApp message id (key.id) */
  id: string;
  /** short transcript id like m42, assigned sequentially */
  shortId: string;
  chatJid: string;
  /** canonical sender jid (LID preferred) */
  senderJid: string;
  senderName: string;
  fromMe: boolean;
  isBot: boolean;
  isOwner: boolean;
  /** message kind */
  type: 'text' | 'sticker' | 'image' | 'video' | 'audio' | 'document' | 'reaction' | 'poll' | 'other';
  text: string;
  /** id of quoted message if this is a reply */
  quotedId?: string;
  quotedText?: string;
  quotedSenderJid?: string;
  /** for reaction messages: target message id + emoji */
  reactionTargetId?: string;
  reactionEmoji?: string;
  mentionedJids: string[];
  ts: number; // epoch ms
  raw: WAMessage;
}

export type BotAction =
  | { type: 'message'; text: string }
  | { type: 'reply'; text: string; target_message_id: string }
  | { type: 'reaction'; emoji: string; target_message_id: string }
  | { type: 'sticker'; sticker_id: number; target_message_id?: string | null }
  | { type: 'poll'; question: string; options: string[]; multi_select?: boolean | null }
  | { type: 'voice'; text: string; target_message_id?: string | null }
  | { type: 'image'; prompt: string; caption?: string | null; edit_message_id?: string | null; target_message_id?: string | null }
  | { type: 'sleep' }
  | { type: 'nothing' };

export interface ActionPlan {
  actions: BotAction[];
  note: string;
}

export type GateDecision = 'RESPOND' | 'WAIT' | 'IGNORE';

export interface GateResult {
  decision: GateDecision;
  reason: string;
  address_message_ids: string[];
  wait_ms?: number | null;
  heat: 'low' | 'medium' | 'high';
}

export type ArbiterPhase =
  | 'IDLE'
  | 'ACCUMULATING'
  | 'EVALUATING'
  | 'GENERATING'
  | 'SENDING'
  | 'COOLDOWN';

export interface MemberRow {
  jid: string;
  pn_jid: string | null;
  display_name: string | null;
  personality_notes: string | null;
  custom_instructions: string | null;
  first_seen: number;
  last_seen: number;
  message_count: number;
}

/** One saved knowledge item, as a node for the "Neurons" visualization. Edges are generated
 *  client-side (purely visual), so the payload is just the node list. */
export type NeuronType = 'fact' | 'voice' | 'report' | 'stat' | 'observation' | 'lesson' | 'principle' | 'sticker' | 'summary';
export interface NeuronNode {
  id: string;            // `${type}:${rowId}` — stable, unique
  type: NeuronType;
  t: number;             // normalized epoch ms (created_at / ts / added_at / updated_at)
  label: string;         // short hover label
  text: string;          // full content for the click-to-inspect card (trimmed)
  group: string | null;  // human-readable group name, or null for global items
  member: string | null; // member display name where applicable
  category: string | null; // facts.category / voice_items.category / stat_key — for sub-coloring
}

export interface FactRow {
  id: number;
  member_jid: string;
  fact: string;
  category: string | null;
  confidence: number | null;
  source_message_id: string | null;
  created_at: number;
  superseded_by: number | null;
}

export interface VoiceItemRow {
  id: number;
  chat_jid: string;
  category: string; // phrase | slang | joke | reference | pattern | member_style
  content: string;
  example: string | null;
  member_jid: string | null;
  created_at: number;
  superseded_by: number | null;
  checked: number; // 0 = new/unreviewed, 1 = reviewed by owner
}

export interface MemberReportRow {
  id: number;
  member_jid: string;
  week_start: number;
  bio: string | null;
  summary: string | null;
  talking_style: string | null;
  created_at: number;
}

export interface MemberStatHistoryRow {
  id: number;
  member_jid: string;
  week_start: number;
  stat_key: string; // 'mood' | 'iq' | 'aggression'
  value: number | null;
  label: string | null;
  reason: string | null;
  created_at: number;
}

/** Code-derived (token-free) analytics for one person, computed live from the message log. */
export interface MemberCodeStats {
  messages_total: number;        // all-time (members.message_count)
  messages_window: number;       // within the analysis window
  starts: number;                // conversations kicked off (quiet-timer rule)
  contributions: number;         // messages joining an ongoing convo / replies
  starter_ratio: number;         // starts / (starts + contributions)
  top_hour: number | null;       // 0-23, most active hour
  top_day: number | null;        // 0-6 (Sun..Sat), most active weekday
  sparkline: number[];           // per-day message counts, last 14 days
  avg_len: number;               // avg characters per text message
  emoji_rate: number;            // emojis per message
  question_rate: number;         // fraction of messages containing '?'
  reply_network: { jid: string; count: number }[]; // top people they reply to
}

export interface StickerRow {
  id: number;
  file_path: string;
  sha256: string;
  description: string | null;
  usage_hint: string | null;
  added_at: number;
  times_used: number;
}

export interface DecisionRow {
  id: number;
  ts: number;
  tier: string;
  decision: string;
  reason: string;
  tokens_in: number;
  tokens_out: number;
}

/** Events broadcast to the dashboard over WebSocket. */
export type BusEvent =
  | { kind: 'qr'; dataUrl: string }
  | { kind: 'connection'; state: 'waiting_qr' | 'connecting' | 'open' | 'closed' | 'logged_out' }
  | { kind: 'message'; chatJid: string; message: FeedMessage }
  | { kind: 'decision'; chatJid: string; ts: number; tier: string; decision: string; reason: string }
  | { kind: 'action'; chatJid: string; ts: number; action: BotAction }
  | { kind: 'stats'; stats: Record<string, number> }
  | { kind: 'fact'; chatJid: string; memberJid: string; fact: string; category: string | null }
  | { kind: 'voice'; chatJid: string; count: number }
  | { kind: 'report'; count: number }
  | { kind: 'sticker'; id: number; description: string | null }
  | { kind: 'status'; status: StatusPayload };

export interface FeedMessage {
  id: string;
  shortId: string;
  senderName: string;
  isBot: boolean;
  isOwner: boolean;
  type: string;
  text: string;
  quotedText?: string;
  reactionEmoji?: string;
  ts: number;
}

/** Per-group live status shown as a tab in the dashboard. */
export interface GroupStatus {
  jid: string;
  name: string | null;
  paused: boolean;
  asleep: boolean;
  phase: ArbiterPhase;
  stats: {
    messages_read: number;
    messages_sent: number;
    facts_learned: number;
    t1_calls: number;
    t2_calls: number;
    cost_microusd: number;
  };
}

export interface StatusPayload {
  connection: string;
  online: boolean;
  needsSetup: boolean;
  demo: boolean;
  keys: { anthropic: boolean; gemini: boolean; elevenlabs: boolean };
  groups: GroupStatus[];
  stats: Record<string, number>;
  settings: {
    anthropic_key_set: boolean;
    anthropic_key_last4: string | null;
    gemini_key_set: boolean;
    gemini_key_last4: string | null;
    elevenlabs_key_set: boolean;
    elevenlabs_key_last4: string | null;
    dashboard_protected: boolean;
    gatekeeper_model: string;
    generation_model: string;
    effort: string;
    daily_budget_usd: number;
    msg_prefix: string;
    msg_suffix: string;
    voice_enabled: boolean;
    voice_available: boolean;
    voice_id: string;
    persona_mode: string;
    persona_custom: string;
    sticker_freq: string;
    voice_freq: string;
    emoji_freq: string;
    intro_message: string;
    intro_enabled: boolean;
    rate_per_min: number;
    rate_per_hour: number;
    super_idle_minutes: number;
    image_enabled: boolean;
    image_available: boolean;
    image_model: string;
    image_freq: string;
    images_per_day: number;
    images_today: number;
    typing_indicators: boolean;
    token_reduction: boolean;
    initiative_enabled: boolean;
  };
}
