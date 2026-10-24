# Brain v2: research and plan

READ:
- Every group still runs **brain v1** by default. Nothing changes until you switch a group.
- To try v2 in a group: open the group, top bar, choose **Brain v2 (beta)**. Switch back the same way.
- To compare before switching: **Compare v1 / v2** under the chat. It shows what each brain would send right now. Nothing is sent.
- v2's goal: talk less but better, get irony, sound like a friend, jump in only when it has something good.
- Teach it your taste: tap 👍 or 👎 on the bot's lines in the live feed. v2 reads your latest likes and dislikes.
- Too chatty or too quiet: Settings, **Brain v2 chattiness** (quiet, balanced, chatty).
- Cost: a v2 group costs a bit more per message read (a longer thinking step). Pick Haiku 5.5 for the thinking stage to keep it cheap.

## What v2 does differently

| v2 feature | What it means in the chat | Based on |
|---|---|---|
| Inner thought with an "urge" score | While reading, it writes the line it would say and scores it (relevance, new, funny, timing, fit). It speaks only when the score clears a bar. | Inner Thoughts (Liu et al., CHI 2025) |
| Talk-share bar | The more it has talked lately, the higher the bar. The longer it was quiet, the lower. Above 45% of the chat it only answers when asked. | Time to Talk (EMNLP 2025, LLMafia) |
| "Funny or new" rule | An unprompted line must be funny or add something new. On-topic but flat is not enough. | Our own finding while testing the policy |
| Reactions instead of words | It can just tap 😂 on a message, like people do. No reply-writing call needed. | HUMA (2025), Inner Thoughts |
| Saved thought at a pause | A good line at a bad moment (someone mid-story) is kept, and offered once when the chat pauses for a minute. | Inner Thoughts |
| Read the room first | Before writing, it states what was literally said, what is meant, and whether those clash (sarcasm, bait, a bit). It also flags sincere moments. | SarcasmCue chain of contradiction (AAAI 2025), SimToM |
| Several angles, pick one | It lists 2-3 different moves with a named joke type (callback, deadpan, escalation, fake agreement...) and picks the best, instead of the first obvious joke. | Joke-generation studies (2024-2025): brainstorming beats first draft |
| Measured style card | Real numbers from the chat: typical length, lowercase share, emoji rate, languages. It writes inside those numbers. | Computational Turing Test (2025), Jones and Bergen (2025): style decides "human or bot" |
| Its own tics | It sees the emojis, openers and phrases it overuses (like 💀 in 14 of 25 messages) and avoids them. | ChatGPT repeats the same jokes (2023) |
| What landed | Its recent lines that got laughs (😂 reactions, "hahaha" replies), so it learns this group's humor. | HUMA reflection step |
| Callbacks | Older messages from this chat that match today's topic, for callback jokes. | Generative Agents memory retrieval (2023) |
| Your taste (👍 / 👎) | Your latest liked and disliked lines (all groups) are shown as examples of what to aim for and avoid. | Research brief #1: owner-labelled examples instead of training |
| Easy on one person | If it aimed at the same friend in 4 of its last 15 lines, it is told to give them a break. | Research brief #7: roast budget |
| Thought seeds the reply | When it jumps in because of its inner thought, the reply writer gets that thought, so the jump-in keeps its reason. | Inner Thoughts |
| Anti-cringe linter (code) | Fixes or flags AI tells before sending: assistant phrases, "not just X but Y", semicolons, hashtags, long dashes, essays, repeats, parroting, 3+ texts in a row. One cheap rewrite only when needed. In serious moments it holds back stickers, voice notes and polls. When the group types lowercase, so does it. | Antislop (ICLR 2026), Wikipedia's signs of AI writing, LLMafia |

What stays the same in v2: the persona, the training examples, all memory (facts, voice profile, member reads, stickers), boundaries, owner commands, "Admin:" protection, sleep, rate limits, budget, dials.

## How the decision works (v2)

1. Cheap code checks first (same as v1): direct mention, reply to the bot, "Admin:" impersonation, sleep, rate limit, budget.
2. Thinking stage (gatekeeper v2) returns: the scene, whether the bot was addressed, an inner thought, five 0-10 scores, a suggested decision, an optional reaction.
3. Code (`src/ai/v2/policy.ts`) decides:
   - addressed: answer (or wait if they are still typing)
   - urge = 0.25 relevance + 0.2 novelty + 0.25 humor + 0.2 timing + 0.1 fit
   - bar = 6.5 (Settings chattiness: quiet +1, chatty -1), +0.7 if the bot is 20%+ of recent messages, +1.5 if 35%+, +1 if it spoke under 45 s ago, +1 in a serious vibe, minus 0.04 per human message since it last spoke (at most 1)
   - speak unprompted only if urge >= bar, humor or novelty >= 6, and talk share under 45%
   - the model said IGNORE but the thought is great (urge >= bar + 1, timing >= 6): speak anyway
   - otherwise react with an emoji if one was suggested, or stay quiet
4. Reply writing (generator v2) reads the room, picks an angle, writes, then the linter checks it.

Every v2 decision shows in the live feed as `T1v2` (with urge and bar) and `T2v2` (with the angle and any fixes).

## Research summary (sources)

Top techniques found, ranked by impact on "feels like a real, funny friend" against cost:

1. Talk-share cap in code. Time to Talk, arXiv 2506.05309 (code: github.com/niveck/LLMafia). LLMs are poor at deciding when to speak without help: Speak or Stay Silent, arXiv 2603.11409; MultiLIGHT, arXiv 2304.13835.
2. Inner-thought urge score. Inner Thoughts, arXiv 2501.00383 (code: github.com/xybruceliu/thoughtful-agents). Users preferred it in 82% of comparisons.
3. Anti-AI style checks plus one targeted rewrite. Antislop, arXiv 2510.15061. Naming banned phrases in a prompt can plant them ("pink elephant", arXiv 2402.07896), so the ban list lives in code.
4. A specific human persona. Jones and Bergen, arXiv 2503.23674 (GPT-4.5 judged human 73% with a persona) and arXiv 2405.08007 (judges decide mostly on style and social cues).
5. The group's real messages as style examples. arXiv 2511.04195, arXiv 2509.14543 (2 examples help, 10 add little).
6. Read the subtext first. SarcasmCue, arXiv 2407.12725; pragmatics primers, arXiv 2510.26253; SimToM, arXiv 2311.10227; mixed-language sarcasm is harder, arXiv 2602.21933.
7. Room mood and a sincere switch. Humor hurts in serious moments, arXiv 2410.20468; saved memory raises sycophancy, arXiv 2509.12517 (so v2 is told to disagree about 1 time in 5).
8. Human pacing and reactions. HUMA, arXiv 2511.17315 (people could not tell it from a human); Stephanie2, arXiv 2601.05657.
9. A running-bits table for callbacks. Generative Agents, arXiv 2304.03442.
10. Several joke angles, then pick. arXiv 2405.07280, arXiv 2508.11429; LLMs repeat jokes, arXiv 2306.04563; pairwise picking beats single scoring, arXiv 2603.12520.

Measuring: Inverse Turing Bench, arXiv 2606.21844; Collective Turing Test, arXiv 2511.08592; MUCA (what, when, who for group bots), arXiv 2401.04883.

Note: the research agent could only open GitHub and Anthropic pages directly; most paper facts come from abstracts.

## Files

- `src/ai/v2/brain.ts`: the v2 gatekeeper and generator, context assembly, lint and rewrite.
- `src/ai/v2/policy.ts`: turn-taking in code (urge, bar, share cap).
- `src/ai/v2/signals.ts`: measured style card, tics, talk share, laughs, callbacks.
- `src/ai/v2/lint.ts`: anti-cringe checks and fixes.
- `src/ai/v2/prompts.ts`, `src/ai/v2/schemas.ts`: v2 prompt text and JSON shapes.
- Switch: `Repo.getBrainVersion` (config `brain_v2_<group>`), `POST /api/brain`, top-bar selector.
- Preview: `App.previewBrains`, `POST /api/brain/preview`, `ui/src/components/BrainPreview.tsx`.
- Tests: `scripts/test-brain-v2.ts`, `scripts/test-arbiter-v2.ts`. v1 parity: `scripts/v1-request-dump.ts`.

## Testing plan for the owner

1. Pick one active group. Click **Compare v1 / v2** a few times during a live chat. Read both columns.
2. If v2 looks better, switch that group to **Brain v2 (beta)**. Leave the others on v1.
3. Watch the live feed: `T1v2` lines show why it spoke or stayed quiet (urge vs bar). If it talks too much or too little, tell Claude which way.
4. After a day, compare: did the friends react more to v2's lines? Did anyone call it cringe?

## Ideas not built yet

- Pairwise "which would a real member send" judge for unprompted lines (costs one more call).
- A real bits table (jokes that got 2+ laughs, retired when they stop landing). Partly covered by "what landed".
- Reply timing based on reading time plus thinking time (shared with v1, so left alone).
- Thumbs up / down on the v2 decisions themselves (spoke vs stayed quiet), retrieved as examples for the thinking stage.
