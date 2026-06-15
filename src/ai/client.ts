import Anthropic from '@anthropic-ai/sdk';
import { DEFAULT_DAILY_BUDGET_USD, GATEKEEPER_MODELS, GENERATION_MODEL, GENERATION_MODELS, PRICING, type GatekeeperChoice, type GenerationChoice } from '../config.js';
import { logger } from '../logger.js';
import type { Repo } from '../memory/repo.js';

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

/** Wraps the Anthropic client with settings, cost accounting and a daily budget. */
export class AiClient {
  client: Anthropic;

  constructor(private repo: Repo) {
    this.client = new Anthropic(); // ANTHROPIC_API_KEY from env
  }

  // ---- settings ----
  get gatekeeperModel(): string {
    const choice = (this.repo.getConfig('gatekeeper_model') ?? 'sonnet') as GatekeeperChoice;
    return GATEKEEPER_MODELS[choice] ?? GATEKEEPER_MODELS.sonnet;
  }

  get utilityModel(): string {
    // fact extractor / summary / voice profiler follow the gatekeeper choice
    return this.gatekeeperModel;
  }

  get generationModel(): string {
    const choice = (this.repo.getConfig('generation_model') ?? 'sonnet') as GenerationChoice;
    return GENERATION_MODELS[choice] ?? GENERATION_MODEL;
  }

  get effort(): 'low' | 'medium' | 'high' {
    const e = this.repo.getConfig('effort') ?? 'low';
    return (['low', 'medium', 'high'].includes(e) ? e : 'low') as 'low' | 'medium' | 'high';
  }

  get dailyBudgetUsd(): number {
    return Number(this.repo.getConfig('daily_budget_usd') ?? DEFAULT_DAILY_BUDGET_USD);
  }

  // ---- budget ----
  private todayKey(): string {
    return new Date().toISOString().slice(0, 10);
  }

  /** Spent today in micro-USD. */
  spentTodayMicro(): number {
    const date = this.repo.getConfig('cost_date');
    if (date !== this.todayKey()) return 0;
    return Number(this.repo.getConfig('cost_today_micro') ?? '0');
  }

  isOverBudget(): boolean {
    return this.spentTodayMicro() / 1_000_000 >= this.dailyBudgetUsd;
  }

  recordUsage(model: string, usage: Usage, tier: 't1' | 't2' | 'extract' | 'voice', chatJid?: string): void {
    const p = PRICING[model];
    const cacheRead = usage.cache_read_input_tokens ?? 0;
    const cacheWrite = usage.cache_creation_input_tokens ?? 0;
    let micro = 0;
    if (p) {
      micro = Math.round(
        usage.input_tokens * p.in +
        usage.output_tokens * p.out +
        cacheRead * p.cacheRead +
        cacheWrite * p.cacheWrite
      ); // tokens × $/MTok = micro-USD
    }

    this.applySpend(micro, chatJid);
    this.repo.bumpStat(`${tier}_calls`);
    this.repo.bumpStat('input_tokens', usage.input_tokens);
    this.repo.bumpStat('output_tokens', usage.output_tokens);
    this.repo.bumpStat('cache_read_tokens', cacheRead);
    this.repo.bumpStat('cache_write_tokens', cacheWrite);
    if (chatJid) this.repo.bumpStat(`${tier}_calls:${chatJid}`);

    logger.debug({ model, tier, usage, micro }, 'API usage recorded');
  }

  /** Record non-token spend (image generation) — counts toward budget + per-group + global cost. */
  recordImageCost(micro: number, chatJid?: string): void {
    this.applySpend(micro, chatJid);
    this.repo.bumpStat('image_cost_microusd', micro);
  }

  /** Shared cost bookkeeping: daily budget counter + global/per-group cost stats. */
  private applySpend(micro: number, chatJid?: string): void {
    const today = this.todayKey();
    if (this.repo.getConfig('cost_date') !== today) {
      this.repo.setConfig('cost_date', today);
      this.repo.setConfig('cost_today_micro', '0');
    }
    this.repo.setConfig('cost_today_micro', String(this.spentTodayMicro() + micro));
    this.repo.bumpStat('cost_microusd', micro);
    if (chatJid) this.repo.bumpStat(`cost_microusd:${chatJid}`, micro);
  }
}
