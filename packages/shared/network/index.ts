/** How long a new socket may sit in CONNECTING before we kill the handshake. */
export const WEBSOCKET_HANDSHAKE_TIMEOUT_MS = 15_000;
export const MAX_CONCURRENT_MUTATIONS = 8;

export function recoveringWebSocket({
  Native = globalThis.WebSocket,
  timeoutMs = WEBSOCKET_HANDSHAKE_TIMEOUT_MS,
  completeMissingClose = false,
}: {
  Native?: typeof WebSocket;
  timeoutMs?: number;
  completeMissingClose?: boolean;
} = {}): typeof WebSocket | undefined {
  if (!Native) return undefined;
  return class extends Native {
    private pendingMutations = new Map<number, string>();
    private activeMutations = new Set<number>();

    override send(data: Parameters<WebSocket["send"]>[0]) {
      if (typeof data !== "string" || this.readyState !== Native.OPEN) return super.send(data);
      const message = JSON.parse(data);
      if (message.type !== "Mutation") return super.send(data);
      if (this.activeMutations.has(message.requestId)) return;
      this.pendingMutations.set(message.requestId, data);
      this.flushMutations();
    }

    private flushMutations() {
      if (this.readyState !== Native.OPEN) return;
      for (const [id, data] of this.pendingMutations) {
        if (this.activeMutations.size >= MAX_CONCURRENT_MUTATIONS) break;
        super.send(data);
        this.pendingMutations.delete(id);
        this.activeMutations.add(id);
      }
    }

    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);
      this.addEventListener("message", (event) => {
        const message = JSON.parse(event.data);
        if (message.type !== "MutationResponse") return;
        this.activeMutations.delete(message.requestId);
        this.flushMutations();
      });
      let closed = false;
      let closeTimeout: ReturnType<typeof setTimeout> | undefined;
      const timeout = setTimeout(() => {
        if (this.readyState !== Native.CONNECTING) return;
        if (completeMissingClose) closeTimeout = setTimeout(() => {
          if (!closed) this.dispatchEvent(Object.assign(new Event("close"), {
            code: 1006, reason: "WebSocket handshake timed out", wasClean: false,
          }));
        }, 1_000);
        this.close();
      }, timeoutMs);
      this.addEventListener("open", () => clearTimeout(timeout), { once: true });
      this.addEventListener("close", (event) => {
        if (closed) {
          event.stopImmediatePropagation();
          return;
        }
        closed = true;
        this.pendingMutations.clear();
        this.activeMutations.clear();
        clearTimeout(timeout);
        clearTimeout(closeTimeout);
      });
    }
  };
}
