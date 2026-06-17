# ForceAI 💀

An AI member for your WhatsApp group chats. It logs in as a WhatsApp account (QR-linked device), reads along in the groups you pick, and joins in with Gen-Z group-chat energy — texts, quoted replies, emoji reactions, voice notes, memes and stickers it learns. A web dashboard gives you full control: steer it, set per-person boundaries, inspect what it learns, and watch costs.

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/new/template?template=https://github.com/ma9197/ForceAI)

> ⚠️ Uses an unofficial WhatsApp library (Baileys). Automation violates WhatsApp's ToS and can get a number banned — use a spare/second number. Human-like pacing, rate caps and a budget cutoff are built in, but the risk is never zero.

## Get started — no config files to edit

There's nothing to hand-edit. On first launch the dashboard shows a **setup guide** that walks you through everything: paste your **Anthropic API key** (the only required one — [get one here](https://console.anthropic.com/settings/keys)), optionally add Gemini (images) and ElevenLabs (voice), then **scan the WhatsApp QR** and **pick a group**.

**Deploy your own online (no terminal, no Windows):**

1. Sign in to [Railway](https://railway.com) (free trial — you pay only your own usage). Click **Deploy on Railway** above, or in Railway do **New Project → Deploy from GitHub repo → ForceAI**.
2. Railway builds it from this repo's Dockerfile (~2–3 min) and gives you a private URL.
3. In the service's **Variables**, set `DASHBOARD_PASSWORD` to something long & random — this is what stops strangers opening your dashboard (and entering keys that spend your money).
4. Recommended: **Settings → Volumes → Add a Volume**, mount path `/app/data`. This keeps the bot's memory + WhatsApp login across redeploys (skip it and they reset each deploy).
5. Open your URL → the **setup guide** walks you through the rest: paste your **Anthropic key** (required — [get one](https://console.anthropic.com/settings/keys)), optionally add Gemini (images) / ElevenLabs (voice), **scan the WhatsApp QR**, and **pick a group**.

Use a **spare / second WhatsApp number** — automation can get a number banned. Running cost ≈ your Anthropic usage + a few \$/month of Railway.

**Run it locally (Windows):**
1. Install [Node.js 22+](https://nodejs.org).
2. `npm install`, then `cd ui && npm install && cd ..`
3. `npm run build:ui`
4. Double-click **start.bat** (or `npm run dev`) → open <http://localhost:3008> → follow the setup guide.

**Just want to look around?** Try the **[live demo](https://mirsaidabbasov.com/forceai-demo)** — a read-only walkthrough with fake data, no setup. (Run locally with `DEMO_MODE=1` for the same thing.)

The demo is a fully static site (no backend): with `VITE_DEMO_STATIC=1`, `api()` serves bundled fixtures from `ui/src/demoData.ts` and the WebSocket is a no-op. It's hosted on Cloudflare Pages (the `forceai-demo` project) and surfaced at `mirsaidabbasov.com/forceai-demo` via a small reverse-proxy Worker (`cf-demo-proxy/`). To rebuild + redeploy (use a shell that won't mangle the `--base` arg, e.g. PowerShell):
`cd ui && VITE_DEMO_STATIC=1 vite build --base=/forceai-demo/ --outDir dist-demo`, place the output under a `forceai-demo/` folder, then `wrangler pages deploy <wrapped-dir> --project-name forceai-demo`.

## Using it

- **It decides when to talk.** Incoming messages are batched (3–9s adaptive debounce). A "gatekeeper" model decides respond / wait / ignore; the generator then writes the actual actions. Direct @mentions, replies to the bot, or "forceai" in a message get a fast path. Reaction spam ("💀💀") after the bot speaks is usually ignored on purpose.
- **Teach stickers:** open your self-chat (message yourself), send `Sticker`, then the sticker, then what it means (e.g. "get a load of this guy"). It appears in the dashboard's Stickers tab and the bot will deploy it when it fits.
- **Steer from inside the chat:** your own messages are ignored, EXCEPT ones starting with `Admin:` — e.g. `Admin: ask Kanan which club he supports`. The bot obeys, smoothly and in character.
- **Steer from the dashboard:** the **Influence** box does the same thing from the browser; **Continue ▶** forces it to say something right now without any trigger.
- **Polls:** the bot creates WhatsApp polls on its own when the moment calls for it (roast votes, settling debates) — and it **sees the vote results live** (votes are decrypted and fed into its context, and show up in the dashboard feed), so it can react to who voted what.
- **Voice notes (optional):** add an ElevenLabs key in the dashboard (setup guide, or Settings → API keys) and flip "Voice messages" on in Settings — the bot will occasionally reply with a spoken voice note (ElevenLabs `eleven_flash_v2_5`, sent as a native WhatsApp voice note). Pick any voice ID from your ElevenLabs library in Settings. If TTS fails, it falls back to text automatically.
- **Image understanding (built in):** when a member sends a photo, ForceAI can see it (Claude vision, ~$0.005/image) and react to what's actually in it.
- **Image generation (optional):** add a Gemini key in the dashboard (free tier available) and enable it in Settings — the bot can generate memes/roast pictures and even meme-ify a photo someone sent. Default model is Nano Banana ($0.039); a Settings toggle upgrades to Nano Banana Pro ($0.134) for text-perfect output. Frequency dial defaults to "rare" with a daily image cap, and generations count against the daily budget.
- **AI message marker:** every AI text is wrapped with a configurable prefix/suffix (default `🤖 `) so the group can always tell the bot's messages from yours. Edit it in Settings.
- **Memory:** the Memory tab shows every member and the facts the bot has learned about them (✕ deletes a fact). Facts and the group summary persist across restarts.
- **Settings:** switch the thinking-stage model between Sonnet (smarter) and Haiku (faster/cheaper), set reply effort, and a daily USD budget — when reached, the bot only answers direct mentions.
- **Pause** button stops all responses instantly (it keeps reading/learning).

## How it works (short version)

```
WhatsApp (Baileys v7) → normalizer → arbiter state machine
  T0: free heuristics  — adaptive debounce, hard triggers, cooldowns, rate caps
  T1: gatekeeper model — RESPOND / WAIT / IGNORE (structured output)
  T2: claude-sonnet-4-6 — persona + member facts + sticker library + transcript
        → action plan: message / reply / reaction / sticker / nothing
→ outbound executor — typing indicator, human-paced delays, single send queue
```

Memory (members, facts, stickers, summary, stats) lives in `data/forceai.db` (SQLite). WhatsApp session lives in `data/auth/` — delete it to force a new QR login. The persona is built from `ai_chat_training_data.txt`.

## Costs

The persona prompt is cached (1h TTL), so a typical reply costs ~$0.01; gatekeeper checks ~$0.001–0.005. The Stats tab tracks tokens, cache hits and spend live.
