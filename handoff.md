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

**How (proposal, confirm with the owner first)**
- The data lives only on the Railway volume (`/app/data/forceai.db`). Code reaches it only through a deploy.
- Suggested: an owner-only action (Settings button with a typed confirmation, plus `POST /api/admin/fresh-start` behind the dashboard password). Blocked in DEMO mode.
- Safety first: copy `forceai.db` to `forceai.db.pre-fresh-start-<date>` on the volume before wiping; do the wipe in one transaction; log row counts before and after; bump the prompt cache (`memoryVersion`).
- Check every table in `src/memory/db.ts` against the lists above; ask about any table not listed.
- Before building: the owner must confirm the Railway service and its volume still exist (the cloud cannot check). If the volume is gone, the learned slang is gone too.
- Test on a copy: seed with `DEMO_MODE`, run the wipe, check the keep/wipe counts.

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
