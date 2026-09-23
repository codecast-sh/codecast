/** Serialize saved Codex thread recovery across app-server processes. A ready
 * event from a replacement process must run a fresh pass even if the previous
 * process's pass is still settling. */
export class CodexRecoveryQueue {
  private inFlight: Promise<void> | null = null;
  private newProcessQueued = false;
  private demandQueued = false;
  private readonly requestedConversations = new Set<string>();

  constructor(
    private readonly recover: (requestedConversations: ReadonlySet<string>) => Promise<void>,
    private readonly clearRetryDelays: () => void,
    private readonly onError: (error: unknown) => void,
  ) {}

  request(newProcess = false): void {
    if (newProcess) this.newProcessQueued = true;
    if (this.inFlight) return;
    this.inFlight = Promise.resolve()
      .then(() => {
        this.demandQueued = false;
        if (this.newProcessQueued) {
          this.clearRetryDelays();
          this.newProcessQueued = false;
        }
        return this.recover(this.requestedConversations);
      })
      .catch(this.onError)
      .finally(() => {
        this.inFlight = null;
        if (this.newProcessQueued || this.demandQueued) this.request();
      });
  }

  async demand(conversationId: string): Promise<void> {
    this.requestedConversations.add(conversationId);
    this.demandQueued = true;
    this.request();
    try {
      await this.wait();
    } finally {
      this.requestedConversations.delete(conversationId);
    }
  }

  async wait(): Promise<void> {
    while (this.inFlight) await this.inFlight;
  }
}
