export class PayloadBudget {
  private expires: number;
  private remaining: number;
  constructor(milliseconds: number, readonly signal?: AbortSignal, private readonly now = () => performance.now()) {
    if (!Number.isFinite(milliseconds) || milliseconds <= 0 || milliseconds > 60_000) throw new Error('invalid payload budget');
    this.remaining = milliseconds;
    this.expires = now() + milliseconds;
  }
  remainingMs(): number {
    this.remaining = Math.max(0, Math.min(this.remaining, this.expires - this.now()));
    return this.remaining;
  }
  checkpoint(): void {
    if (this.signal?.aborted || this.remainingMs() <= 0) throw new Error('payload cancelled or expired');
  }
}
