// One simulated machine's origin for one principal
// (docs/architecture/multiplayer-sim-harness.md, section 3.5): a host window
// and its followers, and the two channels same-origin windows talk over.
//
// REPLICATION. The engine's own runtimes (createReplicationHost and
// createReplicationFollower) over an in-memory hub shaped like the engine's
// test hub (replicationRuntime.test.ts): a post reaches every other window,
// structured-cloned, as a `repl:<from>><to>` delivery that runs inside the
// receiver's turn. The host tee is the window's write tee, so the runtime
// computes its own shadow identity diff. A follower joins with a chunked
// snapshot request; the host sends each chunk after a setTimeout(0), which the
// realm turns into a timer delivery, so a live write can land between chunks.
// A synced follower offers its own action writes through the production
// follower tee (syncReplication.followerActionTee) and applies host updates
// through applyUpdatesToStore, as startSyncReplication wires them.
//
// GESTURE BRIDGE. The sim installs one channel factory (setGestureChannelFactory)
// that routes by the window running now: a post becomes one
// `bridge:<device>:<from>` delivery per sibling window of the same device,
// handled by the window's real subscribeGestures receiver.
//
// What the sim leaves out: Web Locks election (the device names its host;
// closeHost promotes the first follower the way a released lock would) and
// the follower's solo fallback after 8s without a host.

import {
  createReplicationFollower,
  createReplicationHost,
  type ReplicationChannel,
  type ReplicationFollower,
  type ReplicationHost,
  type ReplicationMessage,
} from "@platform/engine";
import { setGestureChannelFactory } from "../../gestureBridge";
import { applyUpdatesToStore, followerActionTee } from "../../syncReplication";
import { isReplicatedCollectionKey, REPLICATED_STORE_KEYS } from "../../clientSyncRegistry";
import { activeWindow, type RealmWindow } from "./realm";
import { SimWindow, type BootScope, type SimPrincipal, type SimWindowWorld } from "./window";

type Handler = (event: { data: unknown }) => void;
type BridgeSub = { channel: object; name: string; handler: Handler };

const deviceOf = new WeakMap<RealmWindow, SimDevice>();

// The sim's gesture channel: the posting or subscribing window is the one
// running now. Outside a window (or for a window with no device) there is no
// channel, as in a browser without BroadcastChannel.
function simGestureChannel(name: string): BroadcastChannel | null {
  const w = activeWindow();
  const device = w ? deviceOf.get(w) : undefined;
  return device ? device.bridgeChannel(w as SimWindow, name) : null;
}

function describe(msg: ReplicationMessage): string {
  switch (msg.type) {
    case "update":
      return `update #${msg.seq} from ${msg.origin}`;
    case "snapshotChunk":
      return `snapshotChunk ${msg.index}${msg.done ? " (last)" : ""} to ${msg.to}`;
    case "hello":
      return `hello${msg.snapshotRequest ? ` ${msg.snapshotRequest}` : ""}`;
    case "mut":
      return `mut from ${msg.from}`;
    default:
      return msg.type;
  }
}

export class SimDevice {
  readonly windows: SimWindow[] = [];
  private hostRuntime: ReplicationHost | null = null;
  private readonly followerRuntimes = new Map<SimWindow, ReplicationFollower>();
  private readonly replSubs = new Map<SimWindow, Set<(msg: ReplicationMessage) => void>>();
  private readonly bridgeSubs = new Map<SimWindow, BridgeSub[]>();
  private windowCount = 0;

  constructor(
    readonly world: SimWindowWorld,
    readonly user: SimPrincipal,
    readonly name: string,
  ) {
    if (name.includes(":") || /\s/.test(name)) throw new Error(`sim device: name "${name}" may not hold ':' or whitespace (it names net channels)`);
    setGestureChannelFactory(simGestureChannel);
  }

  /** The window holding the host role. */
  get host(): SimWindow {
    const host = this.windows.find((w) => w.role === "host");
    if (!host) throw new Error(`sim device ${this.name}: no host window`);
    return host;
  }

  get followers(): SimWindow[] {
    return this.windows.filter((w) => w.role === "follower");
  }

  /** A host window, then `followers` follower windows, each booted and drained. */
  async start(opts: { followers?: number; scope?: BootScope } = {}): Promise<this> {
    await this.addWindow("host", { scope: opts.scope });
    for (let i = 0; i < (opts.followers ?? 0); i++) await this.addWindow("follower", { scope: opts.scope });
    return this;
  }

  /** Open a window on this device. The first one must be the host. Default names: `<device>-host`, `<device>-w<n>`. */
  async addWindow(role: "host" | "follower", opts: { scope?: BootScope; name?: string } = {}): Promise<SimWindow> {
    if (role === "host" && this.windows.some((w) => w.role === "host")) throw new Error(`sim device ${this.name}: already has a host`);
    if (role === "follower" && !this.windows.some((w) => w.role === "host")) throw new Error(`sim device ${this.name}: a follower needs a host to join`);
    const name = opts.name ?? (role === "host" ? `${this.name}-host` : `${this.name}-w${++this.windowCount}`);
    const w = new SimWindow(this.world, this.user, this, role, name);
    deviceOf.set(w, this);
    this.windows.push(w);
    await w.boot({ scope: opts.scope });
    return w;
  }

  /**
   * Called by the window during boot (inside its turn): the host starts the
   * replication host runtime; a follower starts the follower runtime, which
   * asks for a chunked snapshot.
   */
  attach(w: SimWindow): void {
    if (w.role === "host") this.startHostRuntime(w);
    else this.startFollowerRuntime(w);
  }

  /** The host window's write tee: every store write's patches, broadcast through the runtime. */
  hostTee(w: SimWindow, patches: readonly any[], state: any): void {
    if (this.windows.includes(w) && w.role === "host") this.hostRuntime?.tee(patches as any, state);
  }

  /**
   * Close the host window and promote the first follower through the
   * runtimes' own paths: the follower stops following, becomes the host
   * runtime and mounts the host feeders. Other followers resync from the new
   * host when its first update arrives. Drains the net. Returns the new host.
   */
  async closeHost(): Promise<SimWindow | null> {
    const old = this.host;
    this.hostRuntime?.stop();
    this.hostRuntime = null;
    this.retire(old);
    const next = this.followers[0];
    if (next) {
      await next.run(() => {
        this.followerRuntimes.get(next)?.stop();
        this.followerRuntimes.delete(next);
        next.role = "host";
        next.store.setState({ syncRole: "host" } as any);
        (next.store.getState() as any)._setActionTee(null);
        this.startHostRuntime(next);
        next.startHost();
      });
    }
    await this.world.net.drain();
    return next ?? null;
  }

  /** Close one follower window. */
  closeWindow(w: SimWindow): void {
    if (w.role === "host") throw new Error(`sim device ${this.name}: close the host with closeHost()`);
    this.followerRuntimes.get(w)?.stop();
    this.followerRuntimes.delete(w);
    this.retire(w);
  }

  private retire(w: SimWindow): void {
    w.close();
    this.windows.splice(this.windows.indexOf(w), 1);
    this.replSubs.delete(w);
    this.bridgeSubs.delete(w);
  }

  private startHostRuntime(w: SimWindow): void {
    this.hostRuntime = createReplicationHost({
      hostId: w.name,
      channel: this.port(w),
      getState: () => w.store.getState(),
      replicatedKeys: REPLICATED_STORE_KEYS,
      isCollectionKey: isReplicatedCollectionKey,
      // A follower's mut: its optimistic rows, held under the same locks.
      applyUpdates: (updates) => applyUpdatesToStore(updates, { optimistic: true }),
    });
  }

  private startFollowerRuntime(w: SimWindow): void {
    const channel = this.port(w);
    this.followerRuntimes.set(
      w,
      createReplicationFollower({
        selfId: w.name,
        channel,
        replicatedKeys: REPLICATED_STORE_KEYS,
        isCollectionKey: isReplicatedCollectionKey,
        // The host's rows: authoritative for this window.
        applyUpdates: (updates) => applyUpdatesToStore(updates),
        onSynced: (synced) => {
          if (synced) (w.store.getState() as any)._setActionTee(followerActionTee(channel, w.name));
        },
      }),
    );
  }

  /** True once the follower holds a synced stream from the host. */
  synced(w: SimWindow): boolean {
    return this.followerRuntimes.get(w)?.synced() ?? false;
  }

  // The in-memory hub: a post reaches every other window of the device,
  // cloned as BroadcastChannel clones it, in order per sender and receiver.
  private port(w: SimWindow): ReplicationChannel {
    let subs = this.replSubs.get(w);
    if (!subs) this.replSubs.set(w, (subs = new Set()));
    const mine = subs;
    return {
      post: (msg) => {
        // A window alone on its device has no one to hear it: skip the clone.
        if (!this.windows.some((to) => to !== w)) return;
        let copy: ReplicationMessage;
        try {
          copy = structuredClone(msg);
        } catch (e) {
          // Production logs and drops an uncloneable post; the sim reports it.
          w.report("replication post", e);
          return;
        }
        for (const to of this.windows) {
          if (to === w) continue;
          this.world.net.enqueue(`repl:${w.name}>${to.name}`, {
            label: describe(copy),
            producer: `${w.name} replication`,
            run: () => {
              const receivers = this.replSubs.get(to);
              if (to.closed || !receivers?.size) return;
              return to.run(() => {
                for (const cb of [...receivers]) cb(copy);
              });
            },
          });
        }
      },
      onMessage: (cb) => {
        mine.add(cb);
        return () => mine.delete(cb);
      },
    };
  }

  /** The gesture channel object `name` opens in window `w` (see simGestureChannel). */
  bridgeChannel(w: SimWindow, name: string): BroadcastChannel {
    const channel = {};
    const subsOf = (x: SimWindow) => {
      let subs = this.bridgeSubs.get(x);
      if (!subs) this.bridgeSubs.set(x, (subs = []));
      return subs;
    };
    const drop = (keep: (s: BridgeSub) => boolean) => {
      const subs = this.bridgeSubs.get(w);
      if (subs) this.bridgeSubs.set(w, subs.filter(keep));
    };
    Object.assign(channel, {
      postMessage: (data: unknown) => {
        const copy = structuredClone(data);
        for (const to of this.windows) {
          if (to === w || !this.bridgeSubs.get(to)?.some((s) => s.name === name)) continue;
          this.world.net.enqueue(`bridge:${this.name}:${w.name}`, {
            label: `gesture ${(copy as any)?.kind ?? "?"} to ${to.name}`,
            producer: `${w.name} gesture`,
            run: () => {
              if (to.closed) return;
              const handlers = (this.bridgeSubs.get(to) ?? []).filter((s) => s.name === name).map((s) => s.handler);
              if (!handlers.length) return;
              return to.run(() => {
                for (const h of handlers) h({ data: copy });
              });
            },
          });
        }
      },
      addEventListener: (type: string, handler: Handler) => {
        if (type === "message") subsOf(w).push({ channel, name, handler });
      },
      removeEventListener: (type: string, handler: Handler) => {
        if (type === "message") drop((s) => s.channel !== channel || s.handler !== handler);
      },
      close: () => drop((s) => s.channel !== channel),
    });
    return channel as unknown as BroadcastChannel;
  }
}
