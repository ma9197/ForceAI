import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { GateResultSchema, ActionPlanSchema, FactExtractionSchema, VoiceProfileSchema, MemberReportSchema, BatchReportSchema } from '../src/ai/schemas.js';

for (const [name, schema] of Object.entries({ GateResultSchema, ActionPlanSchema, FactExtractionSchema, VoiceProfileSchema, MemberReportSchema, BatchReportSchema })) {
  const format = zodOutputFormat(schema as any);
  if (!(format as any).schema) throw new Error(`${name}: no schema produced`);
  console.log(`${name}: OK`);
}
console.log('zodOutputFormat works for all schemas');
