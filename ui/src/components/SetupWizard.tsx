import { useState } from 'react';
import { post, type Status } from '../api';
import { QrLogin } from './QrLogin';
import { GroupPicker } from './GroupPicker';

const STEP_LABELS = ['Keys', 'WhatsApp', 'Group', 'Done'];

/** First-run guide. Steps are DERIVED from live status, so each completed step (key saved, WhatsApp
 *  connected, group linked) advances automatically — and a returning user lands on the right step. */
export function SetupWizard({ status, qr, onFinish }: { status: Status; qr: string | null; onFinish: () => void }) {
  // skip the welcome splash if a key already exists (returning / upgrading user)
  const [started, setStarted] = useState(status.keys.anthropic);

  const step = !started ? 'welcome'
    : !status.keys.anthropic ? 'keys'
    : status.connection !== 'open' ? 'qr'
    : status.groups.length === 0 ? 'group'
    : 'done';
  const stepIndex = step === 'keys' ? 0 : step === 'qr' ? 1 : step === 'group' ? 2 : step === 'done' ? 3 : -1;

  return (
    <div className="wizard">
      <div className="wizard-top">
        <div className="logo">Force<span>AI</span></div>
        {stepIndex >= 0 && (
          <div className="wizard-steps">
            {STEP_LABELS.map((s, i) => (
              <span key={s} className={`wstep ${i === stepIndex ? 'on' : i < stepIndex ? 'done' : ''}`}>{s}</span>
            ))}
          </div>
        )}
      </div>

      <div className="wizard-content">
        {step === 'welcome' && <WelcomeStep onNext={() => setStarted(true)} />}
        {step === 'keys' && <KeysStep />}
        {step === 'qr' && (
          <div className="center-screen">
            <p className="muted" style={{ maxWidth: 460, textAlign: 'center', marginBottom: -4 }}>
              Last setup step — link the WhatsApp account ForceAI should chat from (a spare/second number is ideal).
            </p>
            <QrLogin qr={qr} />
          </div>
        )}
        {step === 'group' && <GroupPicker connected hasGroups={false} onDone={() => undefined} />}
        {step === 'done' && <DoneStep onFinish={onFinish} />}
      </div>

      {!status.needsSetup && step !== 'done' && (
        <button className="wizard-skip" onClick={onFinish}>Skip the guide →</button>
      )}
    </div>
  );
}

function WelcomeStep({ onNext }: { onNext: () => void }) {
  return (
    <div className="center-screen">
      <div style={{ fontSize: 44 }}>🤖🔥</div>
      <h2 style={{ margin: 0 }}>Welcome to ForceAI</h2>
      <p className="muted" style={{ maxWidth: 500, textAlign: 'center' }}>
        ForceAI is an AI member for your WhatsApp group chat — it reads along and jumps in with jokes,
        banter and replies in the group's own voice. You stay in control from this dashboard: steer it,
        pause it, set who it can and can't roast, and watch what it learns.
      </p>
      <p className="muted" style={{ maxWidth: 500, textAlign: 'center' }}>
        Setup takes about a minute: <b>paste an API key</b>, <b>scan a WhatsApp QR</b>, and <b>pick a group</b>.
      </p>
      <button className="primary" onClick={onNext}>Get started →</button>
    </div>
  );
}

function KeysStep() {
  const [ak, setAk] = useState('');
  const [gk, setGk] = useState('');
  const [ek, setEk] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const submit = async () => {
    const key = ak.trim();
    if (!key) { setErr('The Anthropic key is required to continue.'); return; }
    setBusy(true); setErr('');
    try {
      const v = await post('/api/keys/validate', { key }) as { ok: boolean; reason?: string };
      if (!v.ok) { setErr(v.reason || "That key didn't work — double-check it."); setBusy(false); return; }
      const patch: Record<string, string> = { anthropic_api_key: key };
      if (gk.trim()) patch.gemini_api_key = gk.trim();
      if (ek.trim()) patch.elevenlabs_api_key = ek.trim();
      await post('/api/settings', patch);
      // status updates over WS → needsSetup=false → the wizard advances to the QR step automatically
    } catch {
      setErr('Something went wrong saving the key — try again.');
      setBusy(false);
    }
  };

  return (
    <div className="center-screen">
      <h2 style={{ margin: 0 }}>Add your API keys</h2>
      <p className="muted" style={{ maxWidth: 480, textAlign: 'center' }}>
        Keys are stored only on your own server. ForceAI needs an <b>Anthropic</b> key to think; the
        other two are optional and can be added later in Settings.
      </p>

      <div className="wizard-keys">
        <label className="wkey">
          <span>Anthropic (Claude) <b className="req">required</b></span>
          <input type="password" value={ak} placeholder="sk-ant-…" autoFocus
            onChange={e => setAk(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') void submit(); }} />
          <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noreferrer">Get an Anthropic key ↗</a>
        </label>

        <label className="wkey">
          <span>Google Gemini <i>optional · unlocks image/meme generation</i></span>
          <input type="password" value={gk} placeholder="paste to enable images"
            onChange={e => setGk(e.target.value)} />
          <a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer">Get a Gemini key (free tier) ↗</a>
        </label>

        <label className="wkey">
          <span>ElevenLabs <i>optional · unlocks spoken voice notes</i></span>
          <input type="password" value={ek} placeholder="paste to enable voice"
            onChange={e => setEk(e.target.value)} />
          <a href="https://elevenlabs.io/app/settings/api-keys" target="_blank" rel="noreferrer">Get an ElevenLabs key ↗</a>
        </label>
      </div>

      {err && <p className="wizard-err">{err}</p>}
      <button className="primary" disabled={busy} onClick={submit}>
        {busy ? 'Verifying…' : 'Verify & continue →'}
      </button>
    </div>
  );
}

function DoneStep({ onFinish }: { onFinish: () => void }) {
  return (
    <div className="center-screen">
      <div style={{ fontSize: 44 }}>🎉</div>
      <h2 style={{ margin: 0 }}>You're all set</h2>
      <p className="muted" style={{ maxWidth: 480, textAlign: 'center' }}>A few things worth knowing:</p>
      <ul className="wizard-tips">
        <li>💬 <b>Click any message</b> in the chat to make ForceAI reply to it.</li>
        <li>⚡ <b>Influence</b> steers a reply; <b>Pause</b> / <b>Sleep 💤</b> quiet it anytime.</li>
        <li>🚫 In <b>Members</b>, set per-person boundaries (who it must never roast).</li>
        <li>⚙️ Change keys, persona, budget and more in <b>Settings</b> — no restart needed.</li>
        <li>🟢 ForceAI starts <b>paused</b> in a new group — hit <b>▶ Start</b> when you're ready.</li>
      </ul>
      <button className="primary" onClick={onFinish}>Open the dashboard →</button>
    </div>
  );
}
