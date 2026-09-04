export class ReadSnapshot<T> {
  private value: { data: T; at: number } | null = null;
  private inflight: Promise<void> | null = null;
  private revision = 0;
  private requestedAt: number | null = null;
  constructor(private readonly read: () => Promise<T>, readonly maxAgeMs = 5000, private readonly refreshAfterMs = 1000, private readonly now = Date.now) {}
  get(): { data: T; at: number } | null {
    const now = this.now();
    const age = this.value ? now - this.value.at : -1;
    if ((age < 0 || age >= this.refreshAfterMs) && (this.requestedAt === null || now < this.requestedAt || now - this.requestedAt >= this.refreshAfterMs)) void this.refresh();
    return this.value && age >= 0 && age <= this.maxAgeMs ? this.value : null;
  }
  refresh(): Promise<void> {
    if (this.inflight) return this.inflight;
    const revision = this.revision;
    this.requestedAt = this.now();
    const pending = this.read().then(data => {
      if (revision === this.revision) this.value = { data, at: this.now() };
    }, () => {}).finally(() => { if (this.inflight === pending) this.inflight = null; });
    this.inflight = pending;
    return pending;
  }
  invalidate() { this.revision++; this.value = null; this.requestedAt = null; }
}
