import fs from 'node:fs';
import path from 'node:path';
import { downloadMediaMessage, type WAMessage } from 'baileys';
import { INTRO_MESSAGE, DEFAULT_DAILY_BUDGET_USD, DEFAULT_MSG_PREFIX, DEFAULT_MSG_SUFFIX, ELEVENLABS, IMAGE_DIR, IMAGE_GEN } from './config.js';
import { logger, waLogger } from './logger.js';
import { openDb } from './memory/db.js';
import { Repo } from './memory/repo.js';
import { FactExtractor } from './memory/extractor.js';
import { VoiceProfiler, type VoiceLearnResult } from './memory/voice.js';
import { MemberReporter, type ReportResult } from './memory/reporter.js';
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
import type { FeedMessage, GroupStatus, NormalizedMessage, StatusPayload } from './types.js';

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
  /** all groups the bot is currently live in — each has its own arbiter/extractor */
  linkedGroups = new Set<string>();
  private arbiters = new Map<string, Arbiter>();
  private extractors = new Map<string, FactExtractor>();
  private voiceProfilers = new Map<string, VoiceProfiler>();
  private memberReporter: MemberReporter;

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

    this.loadLinkedGroups();
    this.online = this.repo.getConfig('bot_online') !== '0'; // restore shutdown state across restarts
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

    if (this.online) {
      await this.conn.start();
    } else {
      // booted in shutdown state — keep the dashboard up but stay disconnected
      logger.info('booting in SHUTDOWN state — WhatsApp not connected until Power On');
      for (const a of this.arbiters.values()) a.suspend();
      this.conn.setOffline();
    }

    // weekly member-report scheduler (independent of WhatsApp; checks the clock every 30 min)
    this.memberReporter.start();
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

    this.repo.insertMessage(norm);
    this.store.put(norm.id, norm.shortId, norm.raw);
    this.bus.publish({ kind: 'message', chatJid: norm.chatJid, message: toFeed(norm) });

    if (source === 'sent') return; // our own send — recorded, nothing to react to

    const fresh = Date.now() - norm.ts < 120_000; // never act on stale backlog re-deliveries

    if (isSelfChat) {
      if (fresh) void this.stickers.onSelfChatMessage(norm);
      return;
    }

    if (isLinkedGroup) {
      // download inbound images BEFORE the arbiter runs, so Claude can see them — this
      // also covers owner "Admin: describe this image" on a captioned image (immediate gen).
      if (norm.type === 'image' && !norm.isBot && fresh) {
        await this.downloadImage(norm.id, norm.raw);
      }
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

  private async downloadImage(messageId: string, raw: WAMessage): Promise<void> {
    try {
      const sock = this.conn.sock;
      const buffer = await downloadMediaMessage(raw, 'buffer', {}, sock ? {
        logger: waLogger,
        reuploadRequest: sock.updateMediaMessage,
      } : undefined as any);
      const filePath = path.join(IMAGE_DIR, `${messageId.replace(/[^a-zA-Z0-9_-]/g, '_')}.jpg`);
      fs.writeFileSync(filePath, buffer);
      this.repo.setMediaPath(messageId, filePath);
    } catch (err) {
      logger.debug({ err, messageId }, 'inbound image download failed');
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

  getSettings(): StatusPayload['settings'] {
    return {
      gatekeeper_model: this.repo.getConfig('gatekeeper_model') ?? 'sonnet',
      generation_model: this.repo.getConfig('generation_model') ?? 'sonnet',
      effort: this.repo.getConfig('effort') ?? 'low',
      daily_budget_usd: Number(this.repo.getConfig('daily_budget_usd') ?? DEFAULT_DAILY_BUDGET_USD),
      msg_prefix: this.repo.getConfig('msg_prefix') ?? DEFAULT_MSG_PREFIX,
      msg_suffix: this.repo.getConfig('msg_suffix') ?? DEFAULT_MSG_SUFFIX,
      voice_enabled: this.repo.getConfig('voice_enabled') === '1',
      voice_available: !!process.env.ELEVENLABS_API_KEY,
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
      image_available: !!process.env.GEMINI_API_KEY,
      image_model: this.repo.getConfig('image_model') ?? 'flash',
      image_freq: this.repo.getConfig('image_freq') ?? 'rare',
      images_per_day: Number(this.repo.getConfig('images_per_day') ?? IMAGE_GEN.DEFAULT_PER_DAY),
      images_today: this.repo.imagesToday(),
      typing_indicators: this.repo.getConfig('typing_indicators') === '1',
      token_reduction: this.repo.getConfig('token_reduction') === '1',
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
      connection: this.conn.state,
      online: this.online,
      groups,
      stats,
      settings: this.getSettings(),
    };
  }
}

function toFeed(m: NormalizedMessage): FeedMessage {
  return {
    id: m.id,
    shortId: m.shortId,
    senderName: m.isBot ? 'ForceAI' : m.senderName,
    isBot: m.isBot,
    isOwner: m.isOwner,
    type: m.type,
    text: m.text,
    quotedText: m.quotedText,
    reactionEmoji: m.reactionEmoji,
    ts: m.ts,
  };
}
