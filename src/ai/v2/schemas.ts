import { z } from 'zod';
import { ActionPlanSchema, ActionSchema } from '../schemas.js';

/**
 * Brain v2 structured outputs. Field ORDER is deliberate: the model fills fields top to bottom, so
 * the reading of the room, the "inner thought" and its scores are written BEFORE the decision or the
 * actions they should drive (reasoning first, verdict last).
 */

const VIBES = ['hype', 'banter', 'chill', 'heated', 'serious', 'dead'] as const;

export const SceneSchema = z.object({
  topic: z.string().describe('What the chat is about right now, a few words.'),
  threads: z.string().describe('Who is talking with whom about what, one short line. "quiet" if nothing is going on.'),
  vibe: z.enum(VIBES).describe('The energy of the last few minutes.'),
  running_bit: z.string().nullable().describe('A joke or bit the group is riffing on right now, or null.'),
  bit_played_out: z.boolean().describe('true if that bit has already been milked and one more joke on it would be stale.'),
});

const Score = z.number().describe('0-10');

export const GateV2Schema = z.object({
  scene: SceneSchema,
  addressed: z.boolean().describe('true only if a new message talks TO ForceAI or clearly ABOUT ForceAI.'),
  thought: z.object({
    text: z.string().describe('What ForceAI would say right now, rough wording, in the language it would use.'),
    why: z.string().describe('Why this would land, a few words.'),
  }).nullable().describe('Your best contribution to the conversation right now, even if nobody asked. null if nothing worth saying comes to mind.'),
  scores: z.object({
    relevance: Score.describe('0-10: connects to what they are talking about right now.'),
    novelty: Score.describe('0-10: adds something new (a take, a joke, a fact, a callback) instead of restating.'),
    humor: Score.describe('0-10: a friend would actually laugh or react. 5 = mild, 8+ = genuinely funny.'),
    timing: Score.describe('0-10: now is a natural moment to come in (a pause, a punchline landed, a question hanging). Low if someone is mid-story or two people are in a private back-and-forth.'),
    fit: Score.describe('0-10: matches the vibe and the people (no roasting someone who is genuinely down).'),
  }).describe('Scores for the thought. All 0 if thought is null. Be a harsh judge: most thoughts are 4-6.'),
  decision: z.enum(['RESPOND', 'WAIT', 'IGNORE', 'REACT']),
  react: z.object({
    target_message_id: z.string().describe('Short id (like m41) of the message to react to.'),
    emoji: z.string().describe('One emoji.'),
  }).nullable().describe('Only for REACT: a single emoji reaction instead of words. Otherwise null.'),
  reason: z.string().describe('Why, in 15 words or fewer. Shown on the operator dashboard.'),
  address_message_ids: z.array(z.string()).describe('Short ids of the messages a response should engage. Empty if not RESPOND.'),
  wait_ms: z.number().nullable().describe('Only for WAIT: ms to wait for more messages (2000-15000).'),
});
export type GateV2Out = z.infer<typeof GateV2Schema>;

export const DEVICES = [
  'callback', 'escalation', 'deadpan', 'understatement', 'absurd_comparison', 'fake_agreement',
  'misdirection', 'specific_detail', 'self_own', 'hot_take', 'question_back', 'reaction_only', 'sincere', 'answer',
] as const;

export const PlanV2Schema = z.object({
  read: z.object({
    happening: z.string().describe('One line: what is really going on (the dynamic, not a list of messages).'),
    subtext: z.string().describe('For the key message: literal words -> what they really mean -> do they clash (then it is irony, sarcasm, bait or a bit). Also who is joking and who is serious.'),
    vibe: z.enum(VIBES),
    sincere: z.boolean().describe('true when someone is genuinely down, stressed or asking for real help: drop the bit and be a real friend for a moment.'),
  }),
  angles: z.array(z.object({
    idea: z.string().describe('The move in a few words, not the final text.'),
    device: z.enum(DEVICES),
  })).describe('2-3 genuinely different angles. The first idea that comes to mind is usually the most predictable one.'),
  pick: z.number().describe('0-based index of the angle you go with.'),
  actions: z.array(ActionSchema).describe('Actions executed in order. Usually 1-2, max 4. [{"type":"nothing"}] to stay silent.'),
  note: z.string().describe('One-line internal rationale (shown only on the operator dashboard).'),
  observation: ActionPlanSchema.shape.observation,
});
export type PlanV2Out = z.infer<typeof PlanV2Schema>;

/** One cheap rewrite pass when the linter finds AI tells in the plan. */
export const RewriteSchema = z.object({
  fixes: z.array(z.object({
    index: z.number().describe('Index of the action, as given.'),
    text: z.string().describe('The rewritten text: same meaning and language, fixed problem, sounds like a friend texting.'),
  })),
});
export type RewriteOut = z.infer<typeof RewriteSchema>;
