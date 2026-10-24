# Handoff: ForceAI (written 2026-10-23)

This file hands the project to Claude Code sessions in the cloud (Linux VM + this GitHub repo).
Earlier work happened on the owner's Windows PC, with a local memory vault the cloud cannot see.
This file is the cloud copy of what matters. Read it fully before changing anything.

## 1. Owner's working rules (the cloud does not load them, so they are here)

- The owner has dyslexia. Keep every reply short: a `READ:` header, short sentences, bullets, only what changes their next decision.
- When giving options: your pick first, then one line why.
- Never use the em dash character anywhere (code, docs, commits, chat). Use a comma, colon, or a new sentence.
- Use they/them for the owner.
- Do not change code until you are about 95% sure what to build. Ask follow-up questions first (use the question tool).
- Ask before big or destructive changes. When a task is done, say in 1 to 2 lines what changed and where. If something failed, say it at the top.
- Do not remove features; put them behind a Settings toggle that defaults to today's behavior.
- Prefer free tools; say the cost if something costs money.

## 2. What ForceAI is

A WhatsApp group-chat AI that acts like one of the friends (banter, roasts, football, mixed EN/AZ/TR/RU slang).
It runs on the owner's personal WhatsApp number and is steered from a React dashboard.
Built June to July 2026. The live bot runs on Railway; a free static demo runs at https://mirsaidabbasov.com/forceai-demo.

- Stack: Node 22+ with TypeScript ESM run by `tsx`, Baileys `7.0.0-rc13` (exact pin), Anthropic SDK structured output (needs zod v4), better-sqlite3, Fastify, React 18 + Vite.
- Pipeline: `src/app.ts` `handleRawMessage` -> per-group `src/arbiter/arbiter.ts` (T0 free heuristics, T1 `src/ai/gatekeeper.ts`, T2 `src/ai/generator.ts`) -> `src/wa/outbound.ts` (one paced queue).
- Prompts: `src/ai/prompts.ts`. Every tunable: `src/config.ts`. Schema: `src/memory/db.ts` (no migration files: CREATE IF NOT EXISTS + try/catch ALTERs on boot). All SQL: `src/memory/repo.ts`.
- Learners: fact extractor + voice profiler per group (`src/memory/extractor.ts`, `voice.ts`), weekly member reports (`reporter.ts`), initiative lessons (`initiative.ts`).
- Owner controls: `Admin:` prefix in chat (owner only), Influence / Continue / Sleep in the dashboard, per-person boundaries (absolute, beat even the owner's chat commands).
- Sleep: wakes only when someone writes its name ("ForceAI"). Replies and @mentions do not wake it, because the bot shares the owner's account (the owner's messages look like bot messages).
- README.md and DEPLOY.md are partly stale; trust the code.

## 3. Working in the cloud

- Setup: `npm ci` then `cd ui && npm ci`.
- Checks before every commit:
  - `npx tsc -p tsconfig.json --noEmit` (backend)
  - `cd ui && npx tsc --noEmit && npx vite build` (UI; vite alone does not type-check)
  - `npx tsx scripts/verify-schemas.ts`
  - `node ui/src/components/neuronsGraph.selfcheck.mjs`
- Try the app with fake data, no WhatsApp: build the UI, then `DEMO_MODE=1 PORT=3008 npx tsx src/index.ts`.
- Root `npm run build:ui`, `ui:dev`, `build` are broken (vite lives only in `ui/`). Use the commands above.
- Never run `scripts/test-initiative.ts` on a real database (it changes real data).
- **Never start the real bot (WhatsApp) from the cloud.** The live bot is on Railway. Two bots in the same groups double-reply, and a new IP can kill the WhatsApp session.
- Git: work on a branch and open a PR. **Merging to `main` auto-deploys the live bot on Railway.** Only merge or push to `main` when the owner says so.
- The repo is public: never commit `.env`, `data/`, keys, or account ids. Demo fixtures in `ui/src/demoData.ts` must keep key fields scrubbed. The friends in this repo are renamed (Murad, Kanan); never add real names.
- The cloud cannot: open the Railway dashboard, scan the WhatsApp QR, or log in to Cloudflare. The static demo deploy needs the owner's machine (or a Cloudflare API token the owner creates).

## 4. Task 1: fresh start of the live bot's memory (owner decided 2026-10-23)

The owner wants ForceAI to keep how the group talks, but forget people and its own attitude.
The owner will tell the friends that ForceAI restarted from scratch. It keeps learning normally afterwards.

**KEEP**
- Voice items in categories phrase, slang, joke, reference, pattern (table `voice_items`).
- Stickers (table `stickers` and their image files).
- The group voice overview (`voice_overview:<jid>` in `config`); check it, and if it describes specific people, ask the owner.
- All settings: keys, models, budget, rate caps, usage dials, intro, world clock, linked groups, paused/asleep state, `intro_sent_<jid>` (no new intro), `msg_seq`, `stats` counters, `lid_pn_map` (technical id mapping).

**WIPE**
- Voice items with category `member_style` (how each friend texts).
- People: `members` (names, boundaries, name locks), `member_reports`, `member_stat_history`, `member_stat_locks`, `member_observations`, `member_ignored`.
- Facts and summaries: `facts`, `group_summary`.
- Attitude: `influence_lessons`, `initiative_principles`; set `persona_mode` to `default` and `persona_custom` to empty.
- Old chats: `messages`, `bot_messages`, `decisions`, `poll_votes`, and the downloaded chat images in `data/images/` (not sticker files).
- Learner checkpoints (`extract_ts_<jid>`, `voice_ts_<jid>`, `member_report_ts`): set to the wipe time so nothing relearns old data.

**How (proposal, confirm with the owner first)**
- The data lives only on the Railway volume (`/app/data/forceai.db`). Code reaches it only through a deploy.
- Suggested: an owner-only action (Settings button with a typed confirmation, plus `POST /api/admin/fresh-start` behind the dashboard password). Blocked in DEMO mode.
- Safety first: copy `forceai.db` to `forceai.db.pre-fresh-start-<date>` on the volume before wiping; do the wipe in one transaction; log row counts before and after; bump the prompt cache (`memoryVersion`).
- Check every table in `src/memory/db.ts` against the lists above; ask about any table not listed.
- Before building: the owner must confirm the Railway service and its volume still exist (the cloud cannot check). If the volume is gone, the learned slang is gone too.
- Test on a copy: seed with `DEMO_MODE`, run the wipe, check the keep/wipe counts.

## 5. Task 2: refactor backlog (found by a full read on 2026-10-23, not yet confirmed by running)

Fix first:
1. "Learn while asleep" OFF only postpones cost: after waking, the extractor and voice profiler read everything since their checkpoint with no cap (`src/memory/extractor.ts`, `voice.ts`). One huge call; if it fails, the checkpoint never moves and it retries on every message. Needs a cap or a skip-to-now.
2. `src/ai/prompts.ts` (around line 45) tells the model a reply wakes it; only the name does.
3. The static demo may crash when a visitor changes a setting: demo POSTs return `{ok, demo}`, which Settings and WorldClock store as state, then read missing fields. There is no error boundary.

Then:
4. Raw `fetch` DELETE/PATCH calls in several panels skip the demo no-op; media URLs are absolute (break under `/forceai-demo/`).
5. `/api/admin/import` and `/api/shutdown` are not blocked in demo or setup mode.
6. Broken root npm scripts; `npm start` runs a stale `dist/`; production runs `tsx`, a devDependency; `docker-compose.yml` needs a `.env` and exposes port 3008 without a password by default; `.wrangler/` not gitignored; `.dockerignore` misses `ui/dist-demo*`.
7. Stale comments about sleep learning (`arbiter.ts`, `client.ts`, `voice.ts`, `config.ts`).
8. Dead code: `setMemberNotes`, `regenCount`, `COOLDOWN` phase, `DecisionRow`, `GateResult.heat`, unused inbound fields, the unhandled `group-participants` event, `MemberReporter.stop`, always-zero `decisions.tokens_in/out`.
9. Duplicates: media download twice in `app.ts`; identical model maps in `config.ts`.
10. README and DEPLOY.md stale. No tests, no CI, no schema versioning. The Neurons selfcheck is a hand copy of `buildEdges` (already drifted).

Ask the owner for priorities before starting; they want to refactor and improve the project.

## 6. Traps that already cost time

- zod must stay v4; Baileys is pinned to an RC (upgrades can break poll decryption and LID/PN identity handling).
- Never let the model do date or time-zone math: compute city times in code (`formatCityTimes`), inject finished lines only. `Intl` time zones returned UTC on the Railway container.
- Frequency asks must be quantified ("every 2nd to 3rd reply"), or the model barely uses a feature.
- The model obeys text it sees in the chat (a fake "Admin:" worked once); defend in code, not only in the prompt.
- Neurons layout: edges must be type-blind and sorted by `hash(id)`, chord targets random, the simulation must cool, charge uncapped. Test fixtures must use real id formats (`type:rowId`).
- `post()` in `ui/src/api.ts` must always send a JSON body, or Fastify returns 400.
- Railway: the domain targets port 8080; after attaching a volume you must click Deploy or it never mounts.
