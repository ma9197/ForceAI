import type { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { App } from '../app.js';
import { DATA_DIR, resolveStickerPath } from '../config.js';
import { logger } from '../logger.js';
import { FREQ_LEVELS, PERSONA_PRESETS } from '../ai/prompts.js';

function settingsPayload(app: App) {
  return {
    ...app.getSettings(),
    persona_presets: Object.entries(PERSONA_PRESETS).map(([value, p]) => ({ value, label: p.label })),
  };
}

export async function registerRoutes(fastify: FastifyInstance, app: App): Promise<void> {
  fastify.get('/api/status', async () => app.statusPayload());

  fastify.get('/api/groups', async () => {
    const all = await app.groups.listAll();
    return all.map(g => ({ ...g, linked: app.linkedGroups.has(g.jid) }));
  });

  fastify.post<{ Body: { jid: string } }>('/api/group', async (req, reply) => {
    const { jid } = req.body ?? {};
    if (!jid) return reply.code(400).send({ error: 'jid required' });
    await app.linkGroup(jid);
    return { ok: true };
  });

  fastify.post<{ Body: { jid: string } }>('/api/group/unlink', async (req, reply) => {
    const { jid } = req.body ?? {};
    if (!jid) return reply.code(400).send({ error: 'jid required' });
    app.unlinkGroup(jid);
    return { ok: true };
  });

  fastify.post<{ Body: { jid: string } }>('/api/pause', async (req, reply) => {
    const { jid } = req.body ?? {};
    if (!jid) return reply.code(400).send({ error: 'jid required' });
    app.setPaused(jid, true);
    return { ok: true };
  });

  fastify.post<{ Body: { jid: string } }>('/api/resume', async (req, reply) => {
    const { jid } = req.body ?? {};
    if (!jid) return reply.code(400).send({ error: 'jid required' });
    app.setPaused(jid, false);
    return { ok: true };
  });

  fastify.post<{ Body: { jid: string; text?: string; target?: string } }>('/api/influence', async (req, reply) => {
    const text = req.body?.text?.trim();
    const target = req.body?.target?.trim();
    const jid = req.body?.jid;
    if (!text && !target) return reply.code(400).send({ error: 'text or target required' });
    const arbiter = jid ? app.getArbiter(jid) : null;
    if (!arbiter) return reply.code(409).send({ error: 'group not linked' });

    let instruction: string;
    if (target && text) {
      instruction = `Quote-reply to message #${target} (use a "reply" action with target_message_id "${target}"). What to say: ${text}. Deliver it in-character.`;
    } else if (target) {
      instruction = `Quote-reply to message #${target} (use a "reply" action with target_message_id "${target}") with whatever fits the moment and your character.`;
    } else {
      instruction = `Steer the conversation: ${text}. Do it smoothly in-character.`;
    }
    arbiter.forceGenerate(instruction, target ? 'REPLY_TO' : 'INFLUENCE');
    return { ok: true };
  });

  fastify.post('/api/ratelimit/reset', async () => {
    app.resetRateLimits();
    return { ok: true };
  });

  // full shutdown: disconnect WhatsApp entirely (linked device goes offline), dashboard stays up
  fastify.post('/api/shutdown', async () => {
    await app.shutdown();
    return { ok: true };
  });

  fastify.post('/api/startup', async () => {
    await app.startup();
    return { ok: true };
  });

  fastify.post<{ Body: { jid: string } }>('/api/sleep', async (req, reply) => {
    const jid = req.body?.jid;
    if (!jid) return reply.code(400).send({ error: 'jid required' });
    app.sleepGroup(jid);
    return { ok: true };
  });

  fastify.post<{ Body: { jid: string } }>('/api/continue', async (req, reply) => {
    const jid = req.body?.jid;
    const arbiter = jid ? app.getArbiter(jid) : null;
    if (!arbiter) return reply.code(409).send({ error: 'group not linked' });
    arbiter.forceGenerate(
      'No new trigger — send something now. Continue the current vibe, react to where the conversation left off, or smoothly open a fitting topic based on what you know about the members. Sending a message is mandatory.',
      'CONTINUE',
    );
    return { ok: true };
  });

  fastify.get<{ Querystring: { jid?: string } }>('/api/members', async (req, reply) => {
    const jid = req.query.jid;
    if (!jid) return reply.code(400).send({ error: 'jid required' });
    return app.repo.getMembersForChat(jid).map(m => ({
      ...m,
      facts: app.repo.getActiveFacts(jid, m.jid),
    }));
  });

  fastify.delete<{ Params: { id: string } }>('/api/facts/:id', async (req) => {
    app.repo.deleteFact(Number(req.params.id));
    app.prompts.memoryVersion += 1;
    return { ok: true };
  });

  fastify.get('/api/stickers', async () => app.repo.getStickers());

  fastify.get<{ Params: { id: string } }>('/api/stickers/:id/image', async (req, reply) => {
    const sticker = app.repo.getSticker(Number(req.params.id));
    if (!sticker) return reply.code(404).send({ error: 'not found' });
    const file = resolveStickerPath(sticker.file_path);
    if (!fs.existsSync(file)) return reply.code(404).send({ error: 'file missing' });
    return reply.type('image/webp').send(fs.createReadStream(file));
  });

  fastify.patch<{ Params: { id: string }; Body: { description?: string; usage_hint?: string } }>(
    '/api/stickers/:id',
    async (req) => {
      const id = Number(req.params.id);
      const current = app.repo.getSticker(id);
      if (current) {
        app.repo.setStickerDescription(
          id,
          req.body?.description ?? current.description ?? '',
          req.body?.usage_hint ?? current.usage_hint,
        );
        app.prompts.memoryVersion += 1;
      }
      return { ok: true };
    },
  );

  fastify.get<{ Querystring: { jid?: string; limit?: string } }>('/api/feed', async (req, reply) => {
    const jid = req.query.jid;
    if (!jid) return reply.code(400).send({ error: 'jid required' });
    const limit = Math.min(Number(req.query.limit ?? 100), 300);
    const messages = app.repo.getRecentMessages(jid, limit);
    const decisions = app.repo.getRecentDecisions(limit, jid);
    return {
      messages: messages.map(r => ({
        id: r.id, shortId: r.short_id, senderName: r.sender_name, isBot: !!r.is_bot,
        isOwner: !!r.is_owner, type: r.type, text: r.text, ts: r.ts,
      })),
      decisions,
    };
  });

  // ---- one-time brain import: upload a tar.gz of the local data/ folder ----
  // Auth-protected (global Basic Auth). Extracts into DATA_DIR then restarts so the app
  // boots with the imported DB + WhatsApp session + stickers, restoring exact prior state.
  fastify.post('/api/admin/import', { bodyLimit: 209_715_200 }, async (req, reply) => {
    const buf = req.body as Buffer;
    if (!Buffer.isBuffer(buf) || buf.length === 0) {
      return reply.code(400).send({ error: 'empty body — POST the tar.gz as application/octet-stream' });
    }
    const tmp = path.join(DATA_DIR, '_import.tar.gz');
    try {
      fs.writeFileSync(tmp, buf);
      execFileSync('tar', ['-xzf', tmp, '-C', DATA_DIR]);
    } catch (err) {
      logger.error({ err }, 'data import failed');
      return reply.code(500).send({ error: 'extract failed: ' + String(err) });
    } finally {
      try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    }
    logger.info(`data import: ${buf.length} bytes extracted — restarting to load it`);
    reply.send({ ok: true, bytes: buf.length, restarting: true });
    setTimeout(() => process.exit(1), 800); // Railway restarts (restart policy: on failure)
  });

  fastify.get('/api/settings', async () => settingsPayload(app));

  fastify.post<{ Body: {
    gatekeeper_model?: string; effort?: string; daily_budget_usd?: number;
    msg_prefix?: string; msg_suffix?: string; voice_enabled?: boolean; voice_id?: string;
    persona_mode?: string; persona_custom?: string;
    sticker_freq?: string; voice_freq?: string; emoji_freq?: string;
    intro_message?: string; intro_enabled?: boolean; rate_per_min?: number; rate_per_hour?: number;
    super_idle_minutes?: number;
    image_enabled?: boolean; image_model?: string; image_freq?: string; images_per_day?: number;
    typing_indicators?: boolean; token_reduction?: boolean;
  } }>(
    '/api/settings',
    async (req) => {
      const b = req.body ?? {};
      if (b.gatekeeper_model && ['sonnet', 'haiku'].includes(b.gatekeeper_model)) {
        app.repo.setConfig('gatekeeper_model', b.gatekeeper_model);
      }
      if (b.effort && ['low', 'medium', 'high'].includes(b.effort)) {
        app.repo.setConfig('effort', b.effort);
      }
      if (b.daily_budget_usd !== undefined && Number(b.daily_budget_usd) > 0) {
        app.repo.setConfig('daily_budget_usd', String(Number(b.daily_budget_usd)));
      }
      if (b.msg_prefix !== undefined) app.repo.setConfig('msg_prefix', b.msg_prefix.slice(0, 12));
      if (b.msg_suffix !== undefined) app.repo.setConfig('msg_suffix', b.msg_suffix.slice(0, 12));
      if (b.voice_enabled !== undefined) {
        app.repo.setConfig('voice_enabled', b.voice_enabled ? '1' : '0');
        app.prompts.memoryVersion += 1; // capabilities line lives in Block B
      }
      if (b.voice_id !== undefined && b.voice_id.trim()) {
        app.repo.setConfig('voice_id', b.voice_id.trim());
      }
      if (b.persona_mode !== undefined) {
        app.repo.setConfig('persona_mode', b.persona_mode);
        app.prompts.memoryVersion += 1;
      }
      if (b.persona_custom !== undefined) {
        app.repo.setConfig('persona_custom', b.persona_custom.slice(0, 1000));
        app.prompts.memoryVersion += 1;
      }
      for (const key of ['sticker_freq', 'voice_freq', 'emoji_freq'] as const) {
        const v = b[key];
        if (v && (FREQ_LEVELS as readonly string[]).includes(v)) {
          app.repo.setConfig(key, v);
          app.prompts.memoryVersion += 1;
        }
      }
      if (b.intro_message !== undefined && b.intro_message.trim()) {
        app.repo.setConfig('intro_message', b.intro_message.trim().slice(0, 300));
      }
      if (b.intro_enabled !== undefined) {
        app.repo.setConfig('intro_enabled', b.intro_enabled ? '1' : '0');
      }
      if (b.rate_per_min !== undefined) {
        const v = Math.max(1, Math.min(20, Math.round(Number(b.rate_per_min))));
        if (Number.isFinite(v)) app.repo.setConfig('rate_per_min', String(v));
      }
      if (b.rate_per_hour !== undefined) {
        const v = Math.max(5, Math.min(200, Math.round(Number(b.rate_per_hour))));
        if (Number.isFinite(v)) app.repo.setConfig('rate_per_hour', String(v));
      }
      if (b.super_idle_minutes !== undefined) {
        const v = Math.max(0, Math.min(1440, Math.round(Number(b.super_idle_minutes))));
        if (Number.isFinite(v)) app.repo.setConfig('super_idle_minutes', String(v));
      }
      if (b.image_enabled !== undefined) {
        app.repo.setConfig('image_enabled', b.image_enabled ? '1' : '0');
        app.prompts.memoryVersion += 1;
      }
      if (b.image_model && ['flash', 'pro'].includes(b.image_model)) {
        app.repo.setConfig('image_model', b.image_model);
      }
      if (b.image_freq && (FREQ_LEVELS as readonly string[]).includes(b.image_freq)) {
        app.repo.setConfig('image_freq', b.image_freq);
        app.prompts.memoryVersion += 1;
      }
      if (b.images_per_day !== undefined) {
        const v = Math.max(1, Math.min(200, Math.round(Number(b.images_per_day))));
        if (Number.isFinite(v)) app.repo.setConfig('images_per_day', String(v));
      }
      if (b.typing_indicators !== undefined) {
        app.repo.setConfig('typing_indicators', b.typing_indicators ? '1' : '0');
      }
      if (b.token_reduction !== undefined) {
        app.repo.setConfig('token_reduction', b.token_reduction ? '1' : '0');
      }
      return settingsPayload(app);
    },
  );
}
