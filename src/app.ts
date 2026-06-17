import fs from 'node:fs';
import path from 'node:path';
import { downloadMediaMessage, type WAMessage } from 'baileys';
import { INTRO_MESSAGE, DEFAULT_DAILY_BUDGET_USD, DEFAULT_MSG_PREFIX, DEFAULT_MSG_SUFFIX, DEMO_MODE, ELEVENLABS, IMAGE_DIR, IMAGE_GEN, INITIATIVE, applyMentions } from './config.js';
import { logger, waLogger } from './logger.js';
import { openDb } from './memory/db.js';
import { Repo } from './memory/repo.js';
import { FactExtractor } from './memory/extractor.js';
import { VoiceProfiler, type VoiceLearnResult } from './memory/voice.js';
import { MemberReporter, type ReportResult } from './memory/reporter.js';
import { InitiativeDistiller, type DistillResult } from './memory/initiative.js';
import { JidResolver } from './wa/jid.js';
import { WaConnection } from './wa/connection.js';
import { Normalizer } from './wa/inbound.js';
import { Groups } from './wa/groups.js';
import { MessageStore } from './wa/store.js';
import { Outbound } from './wa/outbound.js';
import { PollTracker } from './wa/polls.js';
import { AiClient } from './ai/client.js';
import { PromptBuilder } from './ai/prompts.js';
import { Gatekeeper } from './ai/gatekeeper.js';
import { Generator } from './ai/generator.js';
import { Arbiter } from './arbiter/arbiter.js';
import { StickerLearning } from './stickers/learning.js';
import { Bus } from './web/bus.js';
import type { FeedMessage, GroupStatus, NeuronNode, NormalizedMessage, StatusPayload } from './types.js';

export class App {
  bus = new Bus();
  repo: Repo;
  jids: JidResolver;
  conn: WaConnection;
  normalizer: Normalizer;
  groups: Groups;
  store: MessageStore;
  outbound: Outbound;
  ai: AiClient;
  prompts: PromptBuilder;
  gatekeeper: Gatekeeper;
  generator: Generator;
  stickers: StickerLearning;
  polls: PollTracker;

  /** false = full shutdown (WhatsApp disconnected, dashboard still up). Persisted across restarts. */
  online = true;
  /** true until an Anthropic key exists — the dashboard shows the setup wizard and no AI/WhatsApp runs.
   *  Computed at boot only (clearing a key later just disables features, doesn't re-enter the wizard). */
  needsSetup = false;
  /** all groups the bot is currently live in — each has its own arbiter/extractor */
  linkedGroups = new Set<string>();
  private arbiters = new Map<string, Arbiter>();
  private extractors = new Map<string, FactExtractor>();
  private voiceProfilers = new Map<string, VoiceProfiler>();
  private memberReporter: MemberReporter;
  private initiativeDistiller: InitiativeDistiller;

  getArbiter(jid: string): Arbiter | null {
    return this.arbiters.get(jid) ?? null;
  }

  constructor() {
    const db = openDb();
    this.repo = new Repo(db);
    this.jids = new JidResolver(this.repo);
    this.conn = new WaConnection();
    this.normalizer = new Normalizer(this.repo, this.jids);
    this.groups = new Groups(() => this.conn.sock);
    this.store = new MessageStore(this.repo);
    this.ai = new AiClient(this.repo);
    this.outbound = new Outbound(() => this.conn.sock, this.repo, this.store, this.ai);
    this.polls = new PollTracker(this.repo, this.store);
    this.prompts = new PromptBuilder(this.repo, this.polls);
    this.gatekeeper = new Gatekeeper(this.ai, this.repo, this.prompts);
    this.generator = new Generator(this.ai, this.repo, this.prompts);
    this.stickers = new StickerLearning(
      this.repo,
      this.outbound,
      this.prompts,
      { onSticker: (id, description) => this.bus.publish({ kind: 'sticker', id, description }) },
      () => this.conn.sock,
    );
    this.memberReporter = new MemberReporter(this.repo, this.ai, this.prompts, {
      onReports: (count) => {
        this.bus.publish({ kind: 'report', count });
        this.bus.publish({ kind: 'status', status: this.statusPayload() });
      },
    });
    this.initiativeDistiller = new InitiativeDistiller(this.repo, this.ai, this.prompts, {
      onDistilled: () => this.bus.publish({ kind: 'status', status: this.statusPayload() }),
    });

    this.loadLinkedGroups();
    this.online = this.repo.getConfig('bot_online') !== '0'; // restore shutdown state across restarts
    this.needsSetup = !DEMO_MODE && !this.ai.hasAnthropicKey(); // no key yet → first-run setup wizard
    // NOTE: we intentionally do NOT reset paused/asleep on boot — each group is restored to
    // its EXACT prior state (live / sleeping / paused) so restarts and updates are seamless.
    // (paused_<jid> and asleep_<jid> are persisted in config; the arbiter reads them.)

    // bot sends enter the DB/feed immediately (don't rely on Baileys echoing them back)
    this.outbound.onBotMessage = (msg) => void this.handleRawMessage(msg, 'sent').catch(err => logger.error({ err }, 'bot-send handling failed'));

    // let Baileys re-fetch sent messages for decrypt retries / resends
    this.conn.getStoredMessage = (id) => {
      const row = this.repo.getMessageById(id);
      if (!row?.raw) return undefined;
      try { return JSON.parse(row.raw).message ?? undefined; } catch { return undefined; }
    };
  }

  private loadLinkedGroups(): void {
    try {
      const raw = this.repo.getConfig('linked_group_jids');
      if (raw) {
        for (const jid of JSON.parse(raw) as string[]) this.linkedGroups.add(jid);
        return;
      }
    } catch { /* fall through to migration */ }
    // migrate from the old single active group
    const legacy = this.repo.getConfig('active_group_jid');
    if (legacy) {
      this.linkedGroups.add(legacy);
      this.persistLinkedGroups();
    }
  }

  private persistLinkedGroups(): void {
    this.repo.setConfig('linked_group_jids', JSON.stringify([...this.linkedGroups].sort()));
  }

  async start(): Promise<void> {
    this.conn.on('qr', (dataUrl: string) => this.bus.publish({ kind: 'qr', dataUrl }));

    this.conn.on('state', (state) => {
      this.bus.publish({ kind: 'connection', state });
      this.bus.publish({ kind: 'status', status: this.statusPayload() });
    });

    this.conn.on('ready', () => {
      this.jids.setOwnIdentity(this.conn.sock?.user?.id, this.conn.sock?.user?.lid);
      for (const jid of this.linkedGroups) {
        this.ensureArbiter(jid);
        void this.groups.metadata(jid, true);
      }
      void this.groups.listAll(); // warm the cache for subject names
    });

    this.conn.on('lid-mapping', (mapping: unknown) => {
      // defensive: payload shape may be an array of pairs or an object map
      try {
        const pairs: Array<{ lid: string; pn: string }> = Array.isArray(mapping)
          ? mapping as any
          : typeof mapping === 'object' && mapping !== null
            ? Object.entries(mapping as Record<string, string>).map(([lid, pn]) => ({ lid, pn }))
            : [];
        for (const p of pairs) {
          if (p?.lid && p?.pn) this.jids.storeMapping(p.lid, p.pn);
        }
      } catch (err) {
        logger.debug({ err }, 'lid-mapping payload not understood');
      }
    });

    this.conn.on('messages', (messages: WAMessage[], type: string) => {
      for (const msg of messages) {
        void this.handleRawMessage(msg, type).catch(err => logger.error({ err }, 'message handling failed'));
      }
    });

    if (DEMO_MODE) {
      logger.info('booting in DEMO mode — no WhatsApp, seeded data, outbound disabled');
      this.conn.setOffline();
      this.seedDemo();
    } else if (this.needsSetup) {
      // no Anthropic key yet — stay disconnected (no AI calls) until the wizard saves one
      logger.info('booting in SETUP mode — WhatsApp not connected until an API key is entered');
      this.conn.setOffline();
    } else if (this.online) {
      await this.conn.start();
    } else {
      // booted in shutdown state — keep the dashboard up but stay disconnected
      logger.info('booting in SHUTDOWN state — WhatsApp not connected until Power On');
      for (const a of this.arbiters.values()) a.suspend();
      this.conn.setOffline();
    }

    // weekly member-report scheduler (independent of WhatsApp; checks the clock every 30 min)
    if (!this.needsSetup && !DEMO_MODE) this.memberReporter.start();
  }

  /** Seed a believable fake group so the public demo (DEMO_MODE) is fully clickable with no keys/phone.
   *  Writes only to the ephemeral in-memory demo DB (see openDb). */
  private seedDemo(): void {
    if (this.linkedGroups.size > 0) return; // already seeded
    const jid = 'demo-group@g.us';
    this.groups.setCachedSubject(jid, 'The Boys 🔥');
    this.linkedGroups.add(jid);

    const MURAD = 'demo-murad@s.whatsapp.net';
    const KANAN = 'demo-kanan@s.whatsapp.net';
    const OWNER = 'demo-owner@s.whatsapp.net';
    const t0 = Date.now() - 30 * 60_000;
    this.repo.upsertMember(MURAD, 'Murad', null, t0);
    this.repo.upsertMember(KANAN, 'Kanan', null, t0);
    this.repo.upsertMember(OWNER, 'Said', null, t0);

    type Line = { who: 'murad' | 'kanan' | 'owner' | 'bot'; text: string; type?: NormalizedMessage['type'] };
    const script: Line[] = [
      { who: 'murad', text: "lads who's watching the match tonight 👀" },
      { who: 'kanan', text: 'obviously. madrid gonna destroy them' },
      { who: 'murad', text: 'madrid?? 💀 bro they are washed' },
      { who: 'bot', text: "kanan really said madrid like it's 2017 😭 keep up king" },
      { who: 'kanan', text: 'nobody asked 🤡' },
      { who: 'bot', text: 'and yet here you are replying to me 🤭' },
      { who: 'owner', text: 'calm down both of you 😂' },
      { who: 'murad', text: 'forceai settle it, who wins tonight' },
      { who: 'bot', text: 'madrid by 2. kanan about to go very quiet after 💀' },
      { who: 'kanan', text: "if i'm wrong i'll send a voice note apologizing" },
      { who: 'murad', text: 'screenshot this 📸' },
      { who: 'bot', text: "already saved it 🤝 don't worry i'll remind him" },
    ];
    const jidOf = { murad: MURAD, kanan: KANAN, owner: OWNER, bot: OWNER } as const;
    const nameOf = { murad: 'Murad', kanan: 'Kanan', owner: 'Said', bot: 'ForceAI' } as const;
    script.forEach((line, i) => {
      const isBot = line.who === 'bot';
      const isOwner = line.who === 'owner';
      this.repo.insertMessage({
        id: `demo-m${i}`, shortId: `m${i + 1}`, chatJid: jid,
        senderJid: jidOf[line.who], senderName: nameOf[line.who],
        fromMe: isBot || isOwner, isBot, isOwner,
        type: line.type ?? 'text', text: line.text, mentionedJids: [], ts: t0 + i * 90_000,
        raw: { key: { id: `demo-m${i}`, remoteJid: jid, fromMe: isBot || isOwner } },
      });
      if (!isBot && !isOwner) this.repo.bumpMemberMessageCount(jidOf[line.who]);
    });

    // a little learned memory + voice so those tabs aren't empty
    this.repo.insertFact(jid, MURAD, 'Barcelona fan — despises Real Madrid', 'football', 0.95, null);
    this.repo.insertFact(jid, MURAD, 'Always certain he is right in football debates', 'personality', 0.8, null);
    this.repo.insertFact(jid, KANAN, 'Die-hard Real Madrid supporter', 'football', 0.95, null);
    this.repo.insertFact(jid, KANAN, 'Loud and confident, folds when proven wrong', 'personality', 0.75, null);
    this.repo.insertVoiceItem(jid, 'slang', 'washed = past their prime / no longer good', 'they are washed', null);
    this.repo.insertVoiceItem(jid, 'joke', 'running bit: making the losing side "go quiet"', 'about to go very quiet', null);
    this.repo.insertVoiceItem(jid, 'member_style', 'Kanan: short, cocky one-liners; lots of 🤡 and 💀', 'nobody asked 🤡', KANAN);

    // richer brain for the Neurons demo: a few more saved-item types so multiple "lobes" appear
    const wk = (n: number) => t0 - n * 7 * 86_400_000;
    this.repo.insertMemberReport(MURAD, wk(1), 'A loyal Barça die-hard who treats every football take as a hill to die on — loud bravado over a genuinely warm core.', 'Spent the week roasting Madrid fans.', 'declarative, lots of 💀');
    this.repo.insertMemberReport(KANAN, wk(1), 'A confident Madridista, quick to talk trash and quicker to go quiet the moment he is proven wrong.', 'Lost the title argument, took it on the chin.', 'short cocky one-liners');
    for (const [m, mood, iq, agg] of [[MURAD, 72, 130, 58], [KANAN, 64, 119, 76]] as const) {
      this.repo.insertStatSnapshot(m, wk(1), 'mood', mood, mood > 60 ? 'upbeat' : 'flat', 'banter energy running high');
      this.repo.insertStatSnapshot(m, wk(1), 'iq', iq, null, 'sharp, fact-backed football takes');
      this.repo.insertStatSnapshot(m, wk(1), 'aggression', agg, agg > 70 ? 'heated' : 'chill', 'debate intensity this week');
    }
    this.repo.insertInfluenceLesson(jid, 'hype them up when a match kicks off', 'keeps the group energy high', null, 'pre-match banter');
    this.repo.insertInitiativePrinciple('When a live football debate stalls, drop a spicy poll to reignite it.', 'Madrid or Barça — vote 💀');
    this.repo.insertInitiativePrinciple('Call out the losing side once results are in, but keep it playful.', 'told you 🤭 kanan went quiet');
    this.repo.setSummary(jid, 'A football-obsessed friend group; the Murad (Barça) vs Kanan (Madrid) rivalry is the running bit the bot loves to stoke.', t0);

    // spread the demo's saved-item timestamps across the past few weeks so the Neurons timeline has range
    const now = Date.now(), day = 86_400_000;
    for (const [tbl, col, step] of [['facts', 'created_at', 2], ['voice_items', 'created_at', 3], ['member_reports', 'created_at', 5], ['member_stat_history', 'created_at', 4], ['initiative_principles', 'created_at', 6], ['influence_lessons', 'ts', 5], ['group_summary', 'updated_at', 1]] as const) {
      try { this.repo.db.prepare(`UPDATE ${tbl} SET ${col} = ? - ((SELECT MAX(rowid) FROM ${tbl}) - rowid) * ?`).run(now, step * day); } catch { /* table empty */ }
    }

    // believable stats
    const bump = (k: string, n: number) => this.repo.bumpStat(k, n);
    bump('messages_read', 9); bump(`messages_read:${jid}`, 9);
    bump('messages_sent', 3); bump(`messages_sent:${jid}`, 3);
    bump('facts_learned', 4); bump(`facts_learned:${jid}`, 4);
    bump('voice_items_learned', 3); bump(`voice_items_learned:${jid}`, 3);
    bump('t1_calls', 9); bump(`t1_calls:${jid}`, 9);
    bump('t2_calls', 3); bump(`t2_calls:${jid}`, 3);
    bump('cost_microusd', 14_200); bump(`cost_microusd:${jid}`, 14_200);
    bump('input_tokens', 48_000); bump('output_tokens', 1_900); bump('cache_read_tokens', 120_000);
  }

  /** Called when the first Anthropic key is saved via the dashboard: leave setup mode and bring the
   *  bot online (begin the WhatsApp QR + start the background scheduler), live, with no restart. */
  completeSetup(): void {
    if (!this.needsSetup) return;
    this.needsSetup = false;
    logger.info('Anthropic key saved — leaving SETUP mode');
    if (this.online) { void this.conn.start(); }
    this.memberReporter.start();
    this.bus.publish({ kind: 'status', status: this.statusPayload() });
  }

  /** Manual trigger for the weekly per-person report job (also used for the first backfill). */
  generateMemberReports(): Promise<ReportResult> {
    return this.memberReporter.run('manual');
  }

  lockMemberStat(memberJid: string, statKey: string, locked: boolean): void {
    this.repo.setStatLock(memberJid, statKey, locked);
    this.bus.publish({ kind: 'report', count: 0 });
  }

  deleteMemberReport(memberJid: string): void {
    this.repo.deleteMemberReport(memberJid);
    this.prompts.memoryVersion += 1;
    this.bus.publish({ kind: 'report', count: 0 });
  }

  // ---- initiative learning ----
  /** Store a flagged Influence (with its chat context) for the initiative distiller. */
  recordInfluenceLesson(jid: string, text: string, why: string, target: string | null): void {
    const context = this.prompts.formatTranscript(this.repo.getRecentMessages(jid, INITIATIVE.CONTEXT_MSGS), null);
    const targetExcerpt = target ? (this.repo.getMessageByShortId(target)?.text ?? null) : null;
    this.repo.insertInfluenceLesson(jid, text, why, targetExcerpt, context);
    this.initiativeDistiller.maybeAuto();
  }

  distillInitiative(): Promise<DistillResult> {
    return this.initiativeDistiller.run();
  }

  getInitiativeData(): { principles: { id: number; content: string; example: string | null }[]; pending: number; enabled: boolean } {
    return {
      principles: this.repo.getActiveInitiativePrinciples(),
      pending: this.repo.countUndistilledLessons(),
      enabled: this.repo.getConfig('initiative_enabled') === '1',
    };
  }

  deleteInitiativePrinciple(id: number): void {
    this.repo.deleteInitiativePrinciple(id);
    this.prompts.memoryVersion += 1;
  }

  /** Full shutdown: disconnect WhatsApp entirely (linked device goes offline), keep dashboard up.
   *  NOT a reset — all memory and per-group states are preserved; Power On resumes everything. */
  async shutdown(): Promise<void> {
    if (!this.online) return;
    this.online = false;
    this.repo.setConfig('bot_online', '0');
    for (const a of this.arbiters.values()) a.suspend();
    await this.conn.stop();
    logger.info('bot shut down — WhatsApp disconnected');
    this.bus.publish({ kind: 'status', status: this.statusPayload() });
  }

  /** Power back on: reconnect WhatsApp (same session, no QR) and resume all groups in their saved state. */
  async startup(): Promise<void> {
    if (this.online) return;
    this.online = true;
    this.repo.setConfig('bot_online', '1');
    for (const a of this.arbiters.values()) a.resume();
    this.bus.publish({ kind: 'status', status: this.statusPayload() });
    await this.conn.start();
  }

  private async handleRawMessage(msg: WAMessage, source: string): Promise<void> {
    const id = msg.key?.id;
    if (!id || this.repo.getMessageById(id)) return; // dedupe (covers send-hook vs echo)

    // poll votes are encrypted updates, not chat messages — handle separately
    if (this.polls.isPollVote(msg)) {
      const chatJid = msg.key?.remoteJid ? this.jids.canonical(msg.key.remoteJid).canonical : null;
      const vote = this.polls.handleVote(msg, [this.conn.ownJid, this.conn.ownLid]);
      if (vote && chatJid) {
        const summary = vote.selected.length
          ? `${vote.voterName} voted ${vote.selected.map(s => `"${s}"`).join(', ')} on "${vote.question}"`
          : `${vote.voterName} retracted their vote on "${vote.question}"`;
        this.repo.insertDecision(chatJid, 'POLL', 'VOTE', summary.slice(0, 200));
        if (this.linkedGroups.has(chatJid)) {
          this.bus.publish({ kind: 'decision', chatJid, ts: Date.now(), tier: 'POLL', decision: 'VOTE', reason: summary });
        }
      }
      return;
    }

    const norm = this.normalizer.normalize(msg);
    if (!norm) return;

    const isSelfChat = this.jids.isOwnJid(norm.chatJid);
    const isLinkedGroup = this.linkedGroups.has(norm.chatJid);
    if (!isSelfChat && !isLinkedGroup) return; // ignore every other chat

    const fresh = Date.now() - norm.ts < 120_000; // never act on stale backlog re-deliveries

    this.repo.insertMessage(norm);
    this.store.put(norm.id, norm.shortId, norm.raw);

    // pull image/sticker media from the LIVE message (real buffers) so the dashboard feed can render
    // it — covers inbound AND bot-sent. Also makes inbound images visible to Claude's vision (below).
    if (isLinkedGroup && fresh && (norm.type === 'image' || norm.type === 'sticker')) {
      await this.downloadMedia(norm.id, norm.raw, norm.type);
    }

    this.bus.publish({ kind: 'message', chatJid: norm.chatJid, message: toFeed(norm, this.repo.getMentionNameMap()) });

    if (source === 'sent') return; // our own send — recorded, nothing to react to

    if (isSelfChat) {
      if (fresh) void this.stickers.onSelfChatMessage(norm);
      return;
    }

    if (isLinkedGroup) {
      // (image/sticker media was already fetched above, before the feed publish + the arbiter)
      const arb = this.arbiters.get(norm.chatJid);
      arb?.onMessage(norm); // arbiter has its own staleness + isBot guards
      if (!norm.isBot && fresh) {
        // both memory (facts) and voice learning run even while asleep — the owner wants the bot's
        // understanding of the group to keep growing overnight. Both respect the daily budget.
        this.extractors.get(norm.chatJid)?.onActivity();
        this.voiceProfilers.get(norm.chatJid)?.onActivity();
      }
      this.bus.publish({ kind: 'stats', stats: this.repo.getStats() });
    }
  }

  /** Download an image/sticker from the LIVE message (real buffers) and cache it locally. */
  private async downloadMedia(messageId: string, raw: WAMessage, type: string): Promise<void> {
    try {
      const sock = this.conn.sock;
      const buffer = await downloadMediaMessage(raw, 'buffer', {}, sock ? {
        logger: waLogger,
        reuploadRequest: sock.updateMediaMessage,
      } : undefined as any);
      const ext = type === 'sticker' ? 'webp' : 'jpg';
      const filePath = path.join(IMAGE_DIR, `${messageId.replace(/[^a-zA-Z0-9_-]/g, '_')}.${ext}`);
      fs.writeFileSync(filePath, buffer as Buffer);
      this.repo.setMediaPath(messageId, filePath);
    } catch (err) {
      logger.debug({ err, messageId, type }, 'media download failed');
    }
  }

  /**
   * Serve a message's image/sticker media for the dashboard feed. Lazily downloads + caches it from
   * the stored raw message the first time it's viewed — covers inbound AND bot-sent, images AND
   * stickers, without touching the hot message path.
   */
  async getMediaFile(id: string): Promise<{ path: string; contentType: string } | null> {
    const row = this.repo.getMessageById(id) as { type?: string; media_path?: string | null; raw?: string } | undefined;
    if (!row || (row.type !== 'image' && row.type !== 'sticker')) return null;
    const contentType = row.type === 'sticker' ? 'image/webp' : 'image/jpeg';
    if (row.media_path && fs.existsSync(row.media_path)) return { path: row.media_path, contentType };
    try {
      const raw = row.raw ? JSON.parse(row.raw) as WAMessage : null;
      if (!raw) return null;
      const sock = this.conn.sock;
      const buffer = await downloadMediaMessage(raw, 'buffer', {}, sock ? {
        logger: waLogger,
        reuploadRequest: sock.updateMediaMessage,
      } : undefined as any);
      const ext = row.type === 'sticker' ? 'webp' : 'jpg';
      const filePath = path.join(IMAGE_DIR, `${id.replace(/[^a-zA-Z0-9_-]/g, '_')}.${ext}`);
      fs.writeFileSync(filePath, buffer as Buffer);
      this.repo.setMediaPath(id, filePath);
      return { path: filePath, contentType };
    } catch (err) {
      logger.debug({ err, id }, 'feed media download failed');
      return null;
    }
  }

  private ensureArbiter(chatJid: string): void {
    if (this.arbiters.has(chatJid)) return;
    this.arbiters.set(chatJid, new Arbiter(
      chatJid, this.repo, this.ai, this.gatekeeper, this.generator, this.outbound, this.jids,
      {
        onDecision: (tier, decision, reason) =>
          this.bus.publish({ kind: 'decision', chatJid, ts: Date.now(), tier, decision, reason }),
        onAction: (action) => {
          this.bus.publish({ kind: 'action', chatJid, ts: Date.now(), action });
          this.bus.publish({ kind: 'stats', stats: this.repo.getStats() });
          this.bus.publish({ kind: 'status', status: this.statusPayload() });
        },
        onPhase: () => this.bus.publish({ kind: 'status', status: this.statusPayload() }),
      },
    ));
    this.extractors.set(chatJid, new FactExtractor(chatJid, this.repo, this.ai, this.prompts, {
      onFact: (memberJid, fact, category) => {
        this.bus.publish({ kind: 'fact', chatJid, memberJid, fact, category });
        this.bus.publish({ kind: 'status', status: this.statusPayload() });
      },
    }));
    this.voiceProfilers.set(chatJid, new VoiceProfiler(chatJid, this.repo, this.ai, this.prompts, {
      onLearned: (count) => {
        this.bus.publish({ kind: 'voice', chatJid, count });
        this.bus.publish({ kind: 'status', status: this.statusPayload() });
      },
    }));
  }

  /** Link a group: it runs simultaneously with all other linked groups. */
  async linkGroup(jid: string): Promise<void> {
    this.linkedGroups.add(jid);
    this.persistLinkedGroups();
    this.ensureArbiter(jid);
    this.arbiters.get(jid)!.setPaused(false); // a freshly linked group always starts active
    this.prompts.memoryVersion += 1;
    await this.groups.metadata(jid, true);

    const introKey = `intro_sent_${jid}`;
    if (this.repo.getConfig('intro_enabled') !== '0' && this.repo.getConfig(introKey) !== '1') {
      await this.outbound.sendText(jid, this.repo.getConfig('intro_message') ?? INTRO_MESSAGE);
      this.repo.setConfig(introKey, '1');
    }
    this.bus.publish({ kind: 'status', status: this.statusPayload() });
  }

  /** Unlink one group: bot goes dormant there; its memory stays in the DB for relinking. */
  unlinkGroup(jid: string): void {
    this.linkedGroups.delete(jid);
    this.persistLinkedGroups();
    this.arbiters.get(jid)?.setPaused(true); // stop any pending timers; instance kept for relink
    this.bus.publish({ kind: 'status', status: this.statusPayload() });
  }

  resetRateLimits(): void {
    for (const arbiter of this.arbiters.values()) arbiter.resetRateLimit();
  }

  sleepGroup(jid: string): void {
    this.arbiters.get(jid)?.sleep();
  }

  /** Manual voice-learn: deep re-scan of stored chat history for this group. */
  learnVoiceFromChat(jid: string): Promise<VoiceLearnResult> {
    const vp = this.voiceProfilers.get(jid);
    if (!vp) return Promise.resolve({ status: 'empty', learned: 0 });
    return vp.learnFromChat();
  }

  /** Manual voice-learn: mine the group's stored facts + summary for voice style. */
  learnVoiceFromMemory(jid: string): Promise<VoiceLearnResult> {
    const vp = this.voiceProfilers.get(jid);
    if (!vp) return Promise.resolve({ status: 'empty', learned: 0 });
    return vp.learnFromMemory();
  }

  setPaused(jid: string, paused: boolean): void {
    const arbiter = this.arbiters.get(jid);
    if (arbiter) arbiter.setPaused(paused);
    else this.repo.setConfig(`paused_${jid}`, paused ? '1' : '0');
    this.bus.publish({ kind: 'status', status: this.statusPayload() });
  }

  /** Aggregate every saved knowledge item across all groups into nodes for the Neurons viz.
   *  Edges are generated client-side (purely visual), so we only return the node list. */
  buildNeurons(): { nodes: NeuronNode[]; generatedAt: number } {
    const nodes: NeuronNode[] = [];
    const trim = (s: string | null | undefined, n = 280): string => {
      const v = (s ?? '').trim();
      return v.length > n ? v.slice(0, n) + '…' : v;
    };
    const label = (s: string): string => (s.length > 40 ? s.slice(0, 40) + '…' : s) || '(no text)';
    const groupName = (jid: string | null): string | null => (jid ? (this.groups.subjectOf(jid) ?? jid.split('@')[0]) : null);
    const memberName = (jid: string | null): string | null => (jid ? (this.repo.getMember(jid)?.display_name ?? jid.split('@')[0]) : null);
    const push = (id: string, type: NeuronNode['type'], t: number, raw: string, opts: { group?: string | null; member?: string | null; category?: string | null } = {}) => {
      const text = trim(raw) || '(no text)';
      nodes.push({ id, type, t: t || 0, label: label(text), text, group: opts.group ?? null, member: opts.member ?? null, category: opts.category ?? null });
    };

    for (const f of this.repo.getAllFacts()) push(`fact:${f.id}`, 'fact', f.created_at, f.fact, { group: groupName(f.chat_jid), member: memberName(f.member_jid), category: f.category });
    for (const v of this.repo.getAllVoiceItems()) push(`voice:${v.id}`, 'voice', v.created_at, v.content, { group: groupName(v.chat_jid), member: memberName(v.member_jid), category: v.category });
    for (const r of this.repo.getAllMemberReports()) push(`report:${r.id}`, 'report', r.created_at, r.bio || r.summary || '', { member: memberName(r.member_jid) });
    for (const s of this.repo.getAllStatHistory()) push(`stat:${s.id}`, 'stat', s.created_at, [s.label, s.reason].filter(Boolean).join(' — ') || `${s.stat_key}: ${s.value ?? '?'}`, { member: memberName(s.member_jid), category: s.stat_key });
    for (const o of this.repo.getAllObservations()) push(`observation:${o.id}`, 'observation', o.ts, o.observation, { group: groupName(o.chat_jid), member: memberName(o.member_jid) });
    for (const l of this.repo.getAllInfluenceLessons()) push(`lesson:${l.id}`, 'lesson', l.ts, l.text, { group: groupName(l.chat_jid) });
    for (const p of this.repo.getAllPrinciples()) push(`principle:${p.id}`, 'principle', p.created_at, p.content);
    for (const st of this.repo.getStickers()) push(`sticker:${st.id}`, 'sticker', st.added_at, st.description || st.usage_hint || 'sticker');
    for (const g of this.repo.getAllSummaries()) push(`summary:${g.chat_jid}`, 'summary', g.updated_at, g.summary, { group: groupName(g.chat_jid) });

    return { nodes, generatedAt: Date.now() };
  }

  getSettings(): StatusPayload['settings'] {
    const last4 = (k: 'anthropic_api_key' | 'gemini_api_key' | 'elevenlabs_api_key') => {
      const v = this.repo.getKey(k);
      return v.length >= 4 ? v.slice(-4) : null;
    };
    return {
      anthropic_key_set: this.repo.hasKey('anthropic_api_key'),
      anthropic_key_last4: last4('anthropic_api_key'),
      gemini_key_set: this.repo.hasKey('gemini_api_key'),
      gemini_key_last4: last4('gemini_api_key'),
      elevenlabs_key_set: this.repo.hasKey('elevenlabs_api_key'),
      elevenlabs_key_last4: last4('elevenlabs_api_key'),
      dashboard_protected: !!process.env.DASHBOARD_PASSWORD,
      gatekeeper_model: this.repo.getConfig('gatekeeper_model') ?? 'sonnet',
      generation_model: this.repo.getConfig('generation_model') ?? 'sonnet',
      effort: this.repo.getConfig('effort') ?? 'low',
      daily_budget_usd: Number(this.repo.getConfig('daily_budget_usd') ?? DEFAULT_DAILY_BUDGET_USD),
      msg_prefix: this.repo.getConfig('msg_prefix') ?? DEFAULT_MSG_PREFIX,
      msg_suffix: this.repo.getConfig('msg_suffix') ?? DEFAULT_MSG_SUFFIX,
      voice_enabled: this.repo.getConfig('voice_enabled') === '1',
      voice_available: this.repo.hasKey('elevenlabs_api_key'),
      voice_id: this.repo.getConfig('voice_id') || ELEVENLABS.DEFAULT_VOICE_ID,
      persona_mode: this.repo.getConfig('persona_mode') ?? 'default',
      persona_custom: this.repo.getConfig('persona_custom') ?? '',
      sticker_freq: this.repo.getConfig('sticker_freq') ?? 'often',
      voice_freq: this.repo.getConfig('voice_freq') ?? 'sometimes',
      emoji_freq: this.repo.getConfig('emoji_freq') ?? 'often',
      intro_message: this.repo.getConfig('intro_message') ?? INTRO_MESSAGE,
      intro_enabled: this.repo.getConfig('intro_enabled') !== '0',
      rate_per_min: Number(this.repo.getConfig('rate_per_min') ?? 4),
      rate_per_hour: Number(this.repo.getConfig('rate_per_hour') ?? 30),
      super_idle_minutes: Number(this.repo.getConfig('super_idle_minutes') ?? 30),
      image_enabled: this.repo.getConfig('image_enabled') === '1',
      image_available: this.repo.hasKey('gemini_api_key'),
      image_model: this.repo.getConfig('image_model') ?? 'flash',
      image_freq: this.repo.getConfig('image_freq') ?? 'rare',
      images_per_day: Number(this.repo.getConfig('images_per_day') ?? IMAGE_GEN.DEFAULT_PER_DAY),
      images_today: this.repo.imagesToday(),
      typing_indicators: this.repo.getConfig('typing_indicators') === '1',
      token_reduction: this.repo.getConfig('token_reduction') === '1',
      initiative_enabled: this.repo.getConfig('initiative_enabled') === '1',
    };
  }

  private groupStatus(jid: string, allStats: Record<string, number>): GroupStatus {
    const arbiter = this.arbiters.get(jid);
    return {
      jid,
      name: this.groups.subjectOf(jid),
      paused: arbiter?.paused ?? this.repo.getConfig(`paused_${jid}`) === '1',
      asleep: arbiter?.asleep ?? false,
      phase: arbiter?.phase ?? 'IDLE',
      stats: {
        messages_read: allStats[`messages_read:${jid}`] ?? 0,
        messages_sent: allStats[`messages_sent:${jid}`] ?? 0,
        facts_learned: allStats[`facts_learned:${jid}`] ?? 0,
        t1_calls: allStats[`t1_calls:${jid}`] ?? 0,
        t2_calls: allStats[`t2_calls:${jid}`] ?? 0,
        cost_microusd: allStats[`cost_microusd:${jid}`] ?? 0,
      },
    };
  }

  statusPayload(): StatusPayload {
    const allStats = this.repo.getStats();
    const groups = [...this.linkedGroups].sort().map(jid => this.groupStatus(jid, allStats));

    const stats: Record<string, number> = {};
    for (const [k, v] of Object.entries(allStats)) {
      if (!k.includes(':')) stats[k] = v; // global keys only
    }
    stats['cost_today_usd_cents'] = Math.round(this.ai.spentTodayMicro() / 10_000);

    return {
      // demo: report a connected/online bot (there's no real WhatsApp) so the UI shows the main view
      connection: DEMO_MODE ? 'open' : this.conn.state,
      online: DEMO_MODE ? true : this.online,
      needsSetup: this.needsSetup,
      demo: DEMO_MODE,
      keys: {
        anthropic: this.repo.hasKey('anthropic_api_key'),
        gemini: this.repo.hasKey('gemini_api_key'),
        elevenlabs: this.repo.hasKey('elevenlabs_api_key'),
      },
      groups,
      stats,
      settings: this.getSettings(),
    };
  }
}

function toFeed(m: NormalizedMessage, mentions?: Record<string, string>): FeedMessage {
  return {
    id: m.id,
    shortId: m.shortId,
    senderName: m.isBot ? 'ForceAI' : m.senderName,
    isBot: m.isBot,
    isOwner: m.isOwner,
    type: m.type,
    text: mentions ? applyMentions(m.text, mentions) : m.text,
    quotedText: m.quotedText && mentions ? applyMentions(m.quotedText, mentions) : m.quotedText,
    reactionEmoji: m.reactionEmoji,
    ts: m.ts,
  };
}
