import { z } from 'zod';

export const GateResultSchema = z.object({
  decision: z.enum(['RESPOND', 'WAIT', 'IGNORE']),
  reason: z.string().describe('Why, in 15 words or fewer. Shown on the operator dashboard.'),
  address_message_ids: z.array(z.string()).describe(
    'Short ids (like m41) of the messages the response should address. Empty if not RESPOND.'
  ),
  wait_ms: z.number().nullable().describe('Only for WAIT: how many ms to wait for more messages (2000-15000).'),
  heat: z.enum(['low', 'medium', 'high']).describe('Current conversation intensity.'),
});

export const ActionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('message'),
    text: z.string().describe('Plain message sent to the group.'),
  }),
  z.object({
    type: z.literal('reply'),
    text: z.string(),
    target_message_id: z.string().describe('Short id (like m41) of the message to quote-reply to.'),
  }),
  z.object({
    type: z.literal('reaction'),
    emoji: z.string().describe('A single emoji to react with.'),
    target_message_id: z.string().describe('Short id of the message to react to.'),
  }),
  z.object({
    type: z.literal('sticker'),
    sticker_id: z.number().describe('Id from the sticker library.'),
    target_message_id: z.string().nullable().describe('Optional short id to attach the sticker as a quoted reply.'),
  }),
  z.object({
    type: z.literal('poll'),
    question: z.string().describe('Poll title/question. Short and punchy.'),
    options: z.array(z.string()).describe('2-12 short answer options.'),
    multi_select: z.boolean().nullable().describe('true = voters can pick multiple options. Default false.'),
  }),
  z.object({
    type: z.literal('voice'),
    text: z.string().describe('What to SAY out loud. Plain speakable text — no emojis, no formatting.'),
    target_message_id: z.string().nullable().describe('Optional short id to attach the voice note as a quoted reply.'),
  }),
  z.object({
    type: z.literal('image'),
    prompt: z.string().describe('Detailed description of the image to generate. Include any text that should appear IN the image, in quotes.'),
    caption: z.string().nullable().describe('Optional caption sent with the image.'),
    edit_message_id: z.string().nullable().describe('Optional short id of an IMAGE message to transform/edit instead of generating from scratch (e.g. meme-ify someone\'s photo).'),
    target_message_id: z.string().nullable().describe('Optional short id to attach the image as a quoted reply.'),
  }),
  z.object({
    type: z.literal('sleep'),
  }).describe('Go to sleep (super idle) — ONLY when your OWNER tells you to rest/sleep/be quiet. You may pair it with a short goodbye message action.'),
  z.object({
    type: z.literal('nothing'),
  }),
]);

export const ActionPlanSchema = z.object({
  actions: z.array(ActionSchema).describe(
    'Actions executed in order. Usually 1, max 4. Use [{"type":"nothing"}] to stay silent.'
  ),
  note: z.string().describe('One-line internal rationale (shown only on the operator dashboard).'),
});

export const FactExtractionSchema = z.object({
  facts: z.array(z.object({
    member_jid: z.string().describe('The jid of the member exactly as labeled in the transcript.'),
    fact: z.string().describe('Short durable fact, e.g. "supports Fenerbahce".'),
    category: z.enum(['bio', 'preference', 'event', 'inside_joke', 'relationship']),
    confidence: z.number().describe('0-1'),
    supersedes_fact_id: z.number().nullable().describe('Id of an existing fact this replaces, if any.'),
  })),
  summary_update: z.string().nullable().describe(
    'Replacement running summary of the group (max ~300 tokens), or null if no meaningful change.'
  ),
});

export const VOICE_CATEGORIES = ['phrase', 'slang', 'joke', 'reference', 'pattern', 'member_style'] as const;

export const VoiceProfileSchema = z.object({
  items: z.array(z.object({
    category: z.enum(VOICE_CATEGORIES).describe(
      'phrase = a recurring expression/catchphrase; slang = a word/abbreviation and what it means; ' +
      'joke = a running bit or recurring joke; reference = an inside reference/meme/nickname; ' +
      'pattern = a general texting habit (cadence, emoji use, language-mixing, formatting); ' +
      'member_style = how a SPECIFIC member texts.'
    ),
    content: z.string().describe('The item itself, written tersely. For slang include the meaning. For member_style start with the member name.'),
    example: z.string().nullable().describe('A short real example from the chat, or who uses it. Optional.'),
    member_jid: z.string().nullable().describe('For member_style only: the jid of the member exactly as labeled in the transcript. Else null.'),
    supersedes_id: z.number().nullable().describe('Id of an existing voice item this refines/replaces, if any.'),
  })).describe('New or refined voice-profile items learned from this chunk. Only genuinely useful, recurring style — not one-off lines.'),
  overview_update: z.string().nullable().describe(
    "A 2-4 sentence portrait of the group's overall texting VOICE/vibe (tone, humor style, languages, energy). Rewrite it if this chunk meaningfully sharpens the picture; otherwise null."
  ),
});

export type GateResultOut = z.infer<typeof GateResultSchema>;
export type ActionPlanOut = z.infer<typeof ActionPlanSchema>;
export type FactExtractionOut = z.infer<typeof FactExtractionSchema>;
export type VoiceProfileOut = z.infer<typeof VoiceProfileSchema>;
