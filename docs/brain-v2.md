# Brain v2: research and plan

READ:
- Every group runs **brain v1** until you change it. Nothing changes by itself.
- **Morning test (10 min), in one active group:**
  1. Under the chat: **Compare v1 / v2**, then **Replay last hours with v2**. You see what v2 would have done at 6 moments, next to what really happened, and the exact line it would have sent for up to 2 of them (it only knows what had happened by then). Nothing is sent.
  2. Top bar: **v1 + v2 shadow (watch only)**. v1 keeps answering; grey "v2 shadow would ..." rows show v2's calls all day, and "v2 shadow would say" rows show the exact line it would have sent.
  3. Now and then: **Blind test** in the Compare panel. Pick A or B; it tracks which brain wins.
  4. If v2 wins: top bar, **Brain v2 (beta)**. Switch back the same way any time.
- **Teach it**: tap 👍 / 👎 on its lines and on its `T1v2` / shadow rows. Every 8 ratings it learns a few "house rules" for that group (Compare panel: see, relearn, clear).
- **Too loud or too quiet**: chattiness in the Compare panel (this group) or Settings (all groups).
- **Safety net**: if v2 keeps failing, that group answers with v1 for 30 minutes ("on v1 until ..." in the top bar). Direct questions are always answered. The Compare panel shows a red "v2 calls failed N times" line when any call failed in the last 24 hours (it has never run against the real API before your test).
- **Cost**: a bit more per message than v1. Shadow adds one cheap call per decision, plus 2 to 3 calls when it would speak (it writes the line; Settings, "Brain v2 shadow: write its lines"). Use Haiku 5.5 for the thinking stage.

## What v2 does differently

| v2 feature | What it means in the chat | Based on |
|---|---|---|
| Inner thought with an "urge" score | While reading, it writes the line it would say and scores it (relevance, new, funny, timing, fit). It speaks only when the score clears a bar. | Inner Thoughts (Liu et al., CHI 2025) |
| Talk-share bar | The more it has talked lately, the higher the bar. The longer it was quiet, the lower. Above 45% of the chat it only answers when asked. | Time to Talk (EMNLP 2025, LLMafia) |
| "Funny or new" rule | An unprompted line must be funny or add something new. On-topic but flat is not enough. | Our own finding while testing the policy |
| Reactions instead of words | It can just tap 😂 on a message, like people do. No reply-writing call needed. | HUMA (2025), Inner Thoughts |
| Saved thought at a pause | A good line at a bad moment (someone mid-story) is kept, and offered once when the chat pauses for a minute. | Inner Thoughts |
| Read the room first | Before writing, it states what was literally said, what is meant, and whether those clash (sarcasm, bait, a bit). It also flags sincere moments. | SarcasmCue chain of contradiction (AAAI 2025), SimToM |
| Irony cues in our languages | Code flags likely irony in the last minutes: phrases that are sarcastic far more often than not ("yeah right", "ага, щас", "кто бы сомневался", "ne demezsin", "çox bilirsən"...), a dry "very funny" with no laugh, an eye-roll / smirk / clown emoji, claps between words, a clear alphabet switch, or "jk" / "шучу" / "zarafat edirəm" right after their own line (that line was the joke). A question the asker takes back ("nvm found it", "забей", "boş ver") is no longer an open question. Everyday sincere words ("aynen", "çox sağ ol", "thanks a lot") are deliberately not cues. Both stages get hints; the model decides. | LLMs miss mixed-language sarcasm without help (arXiv 2602.21933); language switching marks humor and sarcasm (ACL 2020) |
| Several angles, pick one | It lists 2-3 different moves with a named joke type (callback, deadpan, escalation, fake agreement...) and picks the best, instead of the first obvious joke. | Joke-generation studies (2024-2025): brainstorming beats first draft |
| Measured style card | Real numbers from the chat: typical length, lowercase share, emoji rate, languages. It writes inside those numbers. | Computational Turing Test (2025), Jones and Bergen (2025): style decides "human or bot" |
| Its own tics | It sees the emojis, openers and phrases it overuses (like 💀 in 14 of 25 messages) and avoids them. Same for reactions: if it tapped 😂 three of the last six times, it is told to vary. | ChatGPT repeats the same jokes (2023) |
| No recycled jokes | A line that shares most of its words with something it said lately is dropped, not only exact copies. | ChatGPT repeats the same jokes (arXiv 2306.04563) |
| What landed | Its recent lines that got laughs (😂 reactions, "hahaha" replies), so it learns this group's humor. | HUMA reflection step |
| Callbacks | Older messages from this chat that match today's topic, for callback jokes. Among equally good matches, the moments that made people laugh back then (laugh reactions or laughing replies quoting them) come first and are marked "(got laughs from 2)": a callback to a line that landed tends to land again. Copying one word for word counts as a repeat. A replay never counts laughs that came after its moment. Looks back 90 days (`BRAIN_V2.CALLBACK_DAYS`), which keeps the search fast in a big chat. | Generative Agents memory retrieval (2023) |
| Your taste (👍 / 👎) | Your latest liked lines in that group are shown as examples to aim for. Disliked lines are never shown (that can plant them): code keeps them out of what it learns from, and blocks close copies. Per group: groups never share memory. | Research brief #1: owner-labelled examples instead of training |
| Easy on one person | If it aimed at the same friend in 4 of its last 15 lines, it is told to give them a break. | Research brief #7: roast budget |
| How each friend takes its digs | Measured per person: after each of its recent lines aimed at one friend (their name or a quote of their message), did that friend laugh (😂, "hahaha") or push back ("not funny", "отстань", "bəsdir", 🙄)? Friends who push back get lighter teasing; friends who laugh can take more. | Research brief #7: roast budget, made personal |
| Thought seeds the reply | When it jumps in because of its inner thought, the reply writer gets that thought, so the jump-in keeps its reason. | Inner Thoughts |
| Second opinion | Before an unprompted line goes out, a second quick call plays a sharp friend and says send or skip. Skip means silence. Never used when someone asked it or you gave an instruction. Settings toggle, on by default. | Research brief: pairwise judge beats single scoring (arXiv 2603.12520) |
| House rules from your ratings | Every 8 new ratings in a group, one cheap call distills your latest likes, dislikes and decision calls into 3 to 6 short rules ("keep jump-ins to one line"). Both stages follow them. Phrased as what to do, never quoting a line. Per group; wiped by fresh start. | Learning from human feedback without training: distilled principles, like the initiative distiller |
| Your calls on its decisions (👍 / 👎 on `T1v2`) | You mark "spoke" or "stayed quiet" as a good or bad call. Your latest calls are shown to the thinking stage as examples. | Research brief #1: owner-labelled examples |
| Room check in code | Measured facts about the chat right now: two people in a back-and-forth (bar +0.8), someone mid-story (+0.5), a question nobody answered (-0.5). Shown to the thinking stage and moved on the bar. | Speak or Stay Silent (2026), MUCA (2024): models are bad at "when" on their own |
| Joins a hype moment like a friend | When 2+ people shout within 90 seconds ("GOOOOL", "goaaal", "ГОЛЛЛ", "LETS GOOO!!", caps; laughing in caps and loud goodbyes do not count), both stages read it as: a fast few words or a reaction is how friends join in. A longer jump-in then goes back for one quick rewrite; someone who asked it something still gets a real (short) answer. | Human group-chat rhythm; X-Turing, Stephanie2 (2025): short bursts read as human |
| Knows a rhetorical question | "who even watches that?", "how is that not a penalty?", "кто вообще так играет?", "ты серьёзно?", "ne alaka?", "bu nədi belə?" or "he did WHAT!?" is likely venting or sarcasm: not counted as an open question (no lower bar), and both stages read it as "answer what they mean, not the literal question". Questions that ask for a fact (time, place, score, what happened) never count. | Answering sarcasm literally is a classic bot tell (prompt review) |
| Notices the chat winding down | Goodbyes and goodnights in code ("gn", "спокойной", "gecən xeyrə", "iyi geceler", "ok bye"; words like "пока" or "hələlik" only as a whole message, never a question). When the newest message is a goodbye, or two people said bye and went quiet, the bar for unprompted lines goes up by 1 and both stages are told: nobody starts something new now; if someone talks to it, a short bye back. | How friends close a chat; MUCA (2024): when to stay out |
| Who is doing what | Per person, last 15 minutes, measured in code: how much they wrote, worked up (caps, "!!"), laughing, asked something nobody answered, may be going through something real, who they are talking to. Plus the reply chains running right now (from quotes). | SimToM perspective taking (arXiv 2311.10227); conversation disentanglement: models lose track of interleaved threads |
| Reads its own reception | If its last unprompted lines got no laugh, reply or reaction, it raises its own bar (+0.5 for 2 ignored, +1 for 3+). If its last one got pushback ("cringe", "not funny", "не смешно", 🙄 / 👎 on it), +0.8: pushback is not engagement. If they got laughs, the bar drops a little. | HUMA reflection step, in code |
| What makes the group laugh | The friends' own lines that made 2+ people laugh lately ("hahaha" right after, 😂 reactions), as examples of the humor that works there. | Research brief #5: the group's real messages as examples |
| Bad news safety net | Words like "passed away", "hospital", "funeral" (also in Russian, Azerbaijani, Turkish) make it careful even if the model misread the mood: higher bar, no 😂 reactions, no stickers or voice notes. Slang like "I'm dead" or "öldüm" does not count. | Humor hurts in serious moments (2024) |
| Same language as the person | A reply in another alphabet than the message it answers (Russian vs Latin letters) is sent back for one quick fix. So is a Turkish answer to an Azerbaijani message (models drift from Azerbaijani into Turkish): checked in code with words and endings that exist in only one of the two, typed with or without the special letters, and only when the room is clearly Azerbaijani and its line has at least two Turkish markers. Never the other way: Azerbaijani friends borrow Turkish slang ("aynen kanka"). | Mixed-language studies (2026); language confusion in LLMs: models often answer in the wrong language (arXiv 2406.20052, EMNLP 2024) |
| The group's own bits | Phrases at least two friends used on at least two different days (like "bro is cooked"), with who said them and when. Old ones are marked "cooling off". Exact words, no summary. | GroupMemBench (2026): plain word matching beats summarized memory in group chats |
| Its own takes | Its predictions and verdicts from the last 7 days ("madrid wins 2-1, trust me"), so it stays consistent, says "told you", or owns a miss. | Persona drift (arXiv 2511.00222), BeliefShift (2026) |
| Quotes like the group does | If people here almost never quote-reply (under 15%), it does not quote the message right above either. | Measured style, like the style card |
| Two short texts | In a group that texts in bursts, one longer two-sentence text is sent as two short messages. | X-Turing, Stephanie2 (2025): bursts read as human |
| Takes a roast | When someone roasts it, it hits back lighter or owns it, in one line. | Persona craft |
| Always answers when asked | When someone talks to it, the reply writer is told so: it answers (a reaction is enough if they only laughed). Silence is only an option for lines nobody asked for. | Prompt review, round 5 |
| Calibrated scores | The thinking stage gets 6 short worked examples (mid-story: wait, strong callback: speak, private logistics: ignore, a friend's great roast: react, a rhetorical question: a deadpan take, a goal shout: react) so its 0-10 scores mean the same thing every time. Humor and novelty are judged harshly, the rest plainly. | Few-shot calibration |
| Your dials win | Your emoji dial, character adjustment and boundaries win over v2's own style rules. | Prompt review, round 5 |
| Shadow mode | v1 acts, v2 thinks along on the same messages (dry run, never sends) and logs what it would have done. When it would speak, it also writes the line it would have sent (Settings toggle, on by default; 2 to 3 AI calls each: reply, second opinion, sometimes a quick fix). You can rate its decision rows ("v2 shadow would ...") too; the lines it would say are for reading. A whole day of comparison with zero risk. | Off-policy evaluation, the usual way to test a new policy safely |
| Blind A/B test | Both brains answer the same moment; you see A and B without labels and pick. The tally removes "I know which one is new" bias. | Pairwise preference judging (arXiv 2603.12520) |
| One compact "ROOM NOW" block | All measured facts about the room (bad news, an open question, who talks with whom, possible irony, moods, your share and reception) in one block of facts, each said once; what they mean is explained once in the cached system prompt. One "lines that worked here" list instead of three. One-line clock. About 30% smaller thinking-stage message, 14% smaller reply-writer message. | Prompt audit, round 11 |
| Anti-cringe linter (code) | Fixes or flags AI tells before sending: assistant phrases, "not just X but Y", semicolons, hashtags, long dashes, essays, repeats, parroting, 3+ texts in a row, ending on a question to the room just to keep it going ("thoughts?", "а вы как думаете?", "siz nə düşünürsünüz?"), the "ah, the..." opener, stock AI joke phrases ("plot twist", "the audacity") unless the group says them itself. In a group that never ends its own lines on a laugh, a typed "lol" / "hahaha" at the end of its line is cut. One cheap rewrite only when needed. In serious moments it holds back stickers, voice notes and polls. When the group types lowercase, so does it. | Antislop (ICLR 2026), Wikipedia's signs of AI writing, LLMafia |

What stays the same in v2: the persona, the training examples, all memory (facts, voice profile, member reads, stickers), boundaries, owner commands, "Admin:" protection, sleep, rate limits, budget, dials.

## How the decision works (v2)

1. Cheap code checks first (same as v1): direct mention, reply to the bot, "Admin:" impersonation, sleep, rate limit, budget.
2. Thinking stage (gatekeeper v2) returns: the scene, whether the bot was addressed, an inner thought, five 0-10 scores, a suggested decision, an optional reaction.
3. Code (`src/ai/v2/policy.ts`) decides:
   - addressed: answer (or wait if they are still typing)
   - urge = 0.25 relevance + 0.2 novelty + 0.25 humor + 0.2 timing + 0.1 fit
   - bar = 6.5 (chattiness: quiet +1, chatty -1, per group or Settings), +0.7 if the bot is 20%+ of recent messages, +1.5 if 35%+, +1 if it spoke under 45 s ago, +1 in a serious vibe (or bad news found in code), minus 0.04 per human message since it last spoke (at most 1)
   - room check: two people talking +0.8, someone mid-story +0.5, an open question -0.5, its own lines ignored +0.5 to +1, its lines landing -0.3 (shown in the feed, like `pair talking +0.8`)
   - speak unprompted only if urge >= bar, humor or novelty >= 6, and talk share under 45%
   - the model said IGNORE but the thought is great (urge >= bar + 1, timing >= 6): speak anyway
   - otherwise react with an emoji if one was suggested (never a laughing one on bad news), or stay quiet
4. Reply writing (generator v2) reads the room, picks an angle, writes, then the linter checks it.
5. Unprompted only: the second opinion says send or skip (Settings, **Brain v2 second opinion**).

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

## Speed (measured, fake AI, 112k-message chat)

v2's own code per turn: about 13 ms in the thinking stage and 16 ms in the writer once warm. The first turn after 30 minutes also counts the group's running phrases (about 40 to 80 ms, then cached). A replay moment costs about 60 ms of code (nothing cached, by design). The AI calls themselves take far longer; these numbers are the time the bot's single event loop is busy.

## Files

- `src/ai/v2/brain.ts`: the v2 gatekeeper and generator, context assembly, lint and rewrite.
- `src/ai/v2/policy.ts`: turn-taking in code (urge, bar, share cap).
- `src/ai/v2/signals.ts`: measured style card, tics, talk share, laughs, callbacks, room check, reception, bad news words, running bits, own takes.
- `src/ai/v2/replay.ts`: which moments the replay looks at.
- `src/ai/v2/lint.ts`: anti-cringe checks and fixes.
- `src/ai/v2/prompts.ts`, `src/ai/v2/schemas.ts`: v2 prompt text and JSON shapes.
- Switch: `Repo.getBrainVersion` / `getBrainMode` (config `brain_v2_<group>`: `0`, `shadow`, `1`), `POST /api/brain`, top-bar selector.
- Shadow: `Arbiter.shadowV2` (tier `S1v2`). Blind test: `POST /api/brain/ab`, table `brain_ab`.
- Preview: `App.previewBrains`, `POST /api/brain/preview`, `ui/src/components/BrainPreview.tsx`.
- Scoreboard: `Repo.brainV2Stats`, `GET /api/brain/stats`.
- Learning loop: `src/ai/v2/taste.ts` (`TasteLearner`), `GET/POST /api/brain/taste`, config `v2_taste_rules_<group>`.
- Replay: `App.replayV2`, `POST /api/brain/replay`. Per-group chattiness: `Repo.getV2Chattiness`, `POST /api/brain/chattiness`.
- Owner feedback: `POST /api/feedback` (👍 / 👎 on lines), `POST /api/decision-feedback` (👍 / 👎 on decisions).
- Tests: `scripts/test-brain-v2.ts`, `scripts/test-arbiter-v2.ts`, `scripts/test-brain-v2-e2e.ts` (real arbiter + real v2 brain, fake API), `scripts/fuzz-brain-v2.ts [rounds] [seed]` (3000 random rounds passed; slowest call 57 ms, the cached bits table). v1 parity: `scripts/v1-request-dump.ts`.
- Safety net: `Arbiter.v2Result` (`BRAIN_V2.FALLBACK_AFTER`, `FALLBACK_MS`).

## Testing plan for the owner

1. Pick one active group. Open **Compare v1 / v2**, click **Replay last hours with v2**. Read where it would speak and what it would say.
2. Put that group on **v1 + v2 shadow** for a day. Read the grey shadow rows, rate a few. Do a **Blind test** now and then.
3. If v2 looks better (and wins the blind tests), switch that group to **Brain v2 (beta)**. Leave the others on v1.
4. Watch the live feed: `T1v2` lines show why it spoke or stayed quiet (urge vs bar). Tap 👍 or 👎 on them and on its lines. If it talks too much or too little, change chattiness.
5. After a day, compare: did the friends react more to v2's lines? Did anyone call it cringe?

## Ideas not built yet

- Reply timing based on reading time plus thinking time (shared with v1, so left alone).
