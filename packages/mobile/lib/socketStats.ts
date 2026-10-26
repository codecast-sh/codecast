// Live counters across every Convex socket the phone opens, read by the
// foreground code (lib/foregroundResume.ts, lib/foregroundSyncTrace.ts):
// when a connect started, whether anything arrived and how often, and how many
// mutations the shared wrapper's concurrency cap is holding back. Frame data
// is never read for these.
//
// The counting lives here, in a subclass of the shared wrapper, so the CLI and
// web, which share that wrapper, carry none of it.
import { recoveringWebSocket } from '@codecast/shared/network';

export const socketStats = {
  lastConnectAt: 0,
  opens: 0,
  lastOpenAt: 0,
  lastMessageAt: 0,
  messagesIn: 0,
  heldMutations: 0,
  activeMutations: 0,
};

/** The shared recovering socket, counted. */
export function countingWebSocket(): typeof WebSocket | undefined {
  const Base = recoveringWebSocket();
  if (!Base) return undefined;
  return class extends Base {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);
      socketStats.lastConnectAt = Date.now();
      this.addEventListener('open', () => {
        socketStats.opens++;
        socketStats.lastOpenAt = Date.now();
      }, { once: true });
      // Registered after the wrapper's own listeners, so the counts read its
      // bookkeeping after it ran.
      this.addEventListener('message', () => {
        socketStats.lastMessageAt = Date.now();
        socketStats.messagesIn++;
        this.countMutations();
      });
      this.addEventListener('close', () => this.countMutations());
    }

    override send(data: Parameters<WebSocket['send']>[0]) {
      super.send(data);
      this.countMutations();
    }

    // The wrapper's queues are private to it; read, never written.
    private countMutations() {
      const self = this as unknown as { pendingMutations?: Map<number, string>; activeMutations?: Set<number> };
      socketStats.heldMutations = self.pendingMutations?.size ?? 0;
      socketStats.activeMutations = self.activeMutations?.size ?? 0;
    }
  };
}
