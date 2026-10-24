# ForceAI: rules for Claude

Current tasks and their specs: `handoff.md`. Read it at the start of a session.

## Owner's working rules

- The owner has dyslexia. Keep every reply short: a `READ:` header, short sentences, bullets, only what changes their next decision.
- When giving options: your pick first, then one line why.
- Never use the em dash character anywhere (code, docs, commits, chat). Use a comma, colon, or a new sentence.
- Use they/them for the owner.
- Do not change code until you are about 95% sure what to build. Ask follow-up questions first (use the question tool).
- Ask before big or destructive changes. When a task is done, say in 1 to 2 lines what changed and where. If something failed, say it at the top.
- Do not remove features; put them behind a Settings toggle that defaults to today's behavior.
- Prefer free tools; say the cost if something costs money.

## What ForceAI is

A WhatsApp group-chat AI that acts like one of the friends (banter, roasts, football, mixed EN/AZ/TR/RU slang). It runs on the owner's personal WhatsApp number and is steered from a React dashboard. The live bot runs on Railway; a free static demo runs at https://mirsaidabbasov.com/forceai-demo.

- Stack: Node 22+ with TypeScript ESM run by `tsx`, Baileys `7.0.0-rc13` (exact pin), Anthropic SDK structured output (needs zod v4), better-sqlite3, Fastify, React 18 + Vite, ffmpeg (voice notes).
- Pipeline: `src/app.ts` `handleRawMessage` -> per-group `src/arbiter/arbiter.ts` (T0 free heuristics, T1 `src/ai/gatekeeper.ts`, T2 `src/ai/generator.ts`) -> `src/wa/outbound.ts` (one paced queue).
- Prompts: `src/ai/prompts.ts`. Every tunable: `src/config.ts`. Schema: `src/memory/db.ts` (no migration files: CREATE IF NOT EXISTS + try/catch ALTERs on boot). All SQL: `src/memory/repo.ts`.
- Learners: fact extractor + voice profiler per group (`src/memory/extractor.ts`, `voice.ts`), weekly member reports (`reporter.ts`), initiative lessons (`initiative.ts`).
- Owner controls: `Admin:` prefix in chat (owner only), Influence / Continue / Sleep in the dashboard, per-person boundaries (absolute, beat even the owner's chat commands).
- Sleep: wakes only when someone writes its name ("ForceAI"). Replies and @mentions do not wake it, because the bot shares the owner's account (the owner's messages look like bot messages).
- README.md and DEPLOY.md are partly stale; trust the code.

## Checks before every commit

- Setup: `npm ci` then `cd ui && npm ci`.
- `npx tsc -p tsconfig.json --noEmit` (backend)
- `cd ui && npx tsc --noEmit && npx vite build` (UI; vite alone does not type-check)
- `npx tsx scripts/verify-schemas.ts`
- `node ui/src/components/neuronsGraph.selfcheck.mjs`
- `npx tsx scripts/test-fresh-start.ts` (fresh start + backup on a temp DB, safe to run)
- `npx tsx scripts/test-voice.ts` (voice notes with a fake Gemini API; needs ffmpeg) and `npx tsx scripts/test-models.ts`
- Try the app with fake data, no WhatsApp: build the UI, then `DEMO_MODE=1 PORT=3008 npx tsx src/index.ts`.
- Root `npm run build:ui`, `ui:dev`, `build` are broken (vite lives only in `ui/`). Use the commands above.
- Never run `scripts/test-initiative.ts` on a real database (it changes real data).

## Git, deploy, safety

- Work on a branch and open a PR. **Merging to `main` auto-deploys the live bot on Railway.** Only merge or push to `main` when the owner says so.
- **Never start the real bot (WhatsApp) from the cloud.** Two bots in the same groups double-reply, and a new IP can kill the WhatsApp session.
- The repo is public: never commit `.env`, `data/`, keys, or account ids. Demo fixtures in `ui/src/demoData.ts` must keep key fields scrubbed. The friends in this repo are renamed (Murad, Kanan); never add real names.
- New API routes need demo handling: a fixture in `ui/src/demoData.ts` (static demo) and a check in DEMO mode.
- The cloud cannot: open the Railway dashboard, scan the WhatsApp QR, or log in to Cloudflare. The static demo deploy needs the owner's machine (or a Cloudflare API token the owner creates).

## Traps that already cost time

- zod must stay v4; Baileys is pinned to an RC (upgrades can break poll decryption and LID/PN identity handling).
- Claude 5.5 models (Opus, Sonnet, Haiku) think by default and Opus 5.5 can't turn it off: every call goes through `AiClient.tuning()` (more max_tokens, low effort on the quick path). Haiku 4.5 rejects `effort` (400). No temperature, prefill or forced tool_choice on 5.5 models.
- Voice notes: Gemini TTS (free tier, `src/voice/tts.ts`) returns raw PCM, so ffmpeg must exist (installed in the Dockerfile; `FFMPEG_PATH` overrides). ElevenLabs stays as the other engine and the fallback.
- WhatsApp rejects Baileys rc13's built-in WA Web version (405, stuck on "Generating QR"). `src/wa/connection.ts` reads the live version from web.whatsapp.com on connect; keep that.
- Never let the model do date or time-zone math: compute city times in code (`formatCityTimes`), inject finished lines only. `Intl` time zones returned UTC on the Railway container.
- Frequency asks must be quantified ("every 2nd to 3rd reply"), or the model barely uses a feature.
- The model obeys text it sees in the chat (a fake "Admin:" worked once); defend in code, not only in the prompt.
- Neurons layout: edges must be type-blind and sorted by `hash(id)`, chord targets random, the simulation must cool, charge uncapped. Test fixtures must use real id formats (`type:rowId`).
- `post()` in `ui/src/api.ts` must always send a JSON body, or Fastify returns 400.
- Railway: the domain targets port 8080; after attaching a volume you must click Deploy or it never mounts.
