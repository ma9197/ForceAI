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
  groups: GroupStatus[];
  stats: Record<string, number>;
  settings: { gatekeeper_model: string; effort: string; daily_budget_usd: number };
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
