# Handoff: ForceAI (written 2026-10-23)

Current tasks for Claude Code cloud sessions. Rules, project map, checks and traps are in `CLAUDE.md` (loaded automatically).

## Task 1: fresh start of the live bot's memory (owner decided 2026-10-23)

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

**Status (2026-10-24): built, waiting for the owner**
- Code: Settings, "Backup & fresh start" (`ui/src/components/FreshStart.tsx`), routes `GET/POST /api/admin/fresh-start` and `GET /api/admin/export`, logic in `src/memory/freshStart.ts` and `src/memory/backup.ts`, wiring in `App.freshStart()`. Test: `npx tsx scripts/test-fresh-start.ts` (temp DB only).
- Owner decisions on 2026-10-24: voice overview is always wiped. Kept items lose any link to a person: `member_jid` cleared, and an AI pass (Sonnet, a few cents) rewrites names out of content and example. Changed items show as unreviewed in the Voice tab. A backup download button was added.
- Also wiped: old superseded versions of voice items (never shown or used, may name people).
- Order: lock learners and replies, wait for in-flight AI calls, AI name pass, then synchronously: disk check, `VACUUM INTO data/forceai.db.pre-fresh-start-<date-time>`, wipe in one transaction, delete `data/images/*`, VACUUM, exit(1) so Railway restarts with clean caches. Any failure before the wipe changes nothing.
- Railway: the trial had expired (service offline). The owner bought Hobby on 2026-10-24. Trial volumes are deleted 30 days after expiry, so first confirm the volume still has the data.
- Fresh start is locked until a backup download has fully streamed in the last 24 hours (config `backup_downloaded_at`). Railway volume backups need the Pro plan, so this download is the real backup.
- Owner steps: after deploy, Power off in the dashboard (keeps the bot quiet with its old memory), Settings, Download backup (keep it private: it holds the WhatsApp login and API keys), Fresh start and type FRESH START, Power on (scan the QR if WhatsApp logged it out), then review the highlighted items in the Voice tab.

**Update 2026-10-24 (later):** the owner's button run failed (most likely the AI name pass ran inside the HTTP request and timed out). Fixed: the fresh start now runs as a background job with progress in Settings, the AI pass runs 4 chunks in parallel, and a failing chunk falls back to a code swap of known names. The owner then asked Claude to do it for them: `AUTO_FRESH_START` in `src/memory/freshStart.ts` runs it once on boot, before WhatsApp connects, where a backup was downloaded since 2026-10-24 and no fresh start finished after it. It expires on 2026-10-31; remove it after that.

## Brain v2 (built 2026-10-24 night, owner's /goal)

- Owner asked for a smarter, more human, less cringe brain that also jumps in unprompted, as "version 2", testable per group while every group stays on v1.
- Built and deployed in four PRs (#5 base, #6 second opinion + owner calls + scoreboard, #7 room check + reception + replay, #8 running bits + own takes + natural texting): see `docs/brain-v2.md` (research, design, testing plan). v1 parity proven with `scripts/v1-request-dump.ts` before every merge.
- Not yet run against real Claude: the cloud has no API key. The first real test is the owner's.
- Owner's morning test: open one active group, Compare v1 / v2, click "Replay last hours with v2" (6 small calls), then "Run comparison" during live chat. If it looks good, switch that group to Brain v2 (beta). Rate lines and `T1v2` decisions with 👍 / 👎.
- What to watch in the feed: `T1v2` lines show urge vs bar and what moved the bar (`pair talking +0.8`, `2 ignored +0.5`). `T2v2` notes show the angle, rewrites, `split in 2`, and "second opinion said skip".
- Tuning knobs: `POLICY` in `src/ai/v2/policy.ts` (bar and room weights), `BRAIN_V2` in `src/config.ts`, prompts in `src/ai/v2/prompts.ts`, per-group chattiness in the Compare panel. Tune from real feedback, one change at a time.

## Task 2: refactor backlog (found by a full read on 2026-10-23, not yet confirmed by running)

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
