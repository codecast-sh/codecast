// Invariant self-test (docs/architecture/multiplayer-sim-harness.md, unit U11):
// each invariant passes on a clean world, and fails on a planted violation
// with a report that names the invariant and the row. The coverage guard runs
// against the live REPLICATION_CLASSIFICATION and against a fake extra key.
//
// The fixture is the least a check reads: the real backend over genTeamWorld
// rows, and windows that are store instances fed by the real feeders (the
// liveness overlay, the team list, catchUp, and the sessions the base list and
// the overlay name, fetched by id the way the floor fetches them). A planted
// violation is a direct write to one side, the server db or a window's store.

import { afterEach, describe, expect, test } from "bun:test";
import { inboxEpoch } from "@codecast/shared/contracts";
import { convexIdFor } from "@codecast/shared/contracts/__fixtures__/inboxProjectionGen";
import { genTeamWorld, membershipIdFor, teamIdFor, userIdFor } from "@codecast/shared/contracts/__fixtures__/teamWorldGen";
import { hourBucket } from "@codecast/convex/convex/lib/chatQuota";
import { MENTION_WAKES_PER_SENDER_HOUR, MENTION_WAKES_PER_TARGET_HOUR } from "@codecast/convex/convex/chat";
import { chatRelayClientId } from "@codecast/convex/convex/lib/chatWakeIds";
import { makeSimBackend, type SimBackend } from "@codecast/convex/convex/simBackend.testing";
import { snapshotEntries } from "@platform/engine";
import { syncLogScopeMetaKey, useInboxStore } from "../../../inboxStore";
import { HIDDEN_OVERRIDE_SETTLE_MS } from "../../../inboxOverlays";
import { REGISTERED_FEEDS, REPLICATED_STORE_KEYS, REPLICATION_CLASSIFICATION } from "../../../clientSyncRegistry";
import { applyCollectionFeed } from "../../../../hooks/useSyncCollection";
import { LIST_INBOX_SESSIONS_ARGS, applyLiveInboxIds } from "../../../../hooks/useLiveInboxSessions";
import { applyTeamInboxIds, teamInboxArgs } from "../../../../hooks/useSyncTeamInboxSessions";
import { applyMineLivenessPayload } from "../../../../hooks/useSyncInboxSessions";
import { applyEntityIds, catchUp, emptyIdsByCollection } from "../../../../hooks/useSyncChangeFeed";
import { Net } from "../net";
import { SimLabels } from "../labels";
import { advance, attachRealm, createWindowStore, installRealm, now, runInWindow, stream, T0, uninstallRealm, type SimStore } from "../realm";
import { SimWorld } from "../world";
import { checkInvariants, failureContext, INVARIANTS } from "../invariants";
import {
  canonicalMineProjection,
  type CheckMode,
  type InvariantDevice,
  type InvariantFailure,
  type InvariantWindow,
  type InvariantWorld,
  type StorePatch,
} from "../invariantReads";
import { coverageGaps, NOT_COMPARED } from "../invariantCoverage";
import { formatFailure } from "../report";
import { isConvexId } from "../../../../lib/entityLinks";

// ── Fixture ─────────────────────────────────────────────────────────────────

const ADA = userIdFor("ada");
const BO = userIdFor("bo");
const ACME = teamIdFor("acme");

class FixtureWindow implements InvariantWindow {
  readonly store: SimStore;
  readonly feeds = new Set<string>();
  private readonly mounted: string[] = [];
  readonly outbox = new Map<string, { id: string; action: string; args?: unknown }>();
  private readonly taps = new Set<(patches: readonly StorePatch[], state: unknown) => void>();
  constructor(
    readonly name: string,
    readonly user: { userId: string },
    readonly role: "host" | "follower",
    private readonly backend: SimBackend,
    // Also apply the base list's rows themselves, as useLiveInboxSessions does.
    private readonly listFeeder = false,
  ) {
    this.store = createWindowStore(name);
    // The window's IDB tee: nothing persists, every write goes to the taps.
    (this.store.getState() as any)._setIDBWrite((patches: StorePatch[], state: unknown) => {
      for (const tap of this.taps) tap(patches, state);
    });
  }
  // A registered feed ("agentTasks.webList"), fed on every refeed from now on.
  async mount(feed: string): Promise<void> {
    this.feeds.add(REGISTERED_FEEDS[feed]);
    this.mounted.push(feed);
    await this.run(() => this.refeed());
  }
  onWrite(fn: (patches: readonly StorePatch[], state: unknown) => void): () => void {
    this.taps.add(fn);
    return () => this.taps.delete(fn);
  }
  run<T>(fn: () => T | Promise<T>): Promise<T> {
    return runInWindow(this, fn);
  }
  get client() {
    return this.backend.clientFor({ kind: "user", userId: this.user.userId });
  }
  // The inbox feeders a host mounts: the base list's ids, the liveness
  // overlay, every session either names (by id, as the floor fetches them)
  // and, in team mode, the team list. `only` names the feeds to re-run, as
  // SimWindow.refeed takes them; the fixture's overlay is "liveness".
  async refeed(only?: readonly string[]): Promise<void> {
    if (only) {
      if (only.includes("liveness")) applyMineLivenessPayload(await this.client.query("conversations:sessionsLiveness", {}));
      return;
    }
    const list: any = await this.client.query("conversations:listInboxSessions", LIST_INBOX_SESSIONS_ARGS);
    const sessions: any[] = list?.sessions ?? list ?? [];
    const payload: any = await this.client.query("conversations:sessionsLiveness", {});
    if (this.listFeeder) useInboxStore.getState().syncTable("sessions", sessions);
    const ids = emptyIdsByCollection();
    ids.sessions = [...new Set([...sessions.map((r) => String(r._id)), ...Object.keys(payload?.liveness ?? {})])];
    await applyEntityIds(this.client, ids);
    applyLiveInboxIds(sessions);
    applyMineLivenessPayload(payload);
    for (const feed of this.mounted) applyCollectionFeed(REGISTERED_FEEDS[feed], await this.client.query(feed.replace(".", ":"), {}));
    const ui = useInboxStore.getState().clientState.ui as any;
    if (ui?.inbox_scope === "team" && ui.active_team_id) {
      const team: any = await this.client.query("conversations:listTeamInboxSessions", teamInboxArgs(ui.active_team_id));
      applyTeamInboxIds(team?.sessions ?? [], ui.active_team_id);
    }
  }
}

interface Fixture extends InvariantWorld {
  backend: SimBackend;
  labels: SimLabels;
  devices: InvariantDevice[];
  convs: Record<string, string[]>;
  host(name: string, userId: string, scope?: { team: string }, opts?: { listFeeder?: boolean }): Promise<FixtureWindow>;
  follower(host: FixtureWindow, name: string): Promise<FixtureWindow>;
  insert(table: string, doc: Record<string, unknown>, label: string): Promise<string>;
}

function fixture(seed: number): Fixture {
  uninstallRealm(); // a test may build a second world
  installRealm(seed);
  const tw = genTeamWorld({
    users: ["ada", "bo"],
    teams: [{ name: "acme", members: ["ada", "bo"] }],
    rowsPerUser: 6,
    seed,
    epoch: inboxEpoch(T0),
  });
  const labels = new SimLabels();
  const tables: Record<string, any[]> = {
    users: tw.users,
    teams: tw.teams,
    team_memberships: tw.team_memberships,
    conversations: [],
    managed_sessions: [],
    session_decisions: [],
    session_owners: [],
    agent_tasks: tw.agent_tasks,
  };
  const convs: Record<string, string[]> = {};
  for (const [name, gw] of Object.entries(tw.perUser)) {
    for (const [table, rows] of Object.entries(gw)) tables[table].push(...rows);
    convs[name] = gw.conversations.map((c) => String(c._id));
    convs[name].forEach((id, i) => labels.register(id, `${name}/s${i}`));
  }
  for (const u of ["ada", "bo"]) labels.register(userIdFor(u), u);
  labels.register(ACME, "acme");
  const backend = makeSimBackend({
    tables,
    now,
    rngFor: (seq) => stream(`call:${seq}`),
    mintId: (table, n) => convexIdFor(`${table}:${n}`),
    onInsert: (table, id) => labels.onInsert(table, id),
  });
  const net = new Net({ rng: stream("net"), writes: () => backend.writes(), now, advance });
  attachRealm({ timers: net, serverCall: () => backend.activeCall() });

  const world: Fixture = {
    backend,
    labels,
    devices: [],
    convs,
    async host(name, userId, scope, opts) {
      const w = new FixtureWindow(name, { userId }, "host", backend, opts?.listFeeder);
      const user = await backend.db.get(userId);
      await w.run(async () => {
        const s = useInboxStore.getState();
        useInboxStore.setState({
          currentUser: { ...user },
          clientState: { ...s.clientState, ui: { ...s.clientState.ui, inbox_scope: scope ? "team" : "mine", active_team_id: scope?.team ?? null } },
        } as any);
        await w.refeed();
        await catchUp(w.client);
      });
      world.devices.push({ host: w, followers: [] });
      return w;
    },
    async follower(host, name) {
      const f = new FixtureWindow(name, host.user, "follower", backend);
      // A snapshot join: the host's replicated slice, as the runtime sends it.
      f.store.setState(snapshotEntries(host.store.getState(), REPLICATED_STORE_KEYS) as any);
      (world.devices.find((d) => d.host === host)!.followers as FixtureWindow[]).push(f);
      return f;
    },
    async insert(table, doc, label) {
      const id = await backend.db.insert(table, doc);
      labels.register(id, label);
      return id;
    },
  };
  return world;
}

// A window-state write that is not a store action: the plant.
const plant = (w: FixtureWindow, fn: (s: any) => Record<string, unknown>) =>
  w.run(() => useInboxStore.setState(fn(useInboxStore.getState()) as any));

function report(world: InvariantWorld, f: InvariantFailure): string {
  return formatFailure(
    failureContext(f, { scenario: "invariants-selftest", mode: "scripted", seed: 1, step: "settle", delivery: 0, ring: [], order: [], labels: world.labels, t0: T0 }),
    "(artifacts)",
  );
}

async function clean(world: InvariantWorld, id: string, mode: CheckMode = "settle"): Promise<void> {
  const failures = await checkInvariants(world, { ids: [id], mode });
  expect(failures.map((f) => report(world, f))).toEqual([]);
}

// Asserts the invariant fails, and that the report names it and `label`
// (on the row line when `onRow`, else anywhere in the block).
async function planted(world: InvariantWorld, id: string, label: string, opts: { onRow?: boolean; mode?: CheckMode } = {}): Promise<string> {
  const failures = await checkInvariants(world, { ids: [id], mode: opts.mode });
  expect(failures.length).toBeGreaterThan(0);
  const text = failures.map((f) => report(world, f)).join("\n\n");
  expect(text).toContain(`  ${id}: `);
  expect(text).toContain(opts.onRow === false ? label : `row ${label} (`);
  return text;
}

afterEach(() => uninstallRealm());

// ── The catalog ─────────────────────────────────────────────────────────────

describe("invariants", () => {
  test("the catalog lists every rule of section 3.7, once each", () => {
    // The fixpoint pass last: it re-feeds windows, and its writes must not reach the other checks.
    expect(INVARIANTS.map((i) => i.id)).toEqual([
      "INV-sessions-mine", "INV-followers", "INV-team-inbox", "INV-workspace-rows", "INV-sweep",
      "INV-cursors", "INV-pending-locks", "INV-outbox", "INV-triggers", "INV-pending-sends", "INV-chat",
      "INV-roles", "INV-ping-pong", "INV-row-shape", "INV-fixpoint",
    ]);
    expect(INVARIANTS.filter((i) => i.always).map((i) => i.id)).toEqual(["INV-workspace-rows", "INV-pending-sends", "INV-chat"]);
  });

  test("a clean world of two people and a team passes every invariant", async () => {
    const world = fixture(1);
    const ada = await world.host("ada", ADA);
    await world.follower(ada, "ada-2");
    await world.host("bo", BO, { team: ACME });
    expect((await checkInvariants(world)).map((f) => report(world, f))).toEqual([]);
    expect((await checkInvariants(world, { mode: "always" })).map((f) => report(world, f))).toEqual([]);
  });

  test("INV-fixpoint: a row the server no longer has moves on the refeed", async () => {
    const world = fixture(2);
    const ada = await world.host("ada", ADA);
    await clean(world, "INV-fixpoint");
    const ghost = convexIdFor("task:ghost");
    world.labels.register(ghost, "task:ghost");
    await plant(ada, (s) => ({ tasks: { ...s.tasks, [ghost]: { _id: ghost, title: "ghost", user_id: ADA, workspace: `user:${ADA}` } } }));
    await planted(world, "INV-fixpoint", "task:ghost");
  });

  // The base list and byIds stamp the viewer fields through one helper
  // (stampInboxViewerFields), so a window mounting both never flaps a row.
  test("INV-fixpoint: the base list and byIds write one row the same way", async () => {
    const world = fixture(20);
    await world.host("ada", ADA, undefined, { listFeeder: true });
    await clean(world, "INV-fixpoint");
  });

  // The base lists are measured, not refed ahead: a value cargo or a local
  // write left on a row differently from the list is a write of the pass.
  test("INV-fixpoint: a row value the list writes differently moves on the refeed", async () => {
    const world = fixture(22);
    const ada = await world.host("ada", ADA, undefined, { listFeeder: true });
    await clean(world, "INV-fixpoint");
    const id = Object.keys(ada.store.getState().sessions).find(isConvexId)!;
    await plant(ada, (s) => ({ sessions: { ...s.sessions, [id]: { ...s.sessions[id], title: "written by cargo" } } }));
    expect(await planted(world, "INV-fixpoint", world.labels.label(id))).toContain("replace title");
  });

  // Null and absent are two spellings of an unset field, and the delta merge
  // replaces the row between them.
  test("INV-fixpoint: a field held as null where the list omits it", async () => {
    const world = fixture(23);
    const ada = await world.host("ada", ADA, undefined, { listFeeder: true });
    await clean(world, "INV-fixpoint");
    const state = ada.store.getState() as any;
    const id = Object.keys(state.sessions).find((k) => isConvexId(k) && !("owner_name" in state.sessions[k]))!;
    expect(id).toBeDefined();
    await plant(ada, (s) => ({ sessions: { ...s.sessions, [id]: { ...s.sessions[id], owner_name: null } } }));
    expect(await planted(world, "INV-fixpoint", world.labels.label(id))).toContain("remove owner_name");
  });

  // ct-56050: sync-log cargo once landed every raw conversation column on the
  // row; the next list or byIds push removed it again.
  test("INV-row-shape: a raw conversation field carried onto a sessions row is outside the row", async () => {
    const world = fixture(21);
    const ada = await world.host("ada", ADA);
    await clean(world, "INV-row-shape");
    const id = Object.keys(ada.store.getState().sessions).find(isConvexId)!;
    expect(id).toBeDefined();
    await plant(ada, (s) => ({ sessions: { ...s.sessions, [id]: { ...s.sessions[id], title_gen_scheduled_at: T0, persistent: true } } }));
    const text = await planted(world, "INV-row-shape", world.labels.label(id));
    expect(text).toContain("persistent, title_gen_scheduled_at");
  });

  test("INV-sessions-mine: a replica missing a placed row disagrees with the canonical projection", async () => {
    const world = fixture(3);
    const ada = await world.host("ada", ADA);
    await clean(world, "INV-sessions-mine");
    const { placements } = await canonicalMineProjection(world, ADA);
    const id = [...placements.keys()][0];
    expect(id).toBeDefined();
    await plant(ada, (s) => {
      const { [id]: _gone, ...sessions } = s.sessions;
      return { sessions };
    });
    await planted(world, "INV-sessions-mine", world.labels.label(id));
  });

  test("INV-followers: a follower row that differs from its host's", async () => {
    const world = fixture(4);
    const ada = await world.host("ada", ADA);
    const f = await world.follower(ada, "ada-2");
    await clean(world, "INV-followers");
    const id = world.convs.ada.find((c) => ada.store.getState().sessions[c])!;
    await plant(f, (s) => ({ sessions: { ...s.sessions, [id]: { ...s.sessions[id], title: "edited in the follower only" } } }));
    await planted(world, "INV-followers", world.labels.label(id));
  });

  test("INV-team-inbox: an extra row in teamInboxIds", async () => {
    const world = fixture(5);
    const bo = await world.host("bo", BO, { team: ACME });
    await clean(world, "INV-team-inbox");
    const extra = world.convs.ada[0];
    await bo.run(() => useInboxStore.getState().setTeamInboxIds([...useInboxStore.getState().teamInboxIds, extra], ACME));
    await planted(world, "INV-team-inbox", "ada/s0");
  });

  test("INV-workspace-rows: a task the window keeps after its principal loses the team", async () => {
    const world = fixture(6);
    const task = { short_id: "ct-1", title: "t1", status: "open", user_id: ADA, team_id: ACME, workspace: `team:${ACME}`, created_at: T0, updated_at: T0 };
    const t1 = await world.insert("tasks", task, "task:acme/t1");
    const bo = await world.host("bo", BO, { team: ACME });
    await plant(bo, (s) => ({ tasks: { ...s.tasks, [t1]: { _id: t1, ...task } } }));
    bo.feeds.add("tasks");
    await clean(world, "INV-workspace-rows");
    await clean(world, "INV-workspace-rows", "always");
    // A collection the window feeds must hold every readable row of its workspace.
    const held = bo.store.getState().tasks[t1];
    await plant(bo, (s) => ({ tasks: {} }));
    expect(await planted(world, "INV-workspace-rows", "task:acme/t1")).toContain(`lacks a readable tasks row in its workspace team:acme`);
    await clean(world, "INV-workspace-rows", "always"); // a missing row is no leak
    await plant(bo, () => ({ tasks: { [t1]: held } }));
    await world.backend.db.delete(membershipIdFor("acme", "bo"));
    await planted(world, "INV-workspace-rows", "task:acme/t1");
    await planted(world, "INV-workspace-rows", "task:acme/t1", { mode: "always" });
  });

  test("INV-sweep: a task whose stored workspace disagrees with its computed one", async () => {
    const world = fixture(7);
    const t1 = await world.insert("tasks", { short_id: "ct-1", title: "t1", status: "open", user_id: ADA, team_id: ACME, workspace: `team:${ACME}`, created_at: T0, updated_at: T0 }, "task:acme/t1");
    await clean(world, "INV-sweep");
    await world.backend.db.patch(t1, { workspace: `user:${ADA}` });
    await planted(world, "INV-sweep", "task:acme/t1");
  });

  test("INV-cursors: a stale cursor, and a cursor for a scope the principal does not hold", async () => {
    const world = fixture(8);
    const ada = await world.host("ada", ADA);
    await clean(world, "INV-cursors");
    const meta = (key: string, cursor: number) => (s: any) => ({ syncMeta: { ...s.syncMeta, [syncLogScopeMetaKey(key)]: { cursor } } });
    await plant(ada, meta(`team:${ACME}`, 7));
    expect(await planted(world, "INV-cursors", "scope team:acme: cursor 7", { onRow: false })).toContain("head 0");
    const other = teamIdFor("other");
    world.labels.register(other, "other");
    await plant(ada, meta(`team:${ACME}`, 0));
    await plant(ada, meta(`team:${other}`, 3));
    await planted(world, "INV-cursors", "scope team:other is not held", { onRow: false });
  });

  test("INV-pending-locks: a lock past the settle window, and an acknowledged lock the cursor passed", async () => {
    const world = fixture(9);
    const ada = await world.host("ada", ADA);
    await clean(world, "INV-pending-locks");
    const s0 = world.convs.ada[0];
    await plant(ada, (s) => ({ pending: { ...s.pending, [`sessions:${s0}:is_pinned`]: { type: "field", value: true, ts: now() - HIDDEN_OVERRIDE_SETTLE_MS - 1 } } }));
    expect(await planted(world, "INV-pending-locks", "ada/s0")).toContain("past the 300000ms settle window");
    const s1 = world.convs.ada[1];
    await plant(ada, (s) => ({
      pending: { [`sessions:${s1}:inbox_stashed_at`]: { type: "field", value: T0, ts: now(), ack: [{ s: `user:${ADA}`, p: 0 }] } },
    }));
    expect(await planted(world, "INV-pending-locks", "ada/s1")).toContain("which the cursor has passed");
  });

  test("INV-outbox: an entry left in a window's outbox", async () => {
    const world = fixture(10);
    const ada = await world.host("ada", ADA);
    await clean(world, "INV-outbox");
    ada.outbox.set("ob-1", { id: "ob-1", action: "conversations.kill", args: { conversation_id: world.convs.ada[0] } });
    await planted(world, "INV-outbox", "conversations.kill (ob-1) {\"conversation_id\":\"ada/s0\"}", { onRow: false });
  });

  test("INV-triggers: an armed kind no trigger backs, and a trigger webList does not return", async () => {
    const world = fixture(11);
    const ada = await world.host("ada", ADA);
    await ada.mount("agentTasks.webList");
    await clean(world, "INV-triggers");
    await world.backend.db.patch(world.convs.ada[0], { armed_trigger_kind: "standing" });
    expect(await planted(world, "INV-triggers", "ada/s0")).toContain("armed_trigger_kind is standing, its triggers make it none");
    await world.backend.db.patch(world.convs.ada[0], { armed_trigger_kind: undefined });
    const ghost = convexIdFor("trigger:ghost");
    world.labels.register(ghost, "trigger:ghost");
    await plant(ada, (s) => ({ agentTasks: { ...s.agentTasks, [ghost]: { _id: ghost, user_id: ADA, title: "ghost" } } }));
    await planted(world, "INV-triggers", "trigger:ghost");
  });

  test("INV-pending-sends: a bubble still in flight, and a client_id on two rows", async () => {
    const world = fixture(12);
    const ada = await world.host("ada", ADA);
    await clean(world, "INV-pending-sends");
    const s0 = world.convs.ada[0];
    await plant(ada, (s) => ({
      pendingMessages: { ...s.pendingMessages, [s0]: [{ _id: "optimistic_1", role: "user", content: "hi", timestamp: now(), _isOptimistic: true, _clientId: "cid-1" }] },
    }));
    expect(await planted(world, "INV-pending-sends", "ada/s0")).toContain("send cid-1 is still in flight");
    await plant(ada, () => ({ pendingMessages: {} }));
    const row = { conversation_id: s0, from_user_id: ADA, owner_user_id: ADA, content: "hi", client_id: "cid-dup", status: "pending", created_at: now() };
    await world.insert("pending_messages", row, "send:first");
    await world.insert("pending_messages", row, "send:second");
    await planted(world, "INV-pending-sends", "send:second", { mode: "always" });
  });

  test("INV-chat: a mention that woke its target twice, a sender over the hourly cap, a line the page does not return", async () => {
    const world = fixture(13);
    const ada = await world.host("ada", ADA);
    await clean(world, "INV-chat");
    const s0 = world.convs.ada[0];
    const wake = (i: number, clientId: string) => ({ conversation_id: s0, from_user_id: BO, owner_user_id: ADA, content: `wake ${i}`, client_id: clientId, status: "pending", created_at: now() });
    await world.insert("pending_messages", wake(0, `chat-mention:${convexIdFor("line:1")}:${s0}`), "wake:first");
    await world.insert("pending_messages", wake(1, `chat-mention:${convexIdFor("line:1")}:${s0}`), "wake:again");
    await planted(world, "INV-chat", "wake:again", { mode: "always" });

    const capped = fixture(14);
    await capped.host("ada", ADA);
    const t0 = capped.convs.ada[0];
    for (let i = 0; i <= MENTION_WAKES_PER_SENDER_HOUR; i++) {
      await capped.insert("pending_messages", { conversation_id: t0, from_user_id: BO, owner_user_id: ADA, content: "w", client_id: `chat-mention:${convexIdFor(`line:${i}`)}:${t0}`, status: "pending", created_at: now() }, `wake:${i}`);
    }
    expect(await planted(capped, "INV-chat", "row bo (users)", { onRow: false })).toContain(`over the cap of ${MENTION_WAKES_PER_SENDER_HOUR}`);

    const paged = fixture(15);
    const pa = await paged.host("ada", ADA);
    const line = convexIdFor("chat:ghost");
    paged.labels.register(line, "chat:ghost");
    const channel = await paged.insert("chat_channels", { team_id: ACME, name: "general", kind: "channel", created_by: ADA, created_at: now() }, "#general");
    await plant(pa, (s) => ({ chatMessages: { ...s.chatMessages, [line]: { _id: line, channel_id: channel, team_id: ACME, user_id: ADA, content: "ghost", created_at: now() } } }));
    await planted(paged, "INV-chat", "chat:ghost");
  });

  test("INV-roles: a wake counter ahead of its enqueued rows, and a replica anchor the principal cannot see", async () => {
    const world = fixture(16);
    const ada = await world.host("ada", ADA);
    await clean(world, "INV-roles");
    const role = await world.insert("org_roles", { team_id: ACME, name: "Lead", handle: "lead", short_id: "or-1", status: "active" }, "role:lead");
    await world.insert("chat_agent_quota", { key: `mention_to:${role}`, bucket: hourBucket(now()), count: 2, updated_at: now() }, "quota:lead");
    await world.insert("pending_messages", { conversation_id: world.convs.ada[0], from_user_id: BO, owner_user_id: ADA, content: "w", client_id: `chat-mention:${convexIdFor("line:1")}:${role}`, status: "pending", created_at: now() }, "wake:lead");
    expect(await planted(world, "INV-roles", "role:lead")).toContain("reads 2, 1 wake(s) were enqueued");

    const anchors = fixture(17);
    const aa = await anchors.host("ada", ADA);
    const ghost = convexIdFor("anchor:ghost");
    anchors.labels.register(ghost, "anchor:ghost");
    await plant(aa, (s) => ({ anchors: { ...s.anchors, [ghost]: { _id: ghost, name: "ghost", team_id: ACME } } }));
    await planted(anchors, "INV-roles", "anchor:ghost");
  });

  test("INV-ping-pong: one session woken by agents past the hourly cap", async () => {
    const world = fixture(18);
    await world.host("ada", ADA);
    await clean(world, "INV-ping-pong");
    const target = world.convs.ada[0];
    for (let i = 0; i <= MENTION_WAKES_PER_TARGET_HOUR; i++) {
      await world.insert("pending_messages", {
        conversation_id: target, from_user_id: i % 2 ? BO : ADA, owner_user_id: ADA, from_conversation_id: world.convs.bo[0],
        content: "ping", client_id: `ping:${i}`, status: "pending", created_at: now(),
      }, `ping:${i}`);
    }
    expect(await planted(world, "INV-ping-pong", "ada/s0")).toContain(`agent wakes into one session in hour ${hourBucket(now())}`);
  });

  // A charge key narrower than a real session (here one per line) keeps every
  // sender under its cap; the person's ceiling, read from ownership, catches it.
  test("INV-ping-pong: one person's relayed replies past their ceiling", async () => {
    const world = fixture(23);
    await world.host("ada", ADA);
    await clean(world, "INV-ping-pong");
    const ceiling = MENTION_WAKES_PER_SENDER_HOUR * (1 + world.convs.ada.length);
    for (let i = 0; i <= ceiling; i++) {
      const line = await world.insert("chat_messages", { origin: "agent", origin_session_id: `line-${i}`, content: "pong", created_at: now() }, `line:${i}`);
      await world.insert("pending_messages", {
        conversation_id: world.convs.bo[i % world.convs.bo.length], from_user_id: ADA, owner_user_id: BO,
        content: "pong", client_id: chatRelayClientId(line), status: "pending", created_at: now(),
      }, `relay:${i}`);
    }
    const text = await planted(world, "INV-ping-pong", "ada");
    expect(text).toContain(`${ceiling + 1} agent wakes from one person in hour ${hourBucket(now())} ada, over their ceiling of ${ceiling}`);
    expect(text).not.toContain("from one sender");
  });

  // The real world (sim/world.ts genesis, sim/window.ts windows and their
  // feeders), settled: what every scenario starts from.
  async function settledWorld(): Promise<SimWorld> {
    uninstallRealm();
    installRealm(21);
    const w = new SimWorld({ seed: 21, rowsPerUser: 4 });
    w.team("acme", { features: { chat: true, org: true } });
    w.user("ada", ["acme"]).user("bo", ["acme"]);
    w.session("ada", "s", { agentStatus: "working" });
    w.task("acme/t1", { owner: "ada", session: "ada/s" });
    w.trigger("ada/tr1", { owner: "ada", session: "ada/s" });
    await w.device("ada", { followers: 1 });
    await w.device("bo", { scope: { team: "acme" } });
    await w.settle();
    return w;
  }
  const allBut = (id: string) => INVARIANTS.map((i) => i.id).filter((x) => x !== id);

  test("a settled SimWorld passes every invariant but the fixpoint pass", async () => {
    const world: InvariantWorld = await settledWorld(); // SimWorld is the view, structurally
    expect((await checkInvariants(world, { ids: allBut("INV-fixpoint") })).map((f) => report(world, f))).toEqual([]);
    expect((await checkInvariants(world, { mode: "always" })).map((f) => report(world, f))).toEqual([]);
  }, 120_000);

  test("a settled SimWorld passes the fixpoint pass", async () => {
    await clean(await settledWorld(), "INV-fixpoint");
  }, 120_000);

  test("always mode runs only the always rules, over the windows given", async () => {
    const world = fixture(19);
    const ada = await world.host("ada", ADA);
    const bo = await world.host("bo", BO, { team: ACME });
    const ghost = convexIdFor("task:ghost");
    world.labels.register(ghost, "task:ghost");
    for (const w of [ada, bo]) await plant(w, (s) => ({ tasks: { ...s.tasks, [ghost]: { _id: ghost, title: "ghost", user_id: ADA } } }));
    const failures = await checkInvariants(world, { mode: "always", windows: [bo] });
    expect(failures.map((f) => [f.invariant.id, f.window?.name])).toEqual([["INV-workspace-rows", "bo"]]);
    expect(report(world, failures[0])).toContain("window bo (principal bo, scope team:acme)");
  });
});

// ── Coverage guard ──────────────────────────────────────────────────────────

describe("invariant coverage", () => {
  test("every classified store key is compared by an invariant or excused with a reason", () => {
    expect(coverageGaps()).toEqual([]);
    for (const reason of Object.values(NOT_COMPARED)) expect(reason.length).toBeGreaterThan(10);
  });

  test("a new key nobody classified for comparison fails with the line to add", () => {
    expect(coverageGaps({ ...REPLICATION_CLASSIFICATION, simFakeKey: "shared" })).toEqual([
      'store key "simFakeKey" (shared) is compared by no invariant and is not in NOT_COMPARED. Add it to an invariant\'s keys in sim/invariants.ts, or to NOT_COMPARED with the reason it is not compared.',
    ]);
  });

  test("a NOT_COMPARED entry for a key that is gone, or now compared, fails", () => {
    expect(coverageGaps(REPLICATION_CLASSIFICATION, { ...NOT_COMPARED, goneKey: "was here once", tasks: "compared after all" })).toEqual([
      'NOT_COMPARED names "goneKey", which REPLICATION_CLASSIFICATION no longer has. Remove it.',
      'NOT_COMPARED names "tasks", which an invariant compares. Remove it from NOT_COMPARED.',
    ]);
  });
});
