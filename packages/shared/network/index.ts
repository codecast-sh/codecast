/** How long a new socket may sit in CONNECTING before we kill the handshake. */
export const WEBSOCKET_HANDSHAKE_TIMEOUT_MS = 15_000;

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
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);
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
        clearTimeout(timeout);
        clearTimeout(closeTimeout);
      });
    }
  };
}
