# ForceAI 💀

An AI member for your WhatsApp group chats. It logs in as a WhatsApp account (QR-linked device), reads along in the groups you pick, and joins in with Gen-Z group-chat energy — texts, quoted replies, emoji reactions, voice notes, memes and stickers it learns. A web dashboard gives you full control: steer it, set per-person boundaries, inspect what it learns, and watch costs.

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/new/template?template=https://github.com/ma9197/ForceAI)

> ⚠️ Uses an unofficial WhatsApp library (Baileys). Automation violates WhatsApp's ToS and can get a number banned — use a spare/second number. Human-like pacing, rate caps and a budget cutoff are built in, but the risk is never zero.

## Get started — no config files to edit

There's nothing to hand-edit. On first launch the dashboard shows a **setup guide** that walks you through everything: paste your **Anthropic API key** (the only required one — [get one here](https://console.anthropic.com/settings/keys)), optionally add Gemini (images) and ElevenLabs (voice), then **scan the WhatsApp QR** and **pick a group**.

**Run it online (no terminal, no Windows):** click **Deploy on Railway** above → you get your own private instance → open its URL → the setup guide takes over. You bring your own API key and pay only your own usage. For real use, add a Railway **Volume** mounted at `/app/data` (so memory survives redeploys) and set a `DASHBOARD_PASSWORD` (so only you can open it).

**Run it locally (Windows):**
1. Install [Node.js 22+](https://nodejs.org).
2. `npm install`, then `cd ui && npm install && cd ..`
3. `npm run build:ui`
4. Double-click **start.bat** (or `npm run dev`) → open <http://localhost:3008> → follow the setup guide.

**Just want to look around?** Run with `DEMO_MODE=1` for a read-only demo with fake seeded data — no keys, no WhatsApp, nothing to set up.

## Using it

- **It decides when to talk.** Incoming messages are batched (3–9s adaptive debounce). A "gatekeeper" model decides respond / wait / ignore; the generator then writes the actual actions. Direct @mentions, replies to the bot, or "forceai" in a message get a fast path. Reaction spam ("💀💀") after the bot speaks is usually ignored on purpose.
- **Teach stickers:** open your self-chat (message yourself), send `Sticker`, then the sticker, then what it means (e.g. "get a load of this guy"). It appears in the dashboard's Stickers tab and the bot will deploy it when it fits.
- **Steer from inside the chat:** your own messages are ignored, EXCEPT ones starting with `Admin:` — e.g. `Admin: ask Ayxan which club he supports`. The bot obeys, smoothly and in character.
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
