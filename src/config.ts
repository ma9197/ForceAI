import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Works both from src/ (tsx) and dist/ (compiled) — root is one level up.
export const ROOT_DIR = path.resolve(__dirname, '..');
export const DATA_DIR = path.join(ROOT_DIR, 'data');
export const AUTH_DIR = path.join(DATA_DIR, 'auth');
export const STICKER_DIR = path.join(DATA_DIR, 'stickers');
export const IMAGE_DIR = path.join(DATA_DIR, 'images');
export const DB_PATH = path.join(DATA_DIR, 'forceai.db');
export const TRAINING_DATA_PATH = path.join(ROOT_DIR, 'ai_chat_training_data.txt');
export const UI_DIST = path.join(ROOT_DIR, 'ui', 'dist');

export const PORT = Number(process.env.PORT ?? 3008);

/** Public showcase mode: seeds fake data, skips the real WhatsApp connection, blocks outbound sends —
 *  so a hosted demo is fully clickable with no keys/phone. Set DEMO_MODE=1 in the env. */
export const DEMO_MODE = process.env.DEMO_MODE === '1';

/**
 * Resolve a sticker's actual file location from whatever path is stored in the DB.
 * The stored path may be a Windows absolute path (from a local install) or a Linux one
 * (on the server) — we only trust the filename and re-root it under the current STICKER_DIR.
 * Splitting on both separators makes it work regardless of which OS wrote the row.
 */
export function resolveStickerPath(storedPath: string): string {
  const name = storedPath.split(/[\\/]/).pop() || storedPath;
  return path.join(STICKER_DIR, name);
}

/** Replace WhatsApp @<number> mentions with @<name> using a number→name map (else leave as-is). */
export function applyMentions(text: string, map: Record<string, string>): string {
  if (!text || text.indexOf('@') < 0) return text;
  return text.replace(/@(\d{5,})/g, (full, num) => (map[num] ? `@${map[num]}` : full));
}

// ---- Models ----
export const GENERATION_MODEL = 'claude-sonnet-4-6';
export const GATEKEEPER_MODELS = {
  sonnet: 'claude-sonnet-4-6',
  haiku: 'claude-haiku-4-5',
} as const;
export type GatekeeperChoice = keyof typeof GATEKEEPER_MODELS;
/** Reply-generation model — separately selectable so the owner can trade quality for cost. */
export const GENERATION_MODELS = {
  sonnet: 'claude-sonnet-4-6',
  haiku: 'claude-haiku-4-5',
} as const;
export type GenerationChoice = keyof typeof GENERATION_MODELS;
/**
 * Model for the background voice profiler. Pinned to Sonnet on purpose: capturing the group's
 * nuanced texting style is quality-sensitive, and it runs in the background (incl. during sleep)
 * so latency doesn't matter. It still respects the daily budget, and only fires every ~50 msgs.
 */
export const VOICE_PROFILE_MODEL = 'claude-sonnet-4-6';

// ---- Member reports (per-person dossiers, weekly AI + free code-stats) ----
export const REPORT = {
  // code-derived analytics (token-free)
  QUIET_MS: 3 * 60_000,          // group "quiet" threshold for conversation-start detection (owner's rule)
  CODE_STATS_WINDOW_DAYS: 90,    // window for behavioral code-stats (keeps them current + bounded)
  SPARKLINE_DAYS: 14,            // per-day activity sparkline length
  // weekly AI job (used in phase 2)
  MODEL: 'claude-sonnet-4-6',    // all-Sonnet per owner's choice
  RUN_HOUR_UTC: 4,               // Sunday ~04:00 UTC = ~08:00 Asia/Baku
  RUN_WINDOW_HOURS: 3,           // acceptable run window after the target hour
  MIN_DAYS_BETWEEN: 6,           // don't re-run within this many days
  HEAVY_MIN_MSGS: 40,            // members with >= this many msgs in the week get a per-member deep-dive
  BATCH_SIZE: 6,                 // light members processed per batched call
  SAMPLE_MSGS: 60,               // capped message sample per member in the digest
  MAX_OUTPUT_TOKENS: 8000,
} as const;

// ---- Initiative learning (distill flagged Influences into "when to take initiative" principles) ----
export const INITIATIVE = {
  MODEL: 'claude-sonnet-4-6',
  AUTO_DISTILL_AFTER: 5,    // auto-distill once this many new flagged lessons accumulate
  MAX_ITEMS_IN_PROMPT: 20,  // cap principles injected into the bot's prompt
  MAX_OUTPUT_TOKENS: 4000,
  CONTEXT_MSGS: 12,         // recent messages captured as context with each flagged lesson
} as const;

// $/MTok pricing for cost accounting (input, output, cacheRead, cacheWrite)
export const PRICING: Record<string, { in: number; out: number; cacheRead: number; cacheWrite: number }> = {
  'claude-sonnet-4-6': { in: 3, out: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-haiku-4-5': { in: 1, out: 5, cacheRead: 0.1, cacheWrite: 1.25 },
};

// ---- Arbiter tunables (ms unless noted) ----
export const ARBITER = {
  DEBOUNCE_BASE: 3000,
  DEBOUNCE_PER_MSG: 400,
  DEBOUNCE_MAX: 9000,
  HARD_TRIGGER_DEBOUNCE: 1800,
  MAX_ACCUMULATE: 20000,
  SOFT_COOLDOWN: 20000,
  SAME_SENDER_EXTRA: 1500,
  SAME_SENDER_WINDOW: 3000,
  REACTION_ESCALATE_COUNT: 3,
  MAX_WAITS: 2,
  MAX_REGENS: 1,
  RATE_PER_MIN: 4,
  RATE_PER_HOUR: 30,
  WAIT_MIN: 2000,
  WAIT_MAX: 15000,
  VELOCITY_WINDOW: 10000, // msgs counted within this window for adaptive debounce
  TRANSCRIPT_LINES: 40, // lines of context for T2
  GATEKEEPER_LINES: 25, // lines of context for T1
  STALE_MESSAGE_AGE: 120000, // ignore upserts older than this on boot
  MAX_ACTIONS: 4,
} as const;

// ---- Outbound humanization ----
export const OUTBOUND = {
  TYPING_MS_PER_CHAR: 55,
  TYPING_JITTER: 0.3,
  TYPING_MIN: 1200,
  TYPING_MAX: 7000,
  GAP_MIN: 800,
  GAP_MAX: 2500,
  REACT_MIN: 600,
  REACT_MAX: 1500,
  COMPOSING_REFRESH: 8000,
} as const;

// ---- Memory / extraction ----
export const MEMORY = {
  EXTRACT_EVERY_MSGS: 30,
  EXTRACT_IDLE_MS: 5 * 60_000,
  EXTRACT_IDLE_MIN_MSGS: 10,
  BLOCK_B_REBUILD_MIN_MS: 5 * 60_000,
  STICKER_LEARN_TIMEOUT: 5 * 60_000,
} as const;

// ---- Voice profiler (learns the group's texting style; runs even while the bot sleeps) ----
export const VOICE_PROFILE = {
  EVERY_MSGS: 50,          // analyze when this many new (human) messages have accumulated
  IDLE_MS: 8 * 60_000,     // or after a lull with enough backlog
  IDLE_MIN_MSGS: 20,
  MAX_ITEMS_IN_PROMPT: 50, // cap items injected into the generation prompt (keeps it cheap)
  MANUAL_CHAT_MSGS: 500,   // how many recent messages a manual "learn from chat" scan reads
  MAX_OUTPUT_TOKENS: 8000, // ceiling for the profiler's JSON output — must be high enough that a
                           // rich scan (esp. a deep memory/chat re-scan) isn't truncated mid-JSON,
                           // which makes structured-output parsing throw. Only generated tokens cost.
} as const;

// ---- ElevenLabs voice ----
export const ELEVENLABS = {
  MODEL: 'eleven_flash_v2_5', // fastest (~75ms), multilingual (EN/TR/RU + more)
  OUTPUT_FORMAT: 'opus_48000_64', // Ogg/Opus — WhatsApp's native voice-note format, no conversion needed
  DEFAULT_VOICE_ID: 'JBFqnCBsd6RMkjVDRZzb', // "George" premade voice — change in Settings
  TIMEOUT_MS: 20000,
} as const;

// ---- Image generation (Google Gemini) ----
export const IMAGE_GEN = {
  MODELS: {
    flash: 'gemini-2.5-flash-image', // "Nano Banana" — $0.039/img, free 500/day, good meme text
    pro: 'gemini-3-pro-image',       // "Nano Banana Pro" — $0.134/img, text-perfect
  },
  COST_MICRO: { flash: 39_000, pro: 134_000 }, // micro-USD per image
  DEFAULT_PER_DAY: 15,
  TIMEOUT_MS: 60_000,
} as const;
export type ImageModelChoice = keyof typeof IMAGE_GEN.MODELS;

export const VISION = {
  MAX_IMAGES_PER_CALL: 2, // most recent N images attached to a generation — caps token cost
} as const;

export const DEFAULT_MSG_PREFIX = '🤖 ';
export const DEFAULT_MSG_SUFFIX = '';

export const BOT_NAME = 'ForceAI';
export const BOT_NAME_REGEX = /\bforce\s?ai\b/i;

// ---- World clock (the bot's real-world time awareness) ----
// We compute every city's wall-clock time IN CODE from the (NTP-accurate) server UTC clock and hand
// the model only the finished, labelled answers — no UTC value, no offsets, nothing for it to
// recalculate. Earlier versions gave the model UTC + an offset and it reliably grabbed the wrong
// number / botched the arithmetic. Pure UTC math also avoids the host timezone DB (Intl returned
// UTC for named zones on the server). DST is applied with explicit rules so it stays correct.
export type ClockCity = { label: string; offset: number; dst?: 'eu' | 'us' };

// Catalog for the dashboard dropdown. offset = standard UTC offset in hours; `dst` marks cities that
// shift +1h in summer. Caucasus / Russia / Central Asia / Gulf / Turkey have NO DST (fixed offsets).
export const CITY_CATALOG: ClockCity[] = [
  { label: 'Baku', offset: 4 }, { label: 'Tbilisi', offset: 4 }, { label: 'Yerevan', offset: 4 },
  { label: 'Dubai', offset: 4 }, { label: 'Istanbul', offset: 3 }, { label: 'Moscow', offset: 3 },
  { label: 'Minsk', offset: 3 }, { label: 'Kyiv', offset: 2, dst: 'eu' }, { label: 'Astana', offset: 5 },
  { label: 'Almaty', offset: 5 }, { label: 'Tashkent', offset: 5 }, { label: 'Bishkek', offset: 6 },
  { label: 'Tehran', offset: 3.5 }, { label: 'Karachi', offset: 5 }, { label: 'Delhi', offset: 5.5 },
  { label: 'London', offset: 0, dst: 'eu' }, { label: 'Berlin', offset: 1, dst: 'eu' },
  { label: 'Paris', offset: 1, dst: 'eu' }, { label: 'Warsaw', offset: 1, dst: 'eu' },
  { label: 'Madrid', offset: 1, dst: 'eu' }, { label: 'Rome', offset: 1, dst: 'eu' },
  { label: 'Amsterdam', offset: 1, dst: 'eu' }, { label: 'Stockholm', offset: 1, dst: 'eu' },
  { label: 'Athens', offset: 2, dst: 'eu' }, { label: 'New York', offset: -5, dst: 'us' },
  { label: 'Toronto', offset: -5, dst: 'us' }, { label: 'Chicago', offset: -6, dst: 'us' },
  { label: 'Denver', offset: -7, dst: 'us' }, { label: 'Los Angeles', offset: -8, dst: 'us' },
  { label: 'Tokyo', offset: 9 }, { label: 'Beijing', offset: 8 }, { label: 'Singapore', offset: 8 },
];

export const DEFAULT_CLOCK_CITIES: ClockCity[] = [
  { label: 'Baku', offset: 4 }, { label: 'Astana', offset: 5 },
  { label: 'Istanbul', offset: 3 }, { label: 'Moscow', offset: 3 },
];

const _CLOCK_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const _CLOCK_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function nthSundayUTC(year: number, monthIdx0: number, n: number): number {
  const dow = new Date(Date.UTC(year, monthIdx0, 1)).getUTCDay();
  return Date.UTC(year, monthIdx0, 1 + ((7 - dow) % 7) + (n - 1) * 7);
}
function lastSundayUTC(year: number, monthIdx0: number): number {
  const last = new Date(Date.UTC(year, monthIdx0 + 1, 0));
  return Date.UTC(year, monthIdx0, last.getUTCDate() - last.getUTCDay());
}
/** +1 hour during summer DST, else 0. EU: last-Sun-Mar→last-Sun-Oct. US: 2nd-Sun-Mar→1st-Sun-Nov. */
function dstShiftHours(now: Date, rule?: 'eu' | 'us'): number {
  if (!rule) return 0;
  const y = now.getUTCFullYear();
  const t = now.getTime();
  if (rule === 'eu') return t >= lastSundayUTC(y, 2) + 3_600_000 && t < lastSundayUTC(y, 9) + 3_600_000 ? 1 : 0;
  return t >= nthSundayUTC(y, 2, 2) + 7 * 3_600_000 && t < nthSundayUTC(y, 10, 1) + 6 * 3_600_000 ? 1 : 0;
}

/** Current wall-clock time in a city, computed purely from UTC arithmetic (no host timezone DB). */
export function cityNow(city: ClockCity, now = new Date()): string {
  const d = new Date(now.getTime() + (city.offset + dstShiftHours(now, city.dst)) * 3_600_000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${_CLOCK_DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${_CLOCK_MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/** Pre-computed real-world times block for AI requests — the model reads these off; no math, no UTC. */
export function formatCityTimes(cities: ClockCity[]): string {
  const list = cities?.length ? cities : DEFAULT_CLOCK_CITIES;
  const now = new Date();
  const lines = list.map((c) => `• ${c.label}: ${cityNow(c, now)}`);
  return `Current real-world time right now (already converted for each city — read these off exactly; do NOT recalculate or mention UTC):\n${lines.join('\n')}\nFor a city not in this list, estimate it relative to the nearest one above. You usually won't need this — use it only when the time or date genuinely matters.`;
}
export const ADMIN_PREFIX = /^admin:\s*/i;
export const INTRO_MESSAGE = 'Yooo @ForceAI is here 💀🔥';

export const DEFAULT_DAILY_BUDGET_USD = 5;
