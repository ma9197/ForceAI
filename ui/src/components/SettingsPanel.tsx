import { useEffect, useState } from 'react';
import { api } from '../api';
import { InitiativePrinciples } from './InitiativePrinciples';
import { WorldClock } from './WorldClock';

interface Settings {
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
  persona_presets: { value: string; label: string }[];
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
}

const FREQ = ['off', 'rare', 'sometimes', 'often', 'always'];
const FREQ_LABELS: Record<string, string> = {
  off: 'Off (only when asked)',
  rare: 'Rare',
  sometimes: 'Sometimes',
  often: 'Often',
  always: 'Every time',
};

/** A single API-key row: write-only password input (the real key is never sent back), a "Get a key"
 *  link, status (set + last4), and Save / optional Clear. */
function KeyRow({ label, hint, link, set, last4, clearable, onSave }: {
  label: string; hint: string; link: string; set: boolean; last4: string | null;
  clearable?: boolean; onSave: (value: string) => Promise<void>;
}) {
  const [val, setVal] = useState('');
  const [saved, setSaved] = useState(false);
  const save = async (v: string) => { await onSave(v); setVal(''); setSaved(true); setTimeout(() => setSaved(false), 1800); };
  return (
    <div className="settings-row">
      <div>
        <label>{label} {set && <span className="key-set">✓ set{last4 ? ` ··${last4}` : ''}</span>}</label>
        <div className="hint">{hint} <a href={link} target="_blank" rel="noreferrer">Get a key ↗</a></div>
      </div>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <input
          type="password" value={val} placeholder={set ? 'paste to replace' : 'paste key'}
          onChange={e => setVal(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && val.trim()) void save(val.trim()); }}
          style={{ width: 150 }}
        />
        <button className="primary" disabled={!val.trim()} onClick={() => save(val.trim())}>Save</button>
        {clearable && set && <button onClick={() => save('')} title="Remove this key">Clear</button>}
        {saved && <span className="voice-feedback">✓</span>}
      </div>
    </div>
  );
}

function FreqSlider({ label, hint, value, disabled, onChange }: {
  label: string; hint: string; value: string; disabled?: boolean;
  onChange: (v: string) => void;
}) {
  const idx = Math.max(0, FREQ.indexOf(value));
  return (
    <div className="settings-row">
      <div>
        <label>{label}</label>
        <div className="hint">{hint}</div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 230 }}>
        <input
          type="range"
          min={0}
          max={FREQ.length - 1}
          step={1}
          value={idx}
          disabled={disabled}
          onChange={e => onChange(FREQ[Number(e.target.value)])}
          style={{ width: 130 }}
        />
        <span style={{ fontSize: 12, color: 'var(--accent)', width: 110 }}>{FREQ_LABELS[FREQ[idx]]}</span>
      </div>
    </div>
  );
}

export function SettingsPanel({ onSaved }: { onSaved: () => void }) {
  const [settings, setSettings] = useState<Settings | null>(null);

  useEffect(() => {
    api<Settings>('/api/settings').then(setSettings).catch(() => undefined);
  }, []);

  const update = async (patch: Partial<Settings>) => {
    const next = await api<Settings>('/api/settings', {
      method: 'POST',
      body: JSON.stringify(patch),
    });
    setSettings(next);
    onSaved();
  };

  if (!settings) return <p className="muted">Loading…</p>;

  return (
    <div>
      <div className="voice-intro">
        <h3>⚙️ Settings</h3>
        <p className="muted">
          Everything ForceAI does, in one place — your API keys, which AI models it uses, how chatty it
          is, its personality, spending limits and more. Changes apply on its next message; nothing needs
          a restart.
        </p>
      </div>

      <h3 style={{ margin: '0 0 4px' }}>API keys</h3>
      <p className="hint" style={{ margin: '0 0 8px' }}>
        Keys are stored on your own server and never shown again — paste a new value to replace one.
      </p>
      <KeyRow
        label="Anthropic (Claude)" hint="Required — powers all of ForceAI's thinking & replies."
        link="https://console.anthropic.com/settings/keys"
        set={settings.anthropic_key_set} last4={settings.anthropic_key_last4}
        onSave={v => update({ anthropic_api_key: v } as Partial<Settings>)}
      />
      <KeyRow
        label="Google Gemini" hint="Optional — unlocks image generation (memes, visual roasts). Free tier available."
        link="https://aistudio.google.com/apikey"
        set={settings.gemini_key_set} last4={settings.gemini_key_last4} clearable
        onSave={v => update({ gemini_api_key: v } as Partial<Settings>)}
      />
      <KeyRow
        label="ElevenLabs" hint="Optional — unlocks spoken voice notes."
        link="https://elevenlabs.io/app/settings/api-keys"
        set={settings.elevenlabs_key_set} last4={settings.elevenlabs_key_last4} clearable
        onSave={v => update({ elevenlabs_api_key: v } as Partial<Settings>)}
      />
      {!settings.dashboard_protected && (
        <div className="settings-row">
          <div>
            <label style={{ color: 'var(--warn)' }}>⚠ Dashboard has no password</label>
            <div className="hint">Anyone who reaches this page can enter keys and spend your money. Set <b>DASHBOARD_PASSWORD</b> in your host's environment variables.</div>
          </div>
        </div>
      )}

      <h3 style={{ margin: '18px 0 4px' }}>Phone &amp; system</h3>

      <div className="settings-row">
        <div>
          <label>Typing indicators</label>
          <div className="hint">
            Shows "typing…" before replies. <b style={{ color: 'var(--warn)' }}>Keep OFF</b> — turning it ON
            makes WhatsApp think you're active on this device and <b>silences your phone's notification sounds</b>.
          </div>
        </div>
        <input
          type="checkbox"
          checked={settings.typing_indicators}
          onChange={e => update({ typing_indicators: e.target.checked })}
          style={{ width: 18, height: 18 }}
        />
      </div>

      <div className="settings-row">
        <div>
          <label>Token Reduction System</label>
          <div className="hint">Trims operator-override context from requests to lower token usage on busy chats.</div>
        </div>
        <input
          type="checkbox"
          checked={settings.token_reduction}
          onChange={e => update({ token_reduction: e.target.checked })}
          style={{ width: 18, height: 18 }}
        />
      </div>

      <WorldClock />

      <h3 style={{ margin: '18px 0 4px' }}>AI</h3>

      <div className="settings-row">
        <div>
          <label>Thinking-stage model</label>
          <div className="hint">Decides respond/wait/ignore. Sonnet = smarter, Haiku = faster + ~3x cheaper.</div>
        </div>
        <select
          value={settings.gatekeeper_model}
          onChange={e => update({ gatekeeper_model: e.target.value })}
        >
          <option value="sonnet">Sonnet 4.6</option>
          <option value="haiku">Haiku 4.5</option>
        </select>
      </div>

      <div className="settings-row">
        <div>
          <label>Reply-writing model</label>
          <div className="hint">Writes the actual messages it sends. Sonnet = wittier &amp; on-voice, Haiku = faster + much cheaper.</div>
        </div>
        <select
          value={settings.generation_model}
          onChange={e => update({ generation_model: e.target.value })}
        >
          <option value="sonnet">Sonnet 4.6</option>
          <option value="haiku">Haiku 4.5</option>
        </select>
      </div>

      <div className="settings-row">
        <div>
          <label>Reply effort</label>
          <div className="hint">How hard Sonnet thinks when writing replies. Low = snappy banter (recommended).</div>
        </div>
        <select value={settings.effort} onChange={e => update({ effort: e.target.value })}>
          <option value="low">Low</option>
          <option value="medium">Medium</option>
          <option value="high">High</option>
        </select>
      </div>

      <div className="settings-row">
        <div>
          <label>Daily budget (USD)</label>
          <div className="hint">When reached, ForceAI only answers direct mentions.</div>
        </div>
        <input
          type="number"
          min={0.5}
          step={0.5}
          defaultValue={settings.daily_budget_usd}
          onBlur={e => update({ daily_budget_usd: Number(e.target.value) })}
          style={{ width: 90 }}
        />
      </div>

      <div className="settings-row">
        <div>
          <label>Send introduction message</label>
          <div className="hint">When off, linking a group is silent — no intro is sent.</div>
        </div>
        <input
          type="checkbox"
          checked={settings.intro_enabled}
          onChange={e => update({ intro_enabled: e.target.checked })}
          style={{ width: 18, height: 18 }}
        />
      </div>

      {settings.intro_enabled && (
        <div className="settings-row">
          <div>
            <label>Introduction message</label>
            <div className="hint">Sent once, the first time a group is linked. (The AI marker prefix is added automatically.)</div>
          </div>
          <input
            defaultValue={settings.intro_message}
            onBlur={e => update({ intro_message: e.target.value })}
            style={{ width: 260 }}
          />
        </div>
      )}

      <div className="settings-row">
        <div>
          <label>AI message marker</label>
          <div className="hint">
            Prefix/suffix added to every AI text so the group can tell it apart from you.
            Preview: <b style={{ color: 'var(--text)' }}>{settings.msg_prefix}hello bro 💀{settings.msg_suffix}</b>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <input
            defaultValue={settings.msg_prefix}
            placeholder="prefix"
            onBlur={e => update({ msg_prefix: e.target.value })}
            style={{ width: 70 }}
          />
          <input
            defaultValue={settings.msg_suffix}
            placeholder="suffix"
            onBlur={e => update({ msg_suffix: e.target.value })}
            style={{ width: 70 }}
          />
        </div>
      </div>

      <div className="settings-row">
        <div>
          <label>Voice messages (ElevenLabs)</label>
          <div className="hint">
            {settings.voice_available
              ? 'AI can send spoken voice notes when the moment calls for it.'
              : 'Add an ElevenLabs key in API keys above to unlock.'}
          </div>
        </div>
        <input
          type="checkbox"
          checked={settings.voice_enabled}
          disabled={!settings.voice_available}
          onChange={e => update({ voice_enabled: e.target.checked })}
          style={{ width: 18, height: 18 }}
        />
      </div>

      {settings.voice_available && (
        <div className="settings-row">
          <div>
            <label>ElevenLabs voice ID</label>
            <div className="hint">Pick any voice from your ElevenLabs Voice Library and paste its ID.</div>
          </div>
          <input
            defaultValue={settings.voice_id}
            onBlur={e => update({ voice_id: e.target.value })}
            style={{ width: 220 }}
          />
        </div>
      )}

      <h3 style={{ margin: '18px 0 4px' }}>Rate limits</h3>

      <div className="settings-row">
        <div>
          <label>Max messages per minute</label>
          <div className="hint">Anti-spam / anti-ban cap per group. Hitting it shows "T0 RATE_CAP" in the feed.</div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <input
            type="range" min={1} max={20} step={1}
            value={settings.rate_per_min}
            onChange={e => update({ rate_per_min: Number(e.target.value) })}
            style={{ width: 130 }}
          />
          <span style={{ fontSize: 12, color: 'var(--accent)', width: 30 }}>{settings.rate_per_min}</span>
        </div>
      </div>

      <div className="settings-row">
        <div>
          <label>Max messages per hour</label>
          <div className="hint">The rolling-hour cap — this is usually the one that bites.</div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <input
            type="range" min={5} max={200} step={5}
            value={settings.rate_per_hour}
            onChange={e => update({ rate_per_hour: Number(e.target.value) })}
            style={{ width: 130 }}
          />
          <span style={{ fontSize: 12, color: 'var(--accent)', width: 30 }}>{settings.rate_per_hour}</span>
        </div>
      </div>

      <div className="settings-row">
        <div>
          <label>Hit the limit?</label>
          <div className="hint">Instantly forgets the rolling window for all groups so the bot can talk again.</div>
        </div>
        <button onClick={() => api('/api/ratelimit/reset', { method: 'POST', body: '{}' })}>
          ♻ Reset rate limit now
        </button>
      </div>

      <div className="settings-row">
        <div>
          <label>Super Idle after (minutes)</label>
          <div className="hint">After this long with nobody addressing it, ForceAI sleeps — no gatekeeper calls — until someone says "ForceAI", @mentions, or replies to it. 0 = never sleep.</div>
        </div>
        <input
          type="number" min={0} max={1440} step={5}
          defaultValue={settings.super_idle_minutes}
          onBlur={e => update({ super_idle_minutes: Number(e.target.value) })}
          style={{ width: 80 }}
        />
      </div>

      <h3 style={{ margin: '18px 0 4px' }}>Usage dials</h3>

      <FreqSlider
        label="Sticker usage"
        hint="How eagerly it reaches for stickers (text + sticker combos included)."
        value={settings.sticker_freq}
        onChange={v => update({ sticker_freq: v })}
      />
      <FreqSlider
        label="Voice note usage"
        hint={settings.voice_available ? 'How often replies become spoken voice notes.' : 'Add an ElevenLabs key (API keys above) + enable voice.'}
        value={settings.voice_freq}
        disabled={!settings.voice_available || !settings.voice_enabled}
        onChange={v => update({ voice_freq: v })}
      />
      <FreqSlider
        label="Emoji usage"
        hint="How emoji-heavy its texting style is."
        value={settings.emoji_freq}
        onChange={v => update({ emoji_freq: v })}
      />

      <FreqSlider
        label="Image generation usage"
        hint={settings.image_available
          ? `How eagerly it generates images (~$0.04 each). ${settings.images_today}/${settings.images_per_day} used today.`
          : 'Add a Gemini key (API keys above) + enable images below.'}
        value={settings.image_freq}
        disabled={!settings.image_available || !settings.image_enabled}
        onChange={v => update({ image_freq: v })}
      />

      <h3 style={{ margin: '18px 0 4px' }}>Image generation</h3>

      <div className="settings-row">
        <div>
          <label>Enable image generation</label>
          <div className="hint">
            {settings.image_available
              ? 'Lets ForceAI create & edit images (memes, roasts) via Google Gemini.'
              : 'Add a Gemini key in API keys above to unlock (free tier available).'}
          </div>
        </div>
        <input
          type="checkbox"
          checked={settings.image_enabled}
          disabled={!settings.image_available}
          onChange={e => update({ image_enabled: e.target.checked })}
          style={{ width: 18, height: 18 }}
        />
      </div>

      {settings.image_available && (
        <>
          <div className="settings-row">
            <div>
              <label>Image quality / model</label>
              <div className="hint">Nano Banana: $0.039, free up to 500/day. Pro: $0.134, text-perfect GPT-tier output.</div>
            </div>
            <select value={settings.image_model} onChange={e => update({ image_model: e.target.value })}>
              <option value="flash">Nano Banana (cheap)</option>
              <option value="pro">Nano Banana Pro (premium)</option>
            </select>
          </div>
          <div className="settings-row">
            <div>
              <label>Max images per day</label>
              <div className="hint">Hard cap across all groups. {settings.images_today} generated today.</div>
            </div>
            <input
              type="number" min={1} max={200} step={1}
              defaultValue={settings.images_per_day}
              onBlur={e => update({ images_per_day: Number(e.target.value) })}
              style={{ width: 80 }}
            />
          </div>
        </>
      )}

      <h3 style={{ margin: '18px 0 4px' }}>Character</h3>

      <div className="settings-row">
        <div>
          <label>Mood / style</label>
          <div className="hint">Adjusts ForceAI's vibe on top of its core personality. "Default" = the original, untouched.</div>
        </div>
        <select
          value={settings.persona_mode}
          onChange={e => update({ persona_mode: e.target.value })}
        >
          {settings.persona_presets.map(p => (
            <option key={p.value} value={p.value}>{p.label}</option>
          ))}
        </select>
      </div>

      <div className="settings-row" style={{ alignItems: 'flex-start', flexDirection: 'column', gap: 8 }}>
        <div>
          <label>Custom character instructions</label>
          <div className="hint">
            Free-form extras layered on top of the mood (e.g. "obsessed with Messi this week",
            "pretend you bet money on every match", "answer everything like a wise old man").
            Leave empty for none. Applies within ~a message or two.
          </div>
        </div>
        <textarea
          defaultValue={settings.persona_custom}
          placeholder="e.g. you are convinced you could beat everyone in this group at FIFA"
          onBlur={e => update({ persona_custom: e.target.value })}
          rows={3}
          style={{ width: '100%', resize: 'vertical', fontFamily: 'inherit' }}
        />
      </div>

      <h3 style={{ margin: '18px 0 4px' }}>AI initiative</h3>

      <div className="settings-row">
        <div>
          <label>Let ForceAI take initiative</label>
          <div className="hint">
            Uses principles learned from your <b>"Teach this move"</b> Influences to occasionally take initiative
            <i> within a live conversation</i> (a warm reply, a topic switch, a joke). It still stays quiet by
            default and never texts out of nowhere. Turn off to ignore the learned principles entirely.
          </div>
        </div>
        <input
          type="checkbox"
          checked={settings.initiative_enabled}
          onChange={e => update({ initiative_enabled: e.target.checked })}
          style={{ width: 18, height: 18 }}
        />
      </div>

      <InitiativePrinciples />

      <h3 style={{ margin: '18px 0 4px' }}>About</h3>
      <p className="hint" style={{ margin: '0 0 10px' }}>
        ForceAI is an AI member for WhatsApp group chats — it reads along and joins in with banter in the
        group's own voice, while you steer it from this dashboard. Built by Said.{' '}
        <a href="https://github.com/ma9197/ForceAI" target="_blank" rel="noreferrer">View the project ↗</a>
      </p>
      <div className="settings-row">
        <div>
          <label>Replay the setup guide</label>
          <div className="hint">Show the first-run welcome, key entry and tips again.</div>
        </div>
        <button onClick={() => { localStorage.removeItem('forceai_onboarded'); location.reload(); }}>↺ Re-run guide</button>
      </div>
    </div>
  );
}
