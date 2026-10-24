import assert from 'node:assert/strict';
import { AiClient } from '../src/ai/client.js';
import { CLAUDE_CHOICES, PRICING, THINKING_HEADROOM_TOKENS } from '../src/config.js';

// Per-model request settings for the thinking stage ('quick') and reply writing ('reply'). No API calls.
const cfg: Record<string, string> = { effort: 'medium' };
const ai = new AiClient({ getConfig: (k: string) => cfg[k] ?? null, getKey: () => '' } as any);

// 5.5 models think by default: more room, and low effort on the quick path
assert.deepEqual(ai.tuning('claude-sonnet-5-5', 1500, 'quick'), { max_tokens: 1500 + THINKING_HEADROOM_TOKENS, effort: 'low' });
assert.deepEqual(ai.tuning('claude-opus-5-5', 2000, 'reply'), { max_tokens: 2000 + THINKING_HEADROOM_TOKENS, effort: 'medium' });
assert.deepEqual(ai.tuning('claude-haiku-5-5', 1500, 'quick'), { max_tokens: 1500 + THINKING_HEADROOM_TOKENS, effort: 'low' });
// old models: exactly as before (Sonnet 4.6 quick sends no effort, reply keeps the setting)
assert.deepEqual(ai.tuning('claude-sonnet-4-6', 1500, 'quick'), { max_tokens: 1500 });
assert.deepEqual(ai.tuning('claude-sonnet-4-6', 2000, 'reply'), { max_tokens: 2000, effort: 'medium' });
// Haiku 4.5 rejects effort, so it never gets one
assert.deepEqual(ai.tuning('claude-haiku-4-5', 2000, 'reply'), { max_tokens: 2000 });

// every choice maps to a priced model; old stored keys still mean the old models
for (const id of Object.values(CLAUDE_CHOICES)) assert.ok(PRICING[id], `${id} has a price`);
cfg.gatekeeper_model = 'haiku55'; cfg.generation_model = 'opus55';
assert.equal(ai.gatekeeperModel, 'claude-haiku-5-5');
assert.equal(ai.generationModel, 'claude-opus-5-5');
cfg.gatekeeper_model = 'sonnet';
assert.equal(ai.gatekeeperModel, 'claude-sonnet-4-6');
console.log('models: all checks passed');
