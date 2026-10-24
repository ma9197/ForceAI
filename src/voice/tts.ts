import { spawn } from 'node:child_process';
import { ELEVENLABS, GEMINI_TTS, type VoiceProvider } from '../config.js';
import { logger } from '../logger.js';
import type { Repo } from '../memory/repo.js';

/**
 * Voice notes: text -> Ogg/Opus buffer (WhatsApp's native voice-note format). Two engines:
 * Google Gemini TTS (free tier, same key as images) and ElevenLabs. Every function returns null on
 * failure; callers fall back to sending text.
 */

/** Engine for voice notes. Unset = the behavior before Gemini existed: ElevenLabs when its key is set. */
export function voiceProvider(repo: Repo): VoiceProvider {
  const v = repo.getConfig('voice_provider');
  if (v === 'gemini' || v === 'elevenlabs') return v;
  return repo.hasKey('elevenlabs_api_key') ? 'elevenlabs' : 'gemini';
}

/** The chosen engine has its key, so voice notes can be sent. */
export function voiceAvailable(repo: Repo): boolean {
  return repo.hasKey(voiceProvider(repo) === 'gemini' ? 'gemini_api_key' : 'elevenlabs_api_key');
}

/** Delivery tags like [laughs] are for Gemini; other engines would read them out loud. */
export function stripVoiceTags(text: string): string {
  return text.replace(/\[[^\]]{1,40}\]/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

/** Render a voice note with the chosen engine; if that fails, try the other one when its key is set. */
export async function synthesizeVoice(repo: Repo, text: string): Promise<Buffer | null> {
  const first = voiceProvider(repo);
  for (const engine of first === 'gemini' ? ['gemini', 'elevenlabs'] as const : ['elevenlabs', 'gemini'] as const) {
    if (engine === 'gemini' && repo.hasKey('gemini_api_key')) {
      const voice = repo.getConfig('gemini_voice') || GEMINI_TTS.DEFAULT_VOICE;
      const style = repo.getConfig('voice_style') ?? GEMINI_TTS.DEFAULT_STYLE;
      const audio = await geminiTts(text, voice, style, repo.getKey('gemini_api_key'));
      if (audio) return audio;
    }
    if (engine === 'elevenlabs' && repo.hasKey('elevenlabs_api_key')) {
      const voiceId = repo.getConfig('voice_id') || ELEVENLABS.DEFAULT_VOICE_ID;
      const audio = await elevenLabsTts(stripVoiceTags(text), voiceId, repo.getKey('elevenlabs_api_key'));
      if (audio) return audio;
    }
  }
  return null;
}

let lastGoodGeminiModel: string | null = null;

/** Gemini TTS. Walks GEMINI_TTS.MODELS (last working model first) until one returns audio. */
export async function geminiTts(text: string, voice: string, style: string, apiKey: string): Promise<Buffer | null> {
  if (!apiKey) return null;
  const prompt = style.trim() ? `Say ${style.trim()}: ${text}` : text;
  const models = [...GEMINI_TTS.MODELS].sort((a, b) => Number(b === lastGoodGeminiModel) - Number(a === lastGoodGeminiModel));
  for (const model of models) {
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST',
        headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            responseModalities: ['AUDIO'],
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
          },
        }),
        signal: AbortSignal.timeout(GEMINI_TTS.TIMEOUT_MS),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        logger.warn({ model, status: res.status, body: body.slice(0, 300) }, 'Gemini TTS model failed, trying the next');
        if (res.status === 401 || res.status === 403) return null; // bad key: no model will work
        continue;
      }
      const json: any = await res.json();
      const part = (json?.candidates?.[0]?.content?.parts ?? []).find((p: any) => (p.inlineData ?? p.inline_data)?.data);
      const inline = part?.inlineData ?? part?.inline_data;
      if (!inline) {
        logger.warn({ model, json: JSON.stringify(json).slice(0, 300) }, 'Gemini TTS returned no audio, trying the next');
        continue;
      }
      const ogg = await toOggOpus(Buffer.from(inline.data, 'base64'), inline.mimeType ?? inline.mime_type ?? '');
      if (!ogg) return null; // conversion broke: another model won't fix that
      lastGoodGeminiModel = model;
      return ogg;
    } catch (err) {
      logger.warn({ err, model }, 'Gemini TTS request error, trying the next');
    }
  }
  logger.error('Gemini TTS: every model failed');
  return null;
}

/**
 * Any audio -> Ogg/Opus mono 48 kHz via ffmpeg (installed in the Docker image; FFMPEG_PATH overrides).
 * Gemini sends raw 16-bit little-endian PCM ("audio/L16;codec=pcm;rate=24000"), which has no header,
 * so its format is passed explicitly; anything else (wav, mp3) ffmpeg detects itself.
 */
export function toOggOpus(input: Buffer, mimeType: string): Promise<Buffer | null> {
  const raw = /l16|pcm/i.test(mimeType);
  const rate = /rate=(\d+)/i.exec(mimeType)?.[1] ?? '24000';
  const args = [
    '-hide_banner', '-loglevel', 'error',
    ...(raw ? ['-f', 's16le', '-ar', rate, '-ac', '1'] : []),
    '-i', 'pipe:0',
    '-c:a', 'libopus', '-b:a', '48k', '-ac', '1', '-ar', '48000', '-application', 'voip',
    '-f', 'ogg', 'pipe:1',
  ];
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(process.env.FFMPEG_PATH || 'ffmpeg', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      logger.error({ err }, 'ffmpeg could not start (is it installed?)');
      return resolve(null);
    }
    const out: Buffer[] = [];
    let err = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.stderr.on('data', (d: Buffer) => { err += d.toString(); });
    child.on('error', (e) => { clearTimeout(timer); logger.error({ err: e }, 'ffmpeg could not start (is it installed?)'); resolve(null); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 && out.length) return resolve(Buffer.concat(out));
      logger.error({ code, stderr: err.slice(0, 300) }, 'ffmpeg failed to convert the voice note');
      resolve(null);
    });
    child.stdin.on('error', () => undefined); // ffmpeg may exit before reading everything
    child.stdin.end(input);
  });
}

/**
 * ElevenLabs text-to-speech → Ogg/Opus buffer (WhatsApp's native voice-note format).
 * Returns null on any failure; callers fall back to sending text.
 */
export async function elevenLabsTts(text: string, voiceId: string, apiKey: string): Promise<Buffer | null> {
  if (!apiKey) {
    logger.warn('No ElevenLabs API key set, voice disabled');
    return null;
  }

  const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=${ELEVENLABS.OUTPUT_FORMAT}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ELEVENLABS.TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text,
        model_id: ELEVENLABS.MODEL,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      logger.error({ status: res.status, body: body.slice(0, 300) }, 'ElevenLabs TTS failed');
      return null;
    }
    return Buffer.from(await res.arrayBuffer());
  } catch (err) {
    logger.error({ err }, 'ElevenLabs TTS request error');
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
