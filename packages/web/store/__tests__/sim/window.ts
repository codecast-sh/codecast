// One simulated browser window (docs/architecture/multiplayer-sim-harness.md,
// section 3.3): its own store instance, its own engine closure (dispatch,
// outbox, tees), and the production code that feeds it, wired to the sim's
// server through the net instead of a Convex socket.
//
// THE CLIENT. Every call the window's code makes (the dispatch binding, the
// sync-log catch-up, the floor, the digest comparer's heals) is a `req` then a
// `res` on `conn:<win>`. The req runs the real handler and commits; the res
// runs inside the window's turn and settles the caller's promise. A mutation's
// res first re-runs every live feed of the window at the current db version,
// so a window reads its own writes as Convex guarantees. Errors cross the wire
// in the shape the Convex client gives them ("Uncaught Error: ..."), which is
// what the engine's permanent/transient split reads.
//
// LIVE FEEDS. A host window mounts the feeders the app's sync host mounts
// (the base inbox list, the liveness overlay, the team list and overlay in
// team scope, and the sync-log heads that wake catch-up) as live channels on
// the net. A write anywhere marks them dirty; a delivery recomputes the query
// then and applies it through the appliers the hooks export and call
// themselves (applyInboxListPayload, applyMineLivenessPayload,
// applyTeamListPayload, applyTeamLivenessPayload). Followers mount none:
// their store is fed by the host's replication (sim/device.ts).
//
// What is real: the dispatch binding and failure handler (lib/dispatchBinding),
// catch-up and its runner (useSyncChangeFeed), the inbox floor
// (runInboxFloorStep), bootstrap floors (useBootstrapCollection), the
// registered-feed applier (applyCollectionFeed), the chat page ingest, the
// gesture bridge receiver, the digest comparer (startInboxDigestCompare), a
// conversation's transcript tail (tail) and the pending-send coverage poll
// (coverage, run when a scenario asks).
// What the sim leaves out: React, IndexedDB (the outbox is an in-memory Map
// per window), the hooks' 300ms push coalescing (each push applies on its own
// delivery), the 1.5s heads debounce and the 60s safety-net catch-up tick,
// the recovery polls except after a clock jump (recoveryPoll; a sim
// subscription stalls only when lagged),
// message warming, and the currentUser and clientState feeders: boot seeds
// both once from the world, so a server-side change to either (another
// device's workspace switch, the CLI's) never reaches a sim window.

import { getFunctionName } from "convex/server";
import { api } from "@codecast/convex/convex/_generated/api";
import type { Principal, SimBackend, SimClient } from "@codecast/convex/convex/simBackend.testing";
import type { OutboxEntry } from "@platform/engine";
import { __createInboxStoreForTests, placeInboxRows, useInboxStore } from "../../inboxStore";
import { subscribeGestures } from "../../gestureBridge";
import { applyBridgedGesture } from "../../syncReplication";
import type { InboxCompareOutcome, InboxDigestComparer } from "../../inboxDigestCompare";
import { applyDispatchFailure, makeDispatchBinding, newDispatchAckState, type DispatchAckState } from "../../../lib/dispatchBinding";
import { ingestChatPage, CHAT_PAGE_SIZE } from "../../../lib/ingestChatPage";
import { applyInboxListPayload, LIST_INBOX_SESSIONS_ARGS } from "../../../hooks/useLiveInboxSessions";
import { applyMineLivenessPayload, inboxFloorFlags, runInboxFloorStep } from "../../../hooks/useSyncInboxSessions";
import { applyTeamListPayload, applyTeamLivenessPayload, teamInboxArgs } from "../../../hooks/useSyncTeamInboxSessions";
import { applyCollectionFeed } from "../../../hooks/useSyncCollection";
import { createCatchUpRunner } from "../../../hooks/useSyncChangeFeed";
import { bootstrapFloorFor, bootstrapFloorKey, startBootstrapFloor } from "../../../hooks/useBootstrapCollection";
import { startInboxDigestCompare } from "../../../hooks/useInboxDigestCompare";
import { reconcileStorePendingCoverage } from "../../../hooks/usePendingMessageCoverage";
import type { Net } from "./net";
import { now, runInWindow, type RealmWindow, type SimStore } from "./realm";
import type { SimDevice } from "./device";

/** What a window needs of the world: the server, the net, and the window registry `net.online` routes through. */
export interface SimWindowWorld {
  readonly backend: SimBackend;
  readonly net: Net;
  /** Every window by name. A window registers itself; the world's net calls `windowOnline` from its onOnline. */
  readonly windows: Map<string, SimWindow>;
  /**
   * How the world settles a window's boot. Default: a full drain. The legacy
   * suites (inboxSimHarness.ts) settle only what the boot itself started, so
   * a window opened mid-run moves neither the clock nor another device's queue.
   */
  settleBoot?(w: SimWindow): Promise<void>;
  /** A world that wakes catch-up by hand (the legacy suites) sets this: a host's boot starts none. */
  readonly holdCatchUp?: boolean;
}

export type SimPrincipal = { userId: string };
export type BootScope = "mine" | { team: string };
export type WindowRole = "host" | "follower";
export type WriteListener = (patches: readonly any[], state: any) => void;

type Kind = "query" | "mutation" | "action";
type FeedOpts = { select?: (data: any) => any; syncOpts?: Record<string, any> };

/** The net's onOnline: the window drains its outbox, as a browser `online` event does. */
export function windowOnline(world: SimWindowWorld, win: string): void {
  world.windows.get(win)?.reconnected();
}

// What the Convex client hands a caller when the server refused a call: the
// function's own error under "Uncaught", a validator's ArgumentValidationError
// as is, and a ConvexError's data kept on the error.
function clientError(name: string, error: any): Error {
  const message = String(error?.message ?? error);
  const shown = /^ArgumentValidationError/.test(message)
    ? message
    : `Uncaught ${error?.name === "ConvexError" ? "ConvexError" : "Error"}: ${message}`;
  const out = new Error(`[sim ${name}] Server Error\n${shown}`) as Error & { data?: unknown };
  if (error?.data !== undefined) out.data = error.data;
  return out;
}

// The feeds the recovery polls re-run (useSyncInboxSessions, useSyncTeamInboxSessions).
const RECOVERY_POLL_FEEDS = ["inbox", "liveness", "team", "teamLiveness"] as const;

export class SimWindow implements RealmWindow {
  readonly store: SimStore = __createInboxStoreForTests();
  /** This window's server access through the net: every call is a req and a res on `conn:<name>`. */
  readonly client: SimClient;
  /** The engine outbox, in memory (production keeps it in IndexedDB). */
  readonly outbox = new Map<string, OutboxEntry>();
  /** Failures the window's background work reported (catch-up, floors, replication posts). Empty in a healthy run. */
  readonly errors: string[] = [];
  readonly principal: Principal;
  role: WindowRole;
  closed = false;
  comparer: InboxDigestComparer | null = null;

  private readonly server: SimClient;
  private readonly ackState: DispatchAckState = newDispatchAckState();
  private readonly live = new Map<string, () => Promise<void>>();
  private readonly writeListeners = new Set<WriteListener>();
  private readonly bootstraps = new Map<string, () => ReturnType<typeof bootstrapFloorFor>>();
  private readonly bootstrapsCut = new Set<string>();
  private catchUpNow: (() => void) | null = null;
  private lastHeads: string | null = null;
  private dropResponses = 0;
  private unbridge: (() => void) | null = null;
  private scope: BootScope = "mine";

  constructor(
    readonly world: SimWindowWorld,
    readonly user: SimPrincipal,
    readonly device: SimDevice,
    role: WindowRole,
    readonly name: string,
  ) {
    if (name.includes(":") || /\s/.test(name)) throw new Error(`sim window: name "${name}" may not hold ':' or whitespace (it names net channels)`);
    if (world.windows.has(name)) throw new Error(`sim window: a window named "${name}" already exists`);
    world.windows.set(name, this);
    this.role = role;
    this.principal = { kind: "user", userId: user.userId };
    this.server = world.backend.clientFor(this.principal);
    this.client = {
      query: (ref, args) => this.call("query", ref, args),
      mutation: (ref, args) => this.call("mutation", ref, args),
      action: (ref, args) => this.call("action", ref, args),
    };
  }

  get conn(): string {
    return `conn:${this.name}`;
  }

  /** One turn of this window (realm.runInWindow). */
  run<T>(fn: () => T | Promise<T>): Promise<T> {
    return runInWindow(this, fn);
  }

  /**
   * Wire the window as the app does at load, then drain the net to quiescence.
   * Every window: identity and scope, dispatch, outbox, the write tee, the
   * gesture bridge, the digest comparer, and its replication role (the device
   * attaches a host runtime or joins as a follower). A host also mounts its
   * feeders and starts catch-up; the floor follows once the log stamps.
   */
  async boot(opts: { scope?: BootScope } = {}): Promise<void> {
    this.scope = opts.scope ?? "mine";
    const userRow = this.world.backend.db._tables.users?.find((u: any) => u._id === this.user.userId);
    await this.run(() => {
      const s = this.store.getState() as any;
      s.syncTable("currentUser", userRow ? structuredClone(userRow) : { _id: this.user.userId });
      const team = typeof this.scope === "object" ? this.scope.team : undefined;
      s.syncTable("clientState", {
        ui: {
          inbox_scope: team ? "team" : "mine",
          ...(team ? { active_team_id: team } : userRow?.active_team_id ? { active_team_id: userRow.active_team_id } : {}),
        },
      });
      // The app sets these by hand once its IndexedDB hydration settles.
      this.store.setState({ clientStateInitialized: true, syncRole: this.role } as any);
      s._setDispatchError(applyDispatchFailure);
      s._setOutbox(
        (entry: OutboxEntry) => void this.outbox.set(entry.id, structuredClone(entry)),
        (id: string) => void this.outbox.delete(id),
        async () => [...this.outbox.values()].sort((a, b) => a.ts - b.ts).map((e) => structuredClone(e)),
      );
      s._setDispatch(makeDispatchBinding((args) => this.client.mutation(api.dispatch.dispatch, args), this.ackState));
      s._setIDBWrite((patches: any[], state: any) => this.teeWrite(patches, state));
      const currentUserId = () => useInboxStore.getState().currentUser?._id?.toString?.() ?? null;
      this.unbridge = subscribeGestures(this.user.userId, currentUserId, applyBridgedGesture);
      this.comparer = startInboxDigestCompare(this.client, () => () => {}).comparer;
      this.device.attach(this);
      if (this.role === "host") this.startHost();
    });
    await (this.world.settleBoot ? this.world.settleBoot(this) : this.world.net.drain());
  }

  // -- Host duties --

  /** Mount the host feeders and start catch-up. Also the promotion path when a follower takes over. */
  startHost(): void {
    this.catchUpNow = createCatchUpRunner(this.client, {
      onError: (e) => this.report("catch-up", e),
      onSettled: () => this.afterCatchUp(),
    });
    this.mount("inbox", api.conversations.listInboxSessions, () => LIST_INBOX_SESSIONS_ARGS, (data) => void applyInboxListPayload(data, this.client));
    this.mount("liveness", api.conversations.sessionsLiveness, () => ({}), (data) => void applyMineLivenessPayload(data));
    // The decision queue: the questions bucket's input (useSyncSessionDecisions).
    this.mount("decisions", api.sessionDecisions.listForUser, () => ({}), (data) => applyCollectionFeed("sessionDecisions", data));
    if (typeof this.scope === "object") {
      const team = this.scope.team;
      this.mount("team", api.conversations.listTeamInboxSessions, () => teamInboxArgs(team), (data) => void applyTeamListPayload(data, team));
      this.mount("teamLiveness", api.conversations.teamSessionsLiveness, () => ({ activeTeamId: team }), (data) => void applyTeamLivenessPayload(team, data));
    }
    // The wake signal: the heads subscription. A change of any head runs
    // catch-up (production debounces this by 1.5s; the sim runs it at once).
    this.mount("heads", api.syncLog.getHeads, () => ({}), (data) => {
      const sig = JSON.stringify(data ?? null);
      if (sig === this.lastHeads) return;
      this.lastHeads = sig;
      this.catchUpNow?.();
    });
    // Catch-up on load, as the hook runs it when hydration settles.
    if (!this.world.holdCatchUp) this.catchUpNow();
  }

  /**
   * Run catch-up now, as a heads change would (the floor step follows it).
   * For a caller that holds the heads feed and wakes catch-up by hand: the
   * legacy suites (inboxSimHarness.ts) deliver every feed explicitly.
   */
  async catchUp(): Promise<void> {
    this.requireHost("catchUp()");
    await this.run(() => this.catchUpNow?.());
  }

  /** Stop being a host: unmount every feeder (the window closed, or handed the role on). */
  stopHost(): void {
    for (const channel of this.live.keys()) this.world.net.unmountLive(channel);
    this.live.clear();
    this.catchUpNow = null;
    this.lastHeads = null;
  }

  /**
   * A registered collection's live feed, applied through applyCollectionFeed
   * as useSyncCollection does. Mounted on the host only; `args` may return
   * "skip".
   */
  async feed(key: string, query: any, args: () => Record<string, any> | "skip", opts: FeedOpts = {}): Promise<void> {
    this.requireHost(`feed("${key}")`);
    await this.run(() => this.mount(`feed-${key}`, query, args, (data) => applyCollectionFeed(key, data, opts.select, opts.syncOpts as any)));
  }

  /** A chat channel's live page, ingested as useChannelMessagesSync does. */
  async chatPage(channelId: string): Promise<void> {
    this.requireHost(`chatPage("${channelId}")`);
    await this.run(() =>
      this.mount(`chat-${channelId}`, api.chat.listMessages, () => ({ channel_id: channelId, limit: CHAT_PAGE_SIZE }), (data) => {
        if (!data) return;
        if (data.unavailable) {
          useInboxStore.getState().retireChatChannel(channelId);
          return;
        }
        ingestChatPage(data, this.client as any);
      }),
    );
  }

  /**
   * A conversation's live transcript tail, as useConversationMessages
   * subscribes it: listMessagesTail past the anchor, applied through
   * applyTailMessages, the apply that retires a send's bubble once its echo
   * lands. A per-view query, so any window may mount it. Returns the channel,
   * so a scenario can lag it. Convex pushes a query only when its result
   * changes, so an unchanged result is not applied again.
   */
  async tail(conversationId: string): Promise<string> {
    const feed = `messages-${conversationId}`;
    let anchor = 0;
    let applied: string | null = null;
    await this.run(() =>
      this.mount(feed, api.conversations.listMessagesTail, () => ({ conversation_id: conversationId, after_timestamp: anchor }), (res) => {
        const sig = JSON.stringify(res ?? null);
        if (!res || sig === applied) return;
        applied = sig;
        useInboxStore.getState().applyTailMessages(conversationId, anchor, res.messages ?? [], res.last_timestamp ?? null);
        // A burst past the server cap: the next result continues where this one ended.
        if (res.has_more && res.last_timestamp != null) anchor = res.last_timestamp - 1;
      }),
    );
    return `live:${this.name}:${feed}`;
  }

  /**
   * One pass of the pending-send coverage poll (usePendingMessageCoverage, a
   * 60s recovery poll in the app): bubbles the server holds settle, refused
   * ones fail. A conn delivery that starts the pass, as the poll timer does;
   * its queries are further conn deliveries. Returns the delivery's seq.
   */
  coverage(): number {
    return this.world.net.enqueue(this.conn, {
      label: "poll: pending-send coverage",
      producer: `${this.name} coverage`,
      run: () =>
        this.run(() => {
          void reconcileStorePendingCoverage(
            (conversation_id, command_ids) => this.client.query(api.messages.getMessageCoverageV2, { conversation_id, command_ids }),
            () => !this.closed,
          ).catch((e) => this.report("coverage", e));
        }),
    });
  }

  /**
   * One pass of the inbox recovery polls (useRecoveryPoll over the base lists
   * and the liveness overlays): each re-runs its feed at the current time once
   * no push arrived within INBOX_RECOVERY_STALE_MS. A time-bounded window a
   * clock jump moves reaches the app's store this way, with no data change to
   * push it, so the world runs one after each such jump (SimWorld.afterAdvance).
   */
  recoveryPoll(): number {
    return this.world.net.enqueue(this.conn, {
      label: "poll: inbox recovery",
      producer: `${this.name} recovery`,
      run: () => this.run(() => this.refeed(RECOVERY_POLL_FEEDS)),
    });
  }

  /**
   * A log-covered collection's one-shot bootstrap floor (useBootstrapCollection):
   * cut once its scopes are stamped, and recut when the floor epoch moves.
   */
  async bootstrap(key: string, query: any, args: Record<string, any> | "skip", opts: FeedOpts = {}): Promise<void> {
    this.requireHost(`bootstrap("${key}")`);
    this.bootstraps.set(key, () => bootstrapFloorFor(useInboxStore.getState(), this.client, key, query, args, opts));
    await this.run(() => this.cutBootstraps());
  }

  private requireHost(what: string): void {
    if (this.role !== "host") throw new Error(`sim window ${this.name}: ${what} needs a host window; followers mount no feeders`);
  }

  private afterCatchUp(): void {
    if (this.closed || this.role !== "host") return;
    runInboxFloorStep(this.client, inboxFloorFlags(useInboxStore.getState(), this.user.userId));
    this.cutBootstraps();
  }

  private cutBootstraps(): void {
    for (const make of this.bootstraps.values()) {
      const run = make();
      if (!run) continue;
      const key = bootstrapFloorKey(run.principal, run.epoch, run.key, run.args);
      if (this.bootstrapsCut.has(key)) continue;
      this.bootstrapsCut.add(key);
      startBootstrapFloor(run);
    }
  }

  // A live query: its delivery recomputes the query at delivery time and
  // applies the answer inside this window's turn.
  private mount(feed: string, query: any, args: () => Record<string, any> | "skip", apply: (data: any) => void): void {
    const channel = `live:${this.name}:${feed}`;
    const name = getFunctionName(query);
    const refresh = async () => {
      if (this.closed) return;
      const a = args();
      if (a === "skip") return;
      let data: any;
      try {
        data = await this.server.query(query, a);
      } catch (e: any) {
        throw new Error(`sim window ${this.name}: live feed ${feed} (${name}) failed: ${e?.message ?? e}`);
      }
      await this.run(() => apply(data));
    };
    this.live.set(channel, refresh);
    this.world.net.mountLive(channel, { run: refresh, label: `push ${name}`, producer: `${this.name} ${feed}` });
    this.world.net.markDirty(channel);
  }

  // -- The wire --

  /** The next n committed mutation responses reject with a network error, after the commit. */
  dropResponse(n = 1): void {
    this.dropResponses += n;
  }

  /** The net's onOnline for this window: re-drive parked dispatches, as the browser `online` event does. */
  reconnected(): void {
    if (this.closed) return;
    this.world.net.enqueue(this.conn, {
      label: "online: drain outbox",
      producer: `${this.name} online`,
      run: () => this.run(() => (this.store.getState() as any)._drainOutbox()),
    });
  }

  private call(kind: Kind, ref: any, args: any): Promise<any> {
    const name = typeof ref === "string" ? ref : getFunctionName(ref);
    const producer = `${this.name} ${name}`;
    const net = this.world.net;
    return new Promise((resolve, reject) => {
      net.enqueue(this.conn, {
        label: `req ${kind} ${name}`,
        producer,
        run: async () => {
          let ok = true;
          let value: any;
          try {
            value = await this.server[kind](ref, args);
          } catch (e) {
            ok = false;
            value = clientError(name, e);
          }
          net.enqueue(this.conn, {
            label: `res ${name}${ok ? "" : " (error)"}`,
            producer,
            run: async () => {
              if (this.closed) return;
              await this.run(async () => {
                if (kind === "mutation" && ok) {
                  // Read-your-writes: the live feeds reflect the commit before
                  // the caller sees the mutation resolve.
                  await this.refeed();
                  if (this.dropResponses > 0) {
                    this.dropResponses--;
                    reject(new Error(`sim net: the connection dropped before the response to ${name} arrived`));
                    return;
                  }
                }
                if (ok) resolve(value);
                else reject(value);
              });
            },
          });
        },
      });
    });
  }

  // -- Tees --

  /** Observe every store write this window makes (what production hands IndexedDB). Returns the unsubscribe. */
  onWrite(fn: WriteListener): () => void {
    this.writeListeners.add(fn);
    return () => this.writeListeners.delete(fn);
  }

  /**
   * Re-runs every live feed of this window once (or the feeds `only` names),
   * at the current db version. A held feed (lagged, or offline) is skipped:
   * the window cannot hear it.
   */
  async refeed(only?: readonly string[]): Promise<void> {
    const prefix = `live:${this.name}:`;
    for (const [channel, refresh] of this.live) {
      if (only && !only.includes(channel.slice(prefix.length))) continue;
      if (!this.world.net.held(channel)) await refresh();
    }
  }

  /** The registered collections this window feeds: live feeds (`feed`) and bootstrap floors (`bootstrap`). */
  get feeds(): ReadonlySet<string> {
    const prefix = `live:${this.name}:feed-`;
    const live = [...this.live.keys()].filter((c) => c.startsWith(prefix)).map((c) => c.slice(prefix.length));
    return new Set([...live, ...this.bootstraps.keys()]);
  }

  private teeWrite(patches: any[], state: any): void {
    for (const fn of this.writeListeners) fn(patches, state);
    if (this.role === "host") this.device.hostTee(this, patches, state);
  }

  // -- Reading the window --

  /** The inbox as this window renders it, from the chokepoint every surface uses. */
  placed(scope: "mine" | "team" = "mine") {
    return this.run(() => placeInboxRows(useInboxStore.getState() as any, { scope, now: now() }));
  }

  /** One digest-compare tick against this window's state. */
  tick(): Promise<InboxCompareOutcome> {
    const comparer = this.comparer;
    if (!comparer) throw new Error(`sim window ${this.name}: tick() before boot()`);
    return this.run(() => comparer.tick(useInboxStore.getState() as any));
  }

  /** Close the window: no more feeds, deliveries to it land nowhere. */
  close(): void {
    if (this.closed) return;
    this.stopHost();
    this.unbridge?.();
    this.unbridge = null;
    this.comparer?.dispose();
    this.closed = true;
  }

  report(what: string, e: unknown): void {
    this.errors.push(`${what}: ${String((e as Error)?.message ?? e)}`);
  }
}
