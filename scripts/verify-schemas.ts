import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { GateResultSchema, ActionPlanSchema, FactExtractionSchema, VoiceProfileSchema, MemberReportSchema, BatchReportSchema, InitiativePrinciplesSchema, VoiceAnonymizeSchema } from '../src/ai/schemas.js';
import { GateV2Schema, PlanV2Schema, RewriteSchema } from '../src/ai/v2/schemas.js';

for (const [name, schema] of Object.entries({ GateResultSchema, ActionPlanSchema, FactExtractionSchema, VoiceProfileSchema, MemberReportSchema, BatchReportSchema, InitiativePrinciplesSchema, VoiceAnonymizeSchema, GateV2Schema, PlanV2Schema, RewriteSchema })) {
  const format = zodOutputFormat(schema as any);
  if (!(format as any).schema) throw new Error(`${name}: no schema produced`);
  console.log(`${name}: OK`);
}
console.log('zodOutputFormat works for all schemas');
