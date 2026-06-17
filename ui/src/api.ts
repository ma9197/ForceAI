export interface GroupStatus {
  jid: string;
  name: string | null;
  paused: boolean;
  asleep: boolean;
  phase: string;
  stats: {
    messages_read: number;
    messages_sent: number;
    facts_learned: number;
    t1_calls: number;
    t2_calls: number;
    cost_microusd: number;
  };
}

export interface Status {
  connection: string;
  online: boolean;
  needsSetup: boolean;
  demo: boolean;
  keys: { anthropic: boolean; gemini: boolean; elevenlabs: boolean };
  groups: GroupStatus[];
  stats: Record<string, number>;
  settings: { gatekeeper_model: string; generation_model: string; effort: string; daily_budget_usd: number; token_reduction?: boolean };
}

export interface GroupInfo { jid: string; subject: string; size: number; linked?: boolean }

export interface FeedMessage {
  id: string; shortId: string; senderName: string; isBot: boolean; isOwner: boolean;
  type: string; text: string; quotedText?: string; reactionEmoji?: string; ts: number;
}

export interface DecisionEvt { ts: number; tier: string; decision: string; reason: string }

export interface Member {
  jid: string; pn_jid: string | null; display_name: string | null;
  personality_notes: string | null; message_count: number;
  facts: { id: number; fact: string; category: string | null; confidence: number | null }[];
}

export interface Sticker {
  id: number; description: string | null; usage_hint: string | null; times_used: number;
}

export interface VoiceItem {
  id: number; chat_jid: string; category: string; content: string;
  example: string | null; member_jid: string | null; member_name: string | null; created_at: number;
  checked: number; // 0 = new/unreviewed (highlighted), 1 = reviewed
}

export interface VoiceProfile {
  overview: string | null;
  items: VoiceItem[];
}

export interface MemberStat { value: number | null; label: string | null; reason: string | null; locked: boolean }

export interface MemberCodeStats {
  messages_total: number; messages_window: number;
  starts: number; contributions: number; starter_ratio: number;
  top_hour: number | null; top_day: number | null;
  sparkline: number[];
  avg_len: number; emoji_rate: number; question_rate: number;
  reply_network: { jid: string; count: number }[];
}

export interface PersonSummary {
  jid: string; name: string; message_count: number; last_seen: number;
  bio: string | null; talking_style: string | null; has_report: boolean;
  has_boundaries?: boolean;
  stats: Record<string, MemberStat>;
  code: MemberCodeStats | null;
}

export interface PersonProfile extends PersonSummary {
  first_seen: number; summary: string | null; week_start: number | null;
  custom_instructions: string | null;
  groups: { chat_jid: string; count: number }[];
  reply_network: { jid: string; count: number; name: string }[];
}

export interface StatHistoryEntry {
  week_start: number; value: number | null; label: string | null; reason: string | null;
}

export async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
}

export const post = (path: string, body?: unknown) =>
  api(path, { method: 'POST', body: JSON.stringify(body ?? {}) });
