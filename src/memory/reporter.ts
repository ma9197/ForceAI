import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { REPORT } from '../config.js';
import { logger } from '../logger.js';
import type { AiClient } from '../ai/client.js';
import { MEMBER_REPORTER_SYSTEM, type PromptBuilder } from '../ai/prompts.js';
import { BatchReportSchema, type BatchReportOut } from '../ai/schemas.js';
import type { Repo } from '../memory/repo.js';
import type { MemberCodeStats } from '../types.js';

export interface ReporterEvents { onReports(count: number): void; }
export type ReportStatus = 'ok' | 'busy' | 'budget' | 'empty' | 'error';
export interface ReportResult { status: ReportStatus; updated: number; }

const STAT_KEYS = ['mood', 'iq', 'aggression'] as const;

/**
 * Weekly per-PERSON dossier generator. GLOBAL (one instance) — reports are per person, pooled
 * across all their groups. Runs every Sunday morning (a clock check on a 30-min interval, with a
 * persisted last-run so it survives restarts), or on demand via run('manual'). Hybrid + all-Sonnet:
 * heavy members get a focused per-member call, light members are batched. Judges stats gradually
 * (history-weighted) and stores a weekly snapshot + reason for every change.
 */
export class MemberReporter {
  private running = false;
  private timer: NodeJS.Timeout | null = null;
  private codeStats = new Map<string, MemberCodeStats>();

  constructor(
    private repo: Repo,
    private ai: AiClient,
    private prompts: PromptBuilder,
    private events: ReporterEvents,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), 30 * 60_000);
    this.tick(); // also check right after boot
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  private tick(): void {
    const now = new Date();
    const lastRun = Number(this.repo.getConfig('member_report_ts') ?? 0);
    const daysSince = (Date.now() - lastRun) / 86_400_000;
    const h = now.getUTCHours();
    const inWindow = h >= REPORT.RUN_HOUR_UTC && h < REPORT.RUN_HOUR_UTC + REPORT.RUN_WINDOW_HOURS;
    if (now.getUTCDay() === 0 && inWindow && daysSince >= REPORT.MIN_DAYS_BETWEEN) void this.run('weekly');
  }

  /** Most recent Sunday 00:00 UTC — the snapshot label for this week's reports. */
  private weekStartMs(): number {
    const d = new Date();
    d.setUTCHours(0, 0, 0, 0);
    d.setUTCDate(d.getUTCDate() - d.getUTCDay());
    return d.getTime();
  }

  async run(trigger: 'weekly' | 'manual'): Promise<ReportResult> {
    if (this.running) return { status: 'busy', updated: 0 };
    if (this.ai.isOverBudget()) return { status: 'budget', updated: 0 };
    this.running = true;
    try {
      const firstRun = !this.repo.getConfig('member_report_ts');
      const weekStart = this.weekStartMs();
      const dataWindowStart = firstRun ? 0 : Date.now() - 7 * 86_400_000; // the week that just passed
      this.codeStats = this.repo.computeAllCodeStats();

      const counts = this.repo.getActiveMemberCounts(dataWindowStart);
      const active = [...counts.keys()];
      if (active.length === 0) {
        this.repo.setConfig('member_report_ts', String(Date.now()));
        return { status: 'empty', updated: 0 };
      }

      const heavy = active.filter(j => (counts.get(j) ?? 0) >= REPORT.HEAVY_MIN_MSGS);
      const light = active.filter(j => (counts.get(j) ?? 0) < REPORT.HEAVY_MIN_MSGS);

      let updated = 0;
      // deep pass: one focused call per heavy member
      for (const jid of heavy) {
        if (this.ai.isOverBudget()) break;
        const reports = await this.callModel([{ jid, digest: this.buildDigest(jid, dataWindowStart, true) }]);
        updated += this.persist(reports, weekStart);
      }
      // light pass: batched calls
      for (let i = 0; i < light.length; i += REPORT.BATCH_SIZE) {
        if (this.ai.isOverBudget()) break;
        const chunk = light.slice(i, i + REPORT.BATCH_SIZE).map(jid => ({ jid, digest: this.buildDigest(jid, dataWindowStart, false) }));
        const reports = await this.callModel(chunk);
        updated += this.persist(reports, weekStart);
      }

      this.repo.setConfig('member_report_ts', String(Date.now()));
      this.repo.pruneMemberObservations(Date.now() - 14 * 86_400_000);
      if (updated > 0) {
        this.repo.bumpStat('member_reports_generated', updated);
        this.prompts.memoryVersion += 1; // refresh Block B's subtle per-member tone (phase 3)
        this.events.onReports(updated);
      }
      logger.info({ trigger, heavy: heavy.length, light: light.length, updated }, 'member reports generated');
      return { status: 'ok', updated };
    } catch (err) {
      logger.error({ err }, 'member reporter failed');
      return { status: 'error', updated: 0 };
    } finally {
      this.running = false;
    }
  }

  private nameFor(jid: string): string {
    return this.repo.getMember(jid)?.display_name ?? jid.split('@')[0];
  }

  /** Assemble one person's cross-group evidence into a compact digest for the model. */
  private buildDigest(jid: string, windowStart: number, deep: boolean): string {
    const code = this.codeStats.get(jid);
    const prior = this.repo.getLatestReport(jid);
    const priorStats = this.repo.getLatestStats(jid);
    const locks = new Set(this.repo.getStatLocks(jid));
    const facts = this.repo.getFactsForMember(jid).map(f => f.fact);
    const styleNotes = this.repo.getMemberStyleNotes(jid).map(s => s.content);
    const obs = this.repo.getMemberObservations(jid, windowStart).map(o => o.observation);
    const groups = this.repo.getMemberGroups(jid);
    const sample = this.repo.getMemberMessageSample(jid, windowStart, deep ? REPORT.SAMPLE_MSGS : Math.ceil(REPORT.SAMPLE_MSGS / 3));

    const statLine = (key: typeof STAT_KEYS[number]) => {
      const s = priorStats.find(x => x.stat_key === key);
      const lock = locks.has(key) ? ' [LOCKED]' : '';
      return s && s.value != null ? `${key} ${Math.round(s.value)} (${s.label ?? ''})${lock}` : `${key} none-yet${lock}`;
    };

    const lines = [
      `PERSON: ${this.nameFor(jid)} [${jid}]`,
      `SEEN IN: ${groups.map(g => `${g.chat_jid.split('@')[0]} (${g.count} msgs)`).join(', ') || '—'}`,
      prior?.bio ? `PRIOR BIO: ${prior.bio}` : 'PRIOR BIO: (none — first dossier)',
      `PRIOR STATS: ${statLine('mood')} · ${statLine('iq')} · ${statLine('aggression')}`,
      code
        ? `ACTIVITY (90d): ${code.messages_window} msgs · ${Math.round(code.starter_ratio * 100)}% conversation-starter (${code.starts} starts / ${code.contributions} joins) · peak ${code.top_hour}:00 day-${code.top_day} · avg ${code.avg_len} chars · ${code.emoji_rate.toFixed(1)} emoji/msg · ${Math.round(code.question_rate * 100)}% questions · replies most to ${code.reply_network.map(r => this.nameFor(r.jid)).join(', ') || '—'}`
        : 'ACTIVITY: little recent activity',
      facts.length ? `KNOWN FACTS: ${facts.join('; ')}` : '',
      styleNotes.length ? `HOW THEY TEXT: ${styleNotes.join('; ')}` : '',
      obs.length ? `FORCEAI'S PRIVATE NOTES THIS WEEK: ${obs.join(' | ')}` : '',
      sample.length ? `RECENT MESSAGES (newest first):\n${sample.map(s => `  - ${s.text}`).join('\n')}` : 'RECENT MESSAGES: (none in window)',
    ].filter(Boolean);
    return lines.join('\n');
  }

  private async callModel(members: { jid: string; digest: string }[]): Promise<BatchReportOut['reports']> {
    const body = members.map(m => m.digest).join('\n\n----\n\n');
    const response = await this.ai.client.messages.parse({
      model: REPORT.MODEL,
      max_tokens: REPORT.MAX_OUTPUT_TOKENS,
      system: MEMBER_REPORTER_SYSTEM,
      messages: [{
        role: 'user',
        content: `Write or update the weekly dossier for ${members.length === 1 ? 'this person' : 'these people'}. Return one report per person, echoing each member_jid exactly.\n\n${body}`,
      }],
      output_config: { format: zodOutputFormat(BatchReportSchema) },
    });
    this.ai.recordUsage(REPORT.MODEL, response.usage, 'report');
    return response.parsed_output?.reports ?? [];
  }

  private persist(reports: BatchReportOut['reports'], weekStart: number): number {
    let n = 0;
    for (const r of reports) {
      const jid = r.member_jid?.trim();
      if (!jid || !this.repo.getMember(jid)) continue; // ignore hallucinated / unknown jids
      const rep = r.report;
      this.repo.insertMemberReport(jid, weekStart, rep.bio?.trim() || null, rep.week_summary?.trim() || null, rep.talking_style?.trim() || null);
      const locks = new Set(this.repo.getStatLocks(jid));
      for (const key of STAT_KEYS) {
        if (locks.has(key)) continue; // never overwrite an owner-locked stat
        const s = rep[key];
        if (s && typeof s.value === 'number') {
          const v = key === 'iq' ? Math.max(40, Math.min(160, s.value)) : Math.max(0, Math.min(100, s.value));
          this.repo.insertStatSnapshot(jid, weekStart, key, v, s.label?.trim() || null, s.reason?.trim() || null);
        }
      }
      n += 1;
    }
    return n;
  }
}
