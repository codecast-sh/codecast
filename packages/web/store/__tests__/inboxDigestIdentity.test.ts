import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import {
  computeInboxSessions,
  computeSessionsLiveness,
  collectInboxSessionsByIds,
} from "@codecast/convex/convex/conversations";
import { makeFakeDb } from "@codecast/convex/convex/testDb";
import { INBOX_PROJECTION_VERSION, inboxEpoch } from "@codecast/shared/contracts";
import {
  useInboxStore,
  placeInboxRows,
  projectReplicaInbox,
  __resetInboxPlacementCacheForTests,
  type InboxSession,
} from "../inboxStore";
import { evaluateInboxCompare, type InboxCompareState } from "../inboxDigestCompare";
import { __resetSyncActivityForTests } from "../syncActivity";
import { syncMetaKey } from "../../hooks/reconcileCrawl";
import { inboxCrawlWsKey } from "../../hooks/useSyncInboxSessions";
import { LIST_INBOX_SESSIONS_ARGS } from "../../hooks/useLiveInboxSessions";

// CROSS-PLATFORM DIGEST IDENTITY (sync-convergence, the three identities).
//
// The SERVER side is the real Convex code (computeInboxSessions for the base
// list, computeSessionsLiveness for the overlay, collectInboxSessionsByIds for
// the heal) over an in-memory db. The CLIENT side is the real web store: the
// base list lands through syncTable, the overlay through the one applier, and
// the replica's projection comes out of projectReplicaInbox / placeInboxRows
// — the exact path web, desktop and mobile share. The two digests must agree
// byte for byte at the payload's epoch, per row and in the tally, across
// every placement rule the fixture exercises.

const MIN = 60_000;
const H = 60 * MIN;
const DAY = 24 * H;
// Twenty-five seconds into a minute so the epoch and the execution clock differ.
const NOW = 1_800_000_000_000 + 25_000;
const EPOCH = inboxEpoch(NOW);
const ME = "u".repeat(32);
const CRAWL_KEY = syncMetaKey("sessions", inboxCrawlWsKey(ME));

const cid = (tag: string) => (tag.toLowerCase().replace(/[^a-z0-9]/g, "") + "0".repeat(32)).slice(0, 32);

function conv(tag: string, overrides: Record<string, any> = {}) {
  return {
    _id: cid(tag),
    user_id: ME,
    status: "active",
    updated_at: EPOCH - 2 * H,
    started_at: EPOCH - 3 * H,
    message_count: 4,
    last_message_role: "assistant",
    title: `Session ${tag}`,
    ...overrides,
  };
}

function managed(tag: string, agent_status: string, over: Record<string, any> = {}) {
  return {
    _id: `ms_${tag}`,
    user_id: ME,
    conversation_id: cid(tag),
    last_heartbeat: EPOCH - 1_000,
    agent_status,
    agent_status_updated_at: EPOCH - 5 * MIN,
    ...over,
  };
}

// One fixture, every rule: working, idle (needs input), pinned, dismissed,
// stashed, the fold (edge + folded), a hidden anchor, done, a blank, an asking
// parent (child permission prompt), a standing trigger home (dormant), a
// pending `cast decide` (questions).
function fixture() {
  return makeFakeDb({
    users: [{ _id: ME, name: "Me", email: "me@example.com" }],
    session_owners: [],
    conversations: [
      conv("working", { updated_at: EPOCH - MIN }),
      conv("idle", { updated_at: EPOCH - 10 * MIN }),
      conv("pinned", { inbox_pinned_at: EPOCH - H, updated_at: EPOCH - 5 * H }),
      conv("dismissed", { inbox_dismissed_at: EPOCH - H }),
      conv("stashed", { inbox_stashed_at: EPOCH - H }),
      conv("edge", { updated_at: EPOCH - 15 * H }),
      conv("folded", { updated_at: EPOCH - 16 * H }),
      conv("anchor", { anchor_id: "anchors_1" }),
      conv("done", { thread_state_status: "done" }),
      conv("blank", { message_count: 0, last_message_role: undefined }),
      conv("parent", { updated_at: EPOCH - MIN }),
      conv("child", { is_subagent: true, parent_conversation_id: cid("parent"), updated_at: EPOCH - MIN }),
      conv("standing", { armed_trigger_kind: "standing" }),
      conv("decide"),
      conv("ancient", { updated_at: EPOCH - 40 * DAY }), // outside every window
    ],
    managed_sessions: [
      managed("working", "working"),
      managed("child", "permission_blocked"),
    ],
    messages: [],
    session_decisions: [
      { _id: "sd_1", user_id: ME, conversation_id: cid("decide"), status: "pending", created_at: EPOCH - MIN },
    ],
  });
}

let nowSpy: ReturnType<typeof spyOn>;
beforeEach(() => {
  nowSpy = spyOn(Date, "now").mockReturnValue(NOW);
  __resetSyncActivityForTests();
  __resetInboxPlacementCacheForTests();
  useInboxStore.setState({
    sessions: {},
    sessionsProjection: {},
    pending: {},
    pendingMessages: {},
    pendingSessionCreates: {},
    sessionsWithQueuedMessages: new Set(),
    blockedReviveRequestedAt: {},
    currentSessionId: null,
    sessionDecisions: {},
    questionResolutions: {},
    currentUser: { _id: ME },
    clientState: { ui: { inbox_scope: "mine", inbox_show_old: false } },
    syncMeta: { [CRAWL_KEY]: { backfilledAt: NOW - DAY } },
    syncProgress: {},
  } as any);
});
afterEach(() => nowSpy.mockRestore());

const MONO = 1_000_000;
const ctx = { now: NOW, nowMono: MONO + 1_000, crawlMetaKey: CRAWL_KEY, lastApplyMono: MONO - 10 * MIN, inflight: 0 };

function replica(): InboxCompareState {
  return useInboxStore.getState() as unknown as InboxCompareState;
}

async function feedServer(db: any) {
  const ctxDb = { db };
  // The live window, exactly as the subscription requests it.
  const base = await computeInboxSessions(ctxDb, ME as any, {
    show_all: LIST_INBOX_SESSIONS_ARGS.show_all,
    includeLiveness: LIST_INBOX_SESSIONS_ARGS.include_liveness,
    fastFieldsInOverlay: LIST_INBOX_SESSIONS_ARGS.fast_fields_in_overlay,
  });
  const overlay = await computeSessionsLiveness(ctxDb, ME as any);
  const store = useInboxStore.getState();
  store.syncTable("sessions", base.sessions as unknown as InboxSession[]);
  store.syncTable("sessionDecisions", db._tables.session_decisions);
  store.applyInboxLivenessPayload("mine", overlay);
  // Receipt clock is the harness's, not performance.now().
  useInboxStore.setState((s: any) => ({
    sessionsProjection: { ...s.sessionsProjection, mine: { ...s.sessionsProjection.mine, receivedAtMono: MONO } },
  }));
  return { base, overlay };
}

describe("server projection == replica projection", () => {
  it("the base list omits fold rows; the replica reports them missing, heals by id, then agrees byte for byte", async () => {
    const db = fixture();
    const { base, overlay } = await feedServer(db);
    expect(overlay.projection.v).toBe(INBOX_PROJECTION_VERSION);
    expect(overlay.projection.epoch).toBe(EPOCH);
    expect(overlay.projection.set_digest).toMatch(/^[0-9a-f]{16}$/);
    // Transport omission (C4): the folded row is stamped but not in the base list.
    expect(base.sessions.map((s: any) => s._id)).not.toContain(cid("folded"));
    expect(overlay.liveness[cid("folded")]?.below_fold).toBe(true);

    // The cold-replica shape of the diff: exactly the fold rows are missing,
    // nothing else disagrees.
    const first = evaluateInboxCompare(replica(), ctx);
    expect(first.kind).toBe("diff");
    if (first.kind !== "diff") return;
    expect(first.diff.missing).toEqual([cid("folded")]);
    expect(first.diff.extra).toEqual([]);
    expect(first.diff.bucket_deltas).toEqual([]);
    expect(first.diff.fold_deltas).toEqual([]);

    // The heal: hydrate exactly the missing ids through the byIds channel,
    // then the overlay lands its facts on the now-present row.
    const healed = await collectInboxSessionsByIds({ db }, ME as any, first.diff.missing);
    useInboxStore.getState().syncTable("sessions", healed.sessions as unknown as InboxSession[]);
    useInboxStore.getState().applyInboxLivenessPayload("mine", overlay);
    useInboxStore.setState((s: any) => ({
      sessionsProjection: { ...s.sessionsProjection, mine: { ...s.sessionsProjection.mine, receivedAtMono: MONO } },
    }));

    const after = evaluateInboxCompare(replica(), ctx);
    expect(after).toMatchObject({ kind: "clean", short_circuit: true, epoch: EPOCH });

    // Per row: the replica's placement equals the server's stamp for every
    // stamped member, and the tallies agree.
    const { proj } = projectReplicaInbox(replica(), { scope: "mine", focusedId: null, epoch: EPOCH, now: NOW });
    expect(proj.set_digest).toBe(overlay.projection.set_digest!);
    const stamped = Object.entries(overlay.liveness).filter(([, r]) => r.bucket !== undefined);
    expect(stamped.length).toBeGreaterThanOrEqual(13);
    for (const [id, stamp] of stamped) {
      const local = proj.placements.get(id);
      expect({ id, bucket: local?.bucket, below_fold: local?.below_fold }).toEqual({ id, bucket: stamp.bucket, below_fold: stamp.below_fold });
    }
    expect(proj.placements.size).toBe(stamped.length);
    expect(proj.tally).toEqual(overlay.projection.tally);
    // The rules the fixture exercises, by name, on BOTH sides.
    const b = (tag: string) => overlay.liveness[cid(tag)].bucket;
    expect(b("working")).toBe("working");
    expect(b("idle")).toBe("needs_input");
    expect(b("pinned")).toBe("pinned");
    expect(b("dismissed")).toBe("dismissed");
    expect(b("stashed")).toBe("stashed");
    expect(b("anchor")).toBe("hidden");
    expect(b("done")).toBe("done");
    expect(b("blank")).toBe("new");
    expect(b("parent")).toBe("questions");
    expect(b("standing")).toBe("dormant");
    expect(b("decide")).toBe("questions");
    expect(overlay.liveness[cid("ancient")]).toBeUndefined();

    // The chokepoint memo (what every surface renders from) digests to the
    // same value at the same epoch — the render path IS the compared path.
    const placed = placeInboxRows(replica(), { scope: "mine", now: NOW });
    expect(placed.epoch).toBe(EPOCH);
    expect(placed.set_digest).toBe(overlay.projection.set_digest!);
    expect(placed.tally).toEqual(overlay.projection.tally);
  });

  it("show old on both sides changes nothing about the digest (shown + folded is the headline, not the set)", async () => {
    const db = fixture();
    const { overlay } = await feedServer(db);
    const healed = await collectInboxSessionsByIds({ db }, ME as any, [cid("folded")]);
    useInboxStore.getState().syncTable("sessions", healed.sessions as unknown as InboxSession[]);
    useInboxStore.getState().applyInboxLivenessPayload("mine", overlay);
    useInboxStore.setState((s: any) => ({
      clientState: { ui: { inbox_scope: "mine", inbox_show_old: true } },
      sessionsProjection: { ...s.sessionsProjection, mine: { ...s.sessionsProjection.mine, receivedAtMono: MONO } },
    }));
    expect(evaluateInboxCompare(replica(), ctx)).toMatchObject({ kind: "clean", short_circuit: true });
    const placed = placeInboxRows(replica(), { scope: "mine", now: NOW });
    expect(placed.set_digest).toBe(overlay.projection.set_digest!);
    // The fold still counts (it is membership data), and show-old renders it.
    expect(placed.oldCount).toBe(1);
    expect(placed.visibleSessions[cid("folded")]).toBeDefined();
  });

  it("a fact the overlay changes moves the replica's placement with it — stamps and facts from one payload always agree", async () => {
    const db = fixture();
    const { overlay } = await feedServer(db);
    const healed = await collectInboxSessionsByIds({ db }, ME as any, [cid("folded")]);
    useInboxStore.getState().syncTable("sessions", healed.sessions as unknown as InboxSession[]);
    useInboxStore.getState().applyInboxLivenessPayload("mine", overlay);
    // The working agent goes idle server-side: a NEW overlay execution.
    db._tables.managed_sessions[0].agent_status = "idle";
    db._tables.managed_sessions[0].agent_status_updated_at = EPOCH - 30_000;
    const next = await computeSessionsLiveness({ db }, ME as any);
    expect(next.liveness[cid("working")].bucket).toBe("needs_input");
    expect(next.projection.set_digest).not.toBe(overlay.projection.set_digest);
    useInboxStore.getState().applyInboxLivenessPayload("mine", next);
    useInboxStore.setState((s: any) => ({
      sessionsProjection: { ...s.sessionsProjection, mine: { ...s.sessionsProjection.mine, receivedAtMono: MONO } },
    }));
    expect(evaluateInboxCompare(replica(), ctx)).toMatchObject({ kind: "clean", short_circuit: true });
    const { proj } = projectReplicaInbox(replica(), { scope: "mine", focusedId: null, epoch: EPOCH, now: NOW });
    expect(proj.placements.get(cid("working"))?.bucket).toBe("needs_input");
    expect(proj.set_digest).toBe(next.projection.set_digest!);
  });
});
