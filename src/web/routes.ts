import type { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { App } from '../app.js';
import { DATA_DIR, DEMO_MODE, resolveStickerPath, applyMentions, CITY_CATALOG, cityNow, type ClockCity } from '../config.js';
import { logger } from '../logger.js';
import { FREQ_LEVELS, PERSONA_PRESETS } from '../ai/prompts.js';

function settingsPayload(app: App) {
  return {
    ...app.getSettings(),
    persona_presets: Object.entries(PERSONA_PRESETS).map(([value, p]) => ({ value, label: p.label })),
  };
}

export async function registerRoutes(fastify: FastifyInstance, app: App): Promise<void> {
  // Routes that spend tokens / drive the AI. Blocked during first-run setup (no key yet) and
  // turned into harmless no-ops in the read-only public demo.
  const AI_ACTION_PATHS = new Set([
    '/api/influence', '/api/continue', '/api/voice/learn', '/api/people/report-now', '/api/initiative/distill',
  ]);
  fastify.addHook('preHandler', async (req, reply) => {
    const path = req.url.split('?')[0];
    if (req.method === 'POST' && AI_ACTION_PATHS.has(path)) {
      if (DEMO_MODE) return reply.send({ ok: true, demo: true });
      if (app.needsSetup) return reply.code(409).send({ error: 'Add your Anthropic API key first (Settings → API keys).' });
    }
  });

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

  fastify.post<{ Body: { jid: string; text?: string; why?: string; target?: string; learn?: boolean } }>('/api/influence', async (req, reply) => {
    const text = req.body?.text?.trim();
    const why = req.body?.why?.trim();
    const target = req.body?.target?.trim();
    const jid = req.body?.jid;
    if (!text && !target) return reply.code(400).send({ error: 'text or target required' });
    const arbiter = jid ? app.getArbiter(jid) : null;
    if (!arbiter) return reply.code(409).send({ error: 'group not linked' });

    // the bot may take initiative here — not only a literal reply — when it serves the intent
    const initiative = 'You may do more than a bare reply when it serves this — add a follow-up, switch the topic, or generate an image / poll / voice note if it genuinely fits. Keep it natural and in-character.';
    const intent = why ? ` The owner's intent (why this is a good move — honour it, never quote it): ${why}.` : '';

    let instruction: string;
    if (target && text) {
      instruction = `Address message #${target} (anchor a "reply" action on target_message_id "${target}"). What to do: ${text}.${intent} ${initiative}`;
    } else if (target) {
      instruction = `Engage message #${target} (anchor a "reply" action on target_message_id "${target}") in whatever way fits the moment.${intent} ${initiative}`;
    } else {
      instruction = `Take the lead in the conversation: ${text}.${intent} ${initiative}`;
    }
    arbiter.forceGenerate(instruction, target ? 'REPLY_TO' : 'INFLUENCE');

    // teaching moment: store it for the initiative distiller to learn from
    if (req.body?.learn && jid) app.recordInfluenceLesson(jid, text ?? '', why ?? '', target ?? null);
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

  fastify.get<{ Querystring: { jid?: string } }>('/api/voice', async (req, reply) => {
    const jid = req.query.jid;
    if (!jid) return reply.code(400).send({ error: 'jid required' });
    return {
      overview: app.repo.getVoiceOverview(jid),
      items: app.repo.getVoiceItems(jid).map(i => ({
        ...i,
        member_name: i.member_jid ? (app.repo.getMember(i.member_jid)?.display_name ?? i.member_jid.split('@')[0]) : null,
      })),
    };
  });

  fastify.delete<{ Params: { id: string } }>('/api/voice/:id', async (req) => {
    app.repo.deleteVoiceItem(Number(req.params.id));
    app.prompts.memoryVersion += 1;
    return { ok: true };
  });

  // Manual on-demand voice learning. source: 'chat' = deep re-scan of stored history,
  // 'memory' = mine the group's facts + summary. Safe to click repeatedly: a concurrency
  // guard rejects overlaps (status 'busy') and dedup means re-runs only ever add new items.
  fastify.post<{ Body: { jid?: string; source?: 'chat' | 'memory' } }>('/api/voice/learn', async (req, reply) => {
    const { jid, source } = req.body ?? {};
    if (!jid) return reply.code(400).send({ error: 'jid required' });
    return source === 'memory'
      ? await app.learnVoiceFromMemory(jid)
      : await app.learnVoiceFromChat(jid);
  });

  // Owner review: mark items reviewed. Pure UI flag — no memoryVersion bump (doesn't change the
  // bot prompt; checked + unchecked items both still feed the bot's voice).
  fastify.post<{ Body: { jid?: string } }>('/api/voice/check-all', async (req, reply) => {
    const jid = req.body?.jid;
    if (!jid) return reply.code(400).send({ error: 'jid required' });
    return { ok: true, checked: app.repo.checkAllVoiceItems(jid) };
  });

  fastify.post<{ Params: { id: string }; Body: { checked?: boolean } }>('/api/voice/:id/check', async (req) => {
    app.repo.setVoiceItemChecked(Number(req.params.id), req.body?.checked !== false);
    return { ok: true };
  });

  // Edit an item's text. Content feeds the bot prompt, so bump memoryVersion to refresh the cache.
  fastify.post<{ Params: { id: string }; Body: { content?: string } }>('/api/voice/:id/edit', async (req, reply) => {
    const content = req.body?.content?.trim();
    if (!content) return reply.code(400).send({ error: 'content required' });
    const ok = app.repo.updateVoiceItemContent(Number(req.params.id), content);
    if (!ok) return reply.code(409).send({ ok: false, reason: 'duplicate' });
    app.prompts.memoryVersion += 1;
    return { ok: true };
  });

  // ---- Members: per-person dossiers, GLOBAL across all groups ----
  const personNameOf = (jid: string) => app.repo.getMember(jid)?.display_name ?? jid.split('@')[0];
  const latestStatsObj = (memberJid: string) => {
    const locks = new Set(app.repo.getStatLocks(memberJid));
    const out: Record<string, { value: number | null; label: string | null; reason: string | null; locked: boolean }> = {};
    for (const s of app.repo.getLatestStats(memberJid)) {
      out[s.stat_key] = { value: s.value, label: s.label, reason: s.reason, locked: locks.has(s.stat_key) };
    }
    return out;
  };

  fastify.get('/api/people', async () => {
    const code = app.repo.computeAllCodeStats();
    return app.repo.getPeople().map(m => {
      const report = app.repo.getLatestReport(m.jid);
      return {
        jid: m.jid,
        name: m.display_name ?? m.jid.split('@')[0],
        message_count: m.message_count,
        last_seen: m.last_seen,
        bio: report?.bio ?? null,
        talking_style: report?.talking_style ?? null,
        has_report: !!report,
        has_boundaries: !!(m.custom_instructions && m.custom_instructions.trim()),
        stats: latestStatsObj(m.jid),
        code: code.get(m.jid) ?? null,
      };
    });
  });

  fastify.get<{ Params: { jid: string } }>('/api/people/:jid', async (req, reply) => {
    const memberJid = decodeURIComponent(req.params.jid);
    const m = app.repo.getMember(memberJid);
    if (!m) return reply.code(404).send({ error: 'not found' });
    const report = app.repo.getLatestReport(memberJid);
    const code = app.repo.computeAllCodeStats().get(memberJid) ?? null;
    return {
      jid: m.jid,
      name: m.display_name ?? m.jid.split('@')[0],
      message_count: m.message_count,
      first_seen: m.first_seen,
      last_seen: m.last_seen,
      custom_instructions: m.custom_instructions ?? null,
      bio: report?.bio ?? null,
      summary: report?.summary ?? null,
      talking_style: report?.talking_style ?? null,
      week_start: report?.week_start ?? null,
      has_report: !!report,
      stats: latestStatsObj(memberJid),
      code,
      groups: app.repo.getMemberGroups(memberJid),
      reply_network: (code?.reply_network ?? []).map(r => ({ ...r, name: personNameOf(r.jid) })),
    };
  });

  fastify.get<{ Params: { jid: string; statKey: string } }>('/api/people/:jid/stat/:statKey/history', async (req) =>
    app.repo.getStatHistory(decodeURIComponent(req.params.jid), req.params.statKey));

  // Manually run the weekly report job (also does the first backfill). Returns {status, updated}.
  fastify.post('/api/people/report-now', async () => app.generateMemberReports());

  // Lock/unlock a stat so the weekly AI pass won't change it.
  fastify.post<{ Params: { jid: string; statKey: string }; Body: { locked?: boolean } }>(
    '/api/people/:jid/stat/:statKey/lock', async (req) => {
      app.lockMemberStat(decodeURIComponent(req.params.jid), req.params.statKey, req.body?.locked !== false);
      return { ok: true };
    });

  // Delete/reset a person's whole report (and its history + locks) so it rebuilds from scratch.
  fastify.delete<{ Params: { jid: string } }>('/api/people/:jid/report', async (req) => {
    app.deleteMemberReport(decodeURIComponent(req.params.jid));
    return { ok: true };
  });

  // Rename a person — reflected everywhere the AI refers to them (transcript, memory, voice, reports).
  fastify.post<{ Params: { jid: string }; Body: { name?: string } }>('/api/people/:jid/rename', async (req, reply) => {
    const name = req.body?.name?.trim();
    if (!name) return reply.code(400).send({ error: 'name required' });
    app.repo.setMemberName(decodeURIComponent(req.params.jid), name);
    app.prompts.memoryVersion += 1;
    return { ok: true };
  });

  // owner-set per-person boundaries (global, all groups) — highest-priority rule in the prompt
  fastify.post<{ Params: { jid: string }; Body: { instructions?: string } }>('/api/people/:jid/instructions', async (req) => {
    app.repo.setMemberInstructions(decodeURIComponent(req.params.jid), req.body?.instructions ?? '');
    app.prompts.memoryVersion += 1; // refresh Block B in every group
    return { ok: true };
  });

  // Permanently stop tracking a person: wipe their data + never profile them again.
  fastify.post<{ Params: { jid: string } }>('/api/people/:jid/ignore', async (req) => {
    app.repo.ignoreMember(decodeURIComponent(req.params.jid));
    app.prompts.memoryVersion += 1;
    return { ok: true };
  });

  fastify.post<{ Params: { jid: string } }>('/api/people/:jid/unignore', async (req) => {
    app.repo.unignoreMember(decodeURIComponent(req.params.jid));
    app.prompts.memoryVersion += 1;
    return { ok: true };
  });

  fastify.get('/api/people/ignored', async () =>
    app.repo.getIgnoredJids().map(jid => ({ jid, name: app.repo.getMember(jid)?.display_name ?? jid.split('@')[0] })));

  // ---- initiative learning (principles distilled from flagged Influences) ----
  fastify.get('/api/initiative', async () => app.getInitiativeData());

  // every saved knowledge item across all groups, as nodes for the Neurons visualization
  fastify.get('/api/neurons', async () => app.buildNeurons());
  fastify.post('/api/initiative/distill', async () => app.distillInitiative());
  fastify.delete<{ Params: { id: string } }>('/api/initiative/:id', async (req) => {
    app.deleteInitiativePrinciple(Number(req.params.id));
    return { ok: true };
  });

  // ---- world clock (cities the bot is time-aware of) ----
  fastify.get('/api/clock', async () => {
    const cities = app.repo.getClockCities();
    const now = new Date();
    return {
      cities: cities.map((c) => ({ ...c, now: cityNow(c, now) })),
      catalog: CITY_CATALOG.map((c) => c.label),
    };
  });
  fastify.post<{ Body: { labels?: string[] } }>('/api/clock', async (req, reply) => {
    const labels = req.body?.labels;
    if (!Array.isArray(labels)) return reply.code(400).send({ error: 'labels[] required' });
    // resolve each chosen label to its catalog entry (offset + dst) — drop unknowns, dedup, keep order
    const seen = new Set<string>();
    const cities: ClockCity[] = [];
    for (const label of labels) {
      if (seen.has(label)) continue;
      const match = CITY_CATALOG.find((c) => c.label === label);
      if (match) { cities.push(match); seen.add(label); }
    }
    app.repo.setClockCities(cities);
    const now = new Date();
    return { cities: cities.map((c) => ({ ...c, now: cityNow(c, now) })), catalog: CITY_CATALOG.map((c) => c.label) };
  });

  // feed media: an image/sticker from any message (inbound or bot-sent), lazily fetched + cached
  fastify.get<{ Params: { id: string } }>('/api/media/:id', async (req, reply) => {
    const media = await app.getMediaFile(decodeURIComponent(req.params.id));
    if (!media) return reply.code(404).send({ error: 'no media' });
    return reply.type(media.contentType).send(fs.createReadStream(media.path));
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
    const mentions = app.repo.getMentionNameMap();
    return {
      messages: messages.map(r => ({
        id: r.id, shortId: r.short_id, senderName: r.sender_name, isBot: !!r.is_bot,
        isOwner: !!r.is_owner, type: r.type, text: applyMentions(r.text ?? '', mentions), ts: r.ts,
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
    gatekeeper_model?: string; generation_model?: string; effort?: string; daily_budget_usd?: number;
    msg_prefix?: string; msg_suffix?: string; voice_enabled?: boolean; voice_id?: string;
    persona_mode?: string; persona_custom?: string;
    sticker_freq?: string; voice_freq?: string; emoji_freq?: string;
    intro_message?: string; intro_enabled?: boolean; rate_per_min?: number; rate_per_hour?: number;
    super_idle_minutes?: number;
    image_enabled?: boolean; image_model?: string; image_freq?: string; images_per_day?: number;
    typing_indicators?: boolean; token_reduction?: boolean; initiative_enabled?: boolean;
    anthropic_api_key?: string; gemini_api_key?: string; elevenlabs_api_key?: string;
  } }>(
    '/api/settings',
    async (req) => {
      const b = req.body ?? {};
      // API keys — entered in the dashboard, stored in config. Empty string clears (reverts to env).
      if (b.gemini_api_key !== undefined) app.repo.setConfig('gemini_api_key', b.gemini_api_key.trim());
      if (b.elevenlabs_api_key !== undefined) app.repo.setConfig('elevenlabs_api_key', b.elevenlabs_api_key.trim());
      if (b.anthropic_api_key !== undefined) {
        app.repo.setConfig('anthropic_api_key', b.anthropic_api_key.trim());
        app.ai.reload();              // hot-swap the Anthropic client to the new key
        if (b.anthropic_api_key.trim()) app.completeSetup(); // leave needs-setup mode + start WhatsApp
      }
      if (b.gatekeeper_model && ['sonnet', 'haiku'].includes(b.gatekeeper_model)) {
        app.repo.setConfig('gatekeeper_model', b.gatekeeper_model);
      }
      if (b.generation_model && ['sonnet', 'haiku'].includes(b.generation_model)) {
        app.repo.setConfig('generation_model', b.generation_model);
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
      if (b.initiative_enabled !== undefined) {
        app.repo.setConfig('initiative_enabled', b.initiative_enabled ? '1' : '0');
        app.prompts.memoryVersion += 1; // toggles the Block B initiative section
      }
      return settingsPayload(app);
    },
  );

  // setup wizard: check an Anthropic key works before relying on it (tests `key` if given, else current).
  // Not in the AI_ACTION guard above because the wizard needs it DURING setup; demo short-circuits it
  // so it can't be abused as a public key-testing oracle.
  fastify.post<{ Body: { key?: string } }>('/api/keys/validate', async (req) =>
    DEMO_MODE ? { ok: true } : app.ai.validateAnthropicKey(req.body?.key));
}
