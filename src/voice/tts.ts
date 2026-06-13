import { ELEVENLABS } from '../config.js';
import { logger } from '../logger.js';

/**
 * ElevenLabs text-to-speech → Ogg/Opus buffer (WhatsApp's native voice-note format).
 * Returns null on any failure — callers fall back to sending text.
 */
export async function elevenLabsTts(text: string, voiceId: string): Promise<Buffer | null> {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    logger.warn('ELEVENLABS_API_KEY not set — voice disabled');
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
