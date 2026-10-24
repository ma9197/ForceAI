import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GEMINI_TTS } from '../src/config.js';
import { geminiTts, stripVoiceTags, synthesizeVoice, voiceAvailable, voiceProvider } from '../src/voice/tts.js';

// Voice notes without any real API: fetch is faked, ffmpeg is real (it must be installed).
const pcm = Buffer.alloc(24000 * 2); // 1 s of a 440 Hz tone, 16-bit LE mono @ 24 kHz
for (let i = 0; i < 24000; i++) pcm.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / 24000) * 8000), i * 2);
const audioJson = { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/L16;codec=pcm;rate=24000', data: pcm.toString('base64') } }] } }] };

const calls: string[] = [];
let script: (url: string) => Response = () => new Response('{}', { status: 500 });
globalThis.fetch = (async (url: any, init: any) => {
  calls.push(String(url));
  if (String(url).includes('generativelanguage')) {
    const body = JSON.parse(init.body);
    assert.equal(body.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, 'Puck');
    assert.match(body.contents[0].parts[0].text, /^Say like a pirate: hello \[laughs\]$/);
  }
  return script(String(url));
}) as any;

// 1. first model unknown (404) -> next model answers; output is real Ogg/Opus
script = (url) => url.includes(GEMINI_TTS.MODELS[0]) ? new Response('not found', { status: 404 }) : Response.json(audioJson);
const ogg = await geminiTts('hello [laughs]', 'Puck', 'like a pirate', 'key');
assert.ok(ogg, 'audio returned');
assert.equal(ogg!.subarray(0, 4).toString(), 'OggS');
const tmp = path.join(os.tmpdir(), `voice-test-${process.pid}.ogg`);
fs.writeFileSync(tmp, ogg!);
const probe = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,sample_rate,channels', '-of', 'csv=p=0', tmp]).toString().trim();
fs.rmSync(tmp);
assert.equal(probe, 'opus,48000,1');
assert.equal(calls.length, 2);

// 2. the model that worked is tried first next time
calls.length = 0;
assert.ok(await geminiTts('hello [laughs]', 'Puck', 'like a pirate', 'key'));
assert.equal(calls.length, 1);
assert.ok(calls[0].includes(GEMINI_TTS.MODELS[1]));

// 3. a rejected key stops at once
calls.length = 0;
script = () => new Response('denied', { status: 403 });
assert.equal(await geminiTts('hello [laughs]', 'Puck', 'like a pirate', 'key'), null);
assert.equal(calls.length, 1);

// 4. every model out of quota -> null after trying all
calls.length = 0;
script = () => new Response('quota', { status: 429 });
assert.equal(await geminiTts('hello [laughs]', 'Puck', 'like a pirate', 'key'), null);
assert.equal(calls.length, GEMINI_TTS.MODELS.length);

// 5. engine choice + fallback to ElevenLabs (tags stripped for it)
const fakeRepo = (cfg: Record<string, string>, keys: string[]) => ({
  getConfig: (k: string) => cfg[k] ?? null,
  hasKey: (k: string) => keys.includes(k),
  getKey: (k: string) => (keys.includes(k) ? 'key' : ''),
}) as any;
assert.equal(voiceProvider(fakeRepo({}, ['elevenlabs_api_key'])), 'elevenlabs', 'unset + ElevenLabs key = old behavior');
assert.equal(voiceProvider(fakeRepo({}, ['gemini_api_key'])), 'gemini');
assert.equal(voiceProvider(fakeRepo({ voice_provider: 'gemini' }, ['elevenlabs_api_key'])), 'gemini');
assert.equal(voiceAvailable(fakeRepo({ voice_provider: 'gemini' }, ['elevenlabs_api_key'])), false);
let elevenText = '';
script = (url) => {
  if (url.includes('elevenlabs')) return new Response(Buffer.from('OggS-eleven'));
  return new Response('quota', { status: 429 });
};
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: any, init: any) => {
  if (String(url).includes('elevenlabs')) elevenText = JSON.parse(init.body).text;
  return realFetch(url, init);
}) as any;
const both = fakeRepo({ voice_provider: 'gemini', voice_style: 'like a pirate', gemini_voice: 'Puck' }, ['gemini_api_key', 'elevenlabs_api_key']);
const fell = await synthesizeVoice(both, 'hello [laughs]');
assert.equal(fell?.toString(), 'OggS-eleven');
assert.equal(elevenText, 'hello');

assert.equal(stripVoiceTags('[sighs] fine, you win [laughs] again'), 'fine, you win again');
console.log('voice: all checks passed');
