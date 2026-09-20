/** Serialize saved Codex thread recovery across app-server processes. A ready
 * event from a replacement process must run a fresh pass even if the previous
 * process's pass is still settling. */
export class CodexRecoveryQueue {
  private inFlight: Promise<void> | null = null;
  private newProcessQueued = false;

  constructor(
    private readonly recover: () => Promise<void>,
    private readonly clearRetryDelays: () => void,
    private readonly onError: (error: unknown) => void,
  ) {}

  request(newProcess = false): void {
    if (newProcess) this.newProcessQueued = true;
    if (this.inFlight) return;
    this.inFlight = Promise.resolve()
      .then(() => {
        if (this.newProcessQueued) {
          this.clearRetryDelays();
          this.newProcessQueued = false;
        }
        return this.recover();
      })
      .catch(this.onError)
      .finally(() => {
        this.inFlight = null;
        if (this.newProcessQueued) this.request();
      });
  }

  async wait(): Promise<void> {
    while (this.inFlight) await this.inFlight;
  }
}
