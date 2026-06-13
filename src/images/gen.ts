import { IMAGE_GEN, type ImageModelChoice } from '../config.js';
import { logger } from '../logger.js';

export interface GenResult {
  buffer: Buffer;
  mimeType: string;
}

/**
 * Google Gemini image generation ("Nano Banana" / "Nano Banana Pro").
 * Optional editImage transforms an existing picture (e.g. meme-ify a member's photo).
 * Returns null on any failure — callers fall back to text.
 */
export async function geminiGenerateImage(
  prompt: string,
  model: ImageModelChoice,
  editImage?: { data: Buffer; mimeType: string },
): Promise<GenResult | null> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    logger.warn('GEMINI_API_KEY not set — image generation disabled');
    return null;
  }

  const modelId = IMAGE_GEN.MODELS[model];
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent`;

  const parts: any[] = [{ text: prompt }];
  if (editImage) {
    parts.push({ inlineData: { mimeType: editImage.mimeType, data: editImage.data.toString('base64') } });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), IMAGE_GEN.TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: { responseModalities: ['IMAGE'] },
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      logger.error({ status: res.status, body: body.slice(0, 400) }, 'Gemini image generation failed');
      return null;
    }

    const json: any = await res.json();
    const candidateParts = json?.candidates?.[0]?.content?.parts ?? [];
    for (const p of candidateParts) {
      const inline = p.inlineData ?? p.inline_data;
      if (inline?.data) {
        return { buffer: Buffer.from(inline.data, 'base64'), mimeType: inline.mimeType ?? inline.mime_type ?? 'image/png' };
      }
    }
    logger.warn({ json: JSON.stringify(json).slice(0, 400) }, 'Gemini returned no image part');
    return null;
  } catch (err) {
    logger.error({ err }, 'Gemini image request error');
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
