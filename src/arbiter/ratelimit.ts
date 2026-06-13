/** Rolling-window rate caps for bot actions. Caps are read live so Settings changes apply instantly. */
export class RateLimiter {
  private actionTs: number[] = [];

  constructor(private getCaps: () => { perMin: number; perHour: number }) {}

  private prune(): void {
    const cutoff = Date.now() - 3_600_000;
    this.actionTs = this.actionTs.filter(t => t > cutoff);
  }

  canAct(): boolean {
    this.prune();
    const { perMin, perHour } = this.getCaps();
    const now = Date.now();
    const lastMin = this.actionTs.filter(t => t > now - 60_000).length;
    return lastMin < perMin && this.actionTs.length < perHour;
  }

  record(): void {
    this.actionTs.push(Date.now());
  }

  /** Forget all recorded actions — the "refresh" button. */
  reset(): void {
    this.actionTs = [];
  }
}
