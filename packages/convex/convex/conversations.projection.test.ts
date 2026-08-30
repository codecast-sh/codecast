import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  computeInboxSessions,
  computeSessionsLiveness,
  collectInboxSessionsByIds,
  collectInboxSessionsPaginated,
  tallyInboxRows,
  INBOX_PROJECTION_FIELDS,
} from "./conversations";
import { INBOX_PINNED_CAP } from "./inboxProjection";
import {
  AGENT_IDLE_GRACE_MS,
  STATUS_TRUST_TTL_MS,
  HEARTBEAT_ALIVE_MS,
} from "./inboxFilters";
import { digestProjection, inboxEpoch, type InboxBucket } from "@codecast/shared/contracts";
import { makeFakeDb } from "./testDb";

// The server half of sync-convergence (docs/architecture/sync-convergence.md):
// the liveness overlay stamps one deterministic projection per execution —
// bucket, work_state, asking, below_fold, the time flip — plus a tally and a
// digest; the base list, the crawl and the byIds fetch never carry any of it.

const ME = "users_me";
const MIN = 60 * 1000;
const H = 60 * MIN;
// Twenty-five seconds into a minute, so the epoch (the placement clock) and
// as_of (the execution clock) differ and the tests can tell them apart.
const NOW = 1_800_000_000_000 + 25_000;
const EPOCH = inboxEpoch(NOW);

const LIVENESS_FIELDS = ["agent_status", "is_idle", "awaiting_input"];

function conv(id: string, overrides: Record<string, any> = {}) {
  return {
    _id: `conversations_${id}`,
    user_id: ME,
    status: "active",
    updated_at: EPOCH - 2 * H,
    started_at: EPOCH - 3 * H,
    message_count: 4,
    last_message_role: "assistant",
    title: `Session ${id}`,
    ...overrides,
  };
}

function db(tables: Record<string, any[]>) {
  return makeFakeDb({
    users: [{ _id: ME, name: "Me", email: "me@example.com" }],
    session_owners: [],
    managed_sessions: [],
    messages: [],
    session_decisions: [],
    ...tables,
  });
}

// Every db read, by table (plus the index name for queries): what an execution costs.
function countingCtx(fake: any) {
  const ops: string[] = [];
  const origQuery = fake.query.bind(fake);
  const origGet = fake.get.bind(fake);
  fake.query = (table: string) => {
    const b = origQuery(table);
    const origWithIndex = b.withIndex.bind(b);
    b.withIndex = (name: string, fn?: any) => { ops.push(`${table}.${name}`); return origWithIndex(name, fn); };
    return b;
  };
  fake.get = (id: any) => { ops.push("get"); return origGet(id); };
  return { ctx: { db: fake }, ops };
}

let nowSpy: ReturnType<typeof spyOn>;
beforeEach(() => { nowSpy = spyOn(Date, "now").mockReturnValue(NOW); });
afterEach(() => { nowSpy.mockRestore(); delete process.env.INBOX_DIGEST_DISABLED; });

describe("overlay projection — determinism", () => {
  test("two executions inside one minute over the same data are identical, and stamped with the epoch", async () => {
    const tables = {
      conversations: [
        conv("a", { updated_at: EPOCH - 10 * MIN }),
        conv("b", { inbox_pinned_at: EPOCH - H, updated_at: EPOCH - 5 * H }),
        conv("c", { inbox_dismissed_at: EPOCH - H }),
      ],
      managed_sessions: [
        { _id: "managed_sessions_a", user_id: ME, conversation_id: "conversations_a", last_heartbeat: EPOCH - 5_000, agent_status: "working", agent_status_updated_at: EPOCH - 12 * MIN },
      ],
    };
    const first = await computeSessionsLiveness({ db: db(tables) }, ME as any);
    nowSpy.mockReturnValue(NOW + 20_000); // still the same minute
    const second = await computeSessionsLiveness({ db: db(tables) }, ME as any);
    expect(second.liveness).toEqual(first.liveness);
    expect(second.projection.tally).toEqual(first.projection.tally);
    expect(second.projection.set_digest).toBe(first.projection.set_digest);
    expect(first.projection.epoch).toBe(EPOCH);
    expect(first.projection.as_of).toBe(NOW);
    expect(second.projection.as_of).toBe(NOW + 20_000);
    expect(first.projection).toMatchObject({ v: 1, user_id: ME, scope: "mine", team_id: null, truncated: [] });
  });

  test("the digest is the shared algorithm over every (id, bucket) pair, hidden included; the kill switch nulls it", async () => {
    const tables = {
      conversations: [conv("a"), conv("anchor", { anchor_id: "anchors_1" }), conv("d", { inbox_dismissed_at: EPOCH - H })],
    };
    const { liveness, projection } = await computeSessionsLiveness({ db: db(tables) }, ME as any);
    const pairs = Object.entries(liveness).map(([id, row]) => [id, row.bucket] as [string, string]);
    expect(pairs.map(([, b]) => b).sort()).toEqual(["dismissed", "hidden", "needs_input"]);
    expect(projection.set_digest).toBe(digestProjection(pairs));
    expect(projection.set_digest).toMatch(/^[0-9a-f]{16}$/);
    // The tallies exclude hidden; the digest does not.
    expect(projection.tally.shown.hidden).toBe(0);
    expect(projection.tally.shown.needs_input).toBe(1);
    expect(projection.tally.shown.dismissed).toBe(1);

    process.env.INBOX_DIGEST_DISABLED = "1";
    const off = await computeSessionsLiveness({ db: db(tables) }, ME as any);
    expect(off.projection.set_digest).toBeNull();
    expect(off.liveness).toEqual(liveness);
  });
});

describe("overlay projection — placement rules", () => {
  test("pending API error, pin, anchor, blank row", async () => {
    const tables = {
      conversations: [
        conv("err", { pending_api_error: true }),
        conv("pin", { inbox_pinned_at: EPOCH - H }),
        conv("anchor", { anchor_id: "anchors_1" }),
        conv("anchor_blocked", { anchor_id: "anchors_2", pending_api_error: true }),
        conv("blank", { message_count: 0, last_message_role: undefined }),
        conv("done", { thread_state_status: "done" }),
      ],
    };
    const { liveness } = await computeSessionsLiveness({ db: db(tables) }, ME as any);
    const b = (id: string) => liveness[`conversations_${id}`].bucket;
    expect(b("err")).toBe("needs_input");
    expect(liveness.conversations_err.work_state).toBe("needs_input");
    expect(b("pin")).toBe("pinned");
    expect(liveness.conversations_pin.work_state).toBe("needs_input"); // verdict stamped under the pin
    expect(b("anchor")).toBe("hidden");
    expect(b("anchor_blocked")).toBe("needs_input");
    expect(b("blank")).toBe("new");
    expect(b("done")).toBe("done");
  });

  test("asking: own permission prompt, a pending cast decide, a child's permission prompt, a child's open AskUserQuestion", async () => {
    const tables = {
      conversations: [
        conv("own", { updated_at: EPOCH - MIN }),
        conv("decide"),
        conv("parent_perm", { updated_at: EPOCH - MIN }),
        conv("child_perm", { is_subagent: true, parent_conversation_id: "conversations_parent_perm", updated_at: EPOCH - MIN }),
        conv("parent_auq", { updated_at: EPOCH - MIN }),
        conv("child_auq", { is_subagent: true, parent_conversation_id: "conversations_parent_auq", updated_at: EPOCH - MIN }),
        conv("parent_quiet"),
        conv("child_quiet", { is_subagent: true, parent_conversation_id: "conversations_parent_quiet", updated_at: EPOCH - 20 * MIN }),
      ],
      managed_sessions: [
        { _id: "ms_own", user_id: ME, conversation_id: "conversations_own", last_heartbeat: EPOCH - 1000, agent_status: "permission_blocked", agent_status_updated_at: EPOCH - MIN },
        { _id: "ms_child_perm", user_id: ME, conversation_id: "conversations_child_perm", last_heartbeat: EPOCH - 1000, agent_status: "permission_blocked", agent_status_updated_at: EPOCH - MIN },
        { _id: "ms_child_auq", user_id: ME, conversation_id: "conversations_child_auq", last_heartbeat: EPOCH - 1000, agent_status: "working", agent_status_updated_at: EPOCH - MIN },
        { _id: "ms_child_quiet", user_id: ME, conversation_id: "conversations_child_quiet", last_heartbeat: EPOCH - 1000, agent_status: "idle", agent_status_updated_at: EPOCH - 20 * MIN },
      ],
      messages: [
        { _id: "messages_auq", conversation_id: "conversations_child_auq", role: "assistant", timestamp: EPOCH - MIN, tool_calls: [{ name: "AskUserQuestion" }] },
      ],
      session_decisions: [
        { _id: "session_decisions_1", user_id: ME, conversation_id: "conversations_decide", status: "pending" },
        { _id: "session_decisions_2", user_id: ME, conversation_id: "conversations_parent_quiet", status: "answered" },
      ],
    };
    const { liveness } = await computeSessionsLiveness({ db: db(tables) }, ME as any);
    expect(liveness.conversations_own).toMatchObject({ asking: true, bucket: "questions" });
    expect(liveness.conversations_decide).toMatchObject({ asking: true, bucket: "questions" });
    expect(liveness.conversations_parent_perm).toMatchObject({ asking: true, bucket: "questions" });
    expect(liveness.conversations_parent_auq).toMatchObject({ asking: true, bucket: "questions" });
    expect(liveness.conversations_parent_quiet).toMatchObject({ asking: false });
    // Children are never projection members.
    expect(Object.keys(liveness)).not.toContain("conversations_child_perm");
    expect(Object.keys(liveness)).not.toContain("conversations_child_auq");
  });

  test("armed_trigger_kind on the row drives dormancy with no agent_tasks read", async () => {
    const tables = {
      conversations: [
        conv("standing", { armed_trigger_kind: "standing" }),
        conv("once_done", { armed_trigger_kind: "once", thread_state_status: "done" }),
        conv("once_open", { armed_trigger_kind: "once" }),
        conv("human_last", { armed_trigger_kind: "standing", last_message_preview: "hey, what happened?" }),
      ],
    };
    const { ctx, ops } = countingCtx(db(tables));
    const { liveness } = await computeSessionsLiveness(ctx, ME as any);
    expect(liveness.conversations_standing.bucket).toBe("dormant");
    expect(liveness.conversations_once_done.bucket).toBe("dormant");
    expect(liveness.conversations_once_open.bucket).toBe("needs_input");
    expect(liveness.conversations_human_last.bucket).toBe("needs_input");
    expect(ops.some((o) => o.startsWith("agent_tasks"))).toBe(false);
  });
});

describe("overlay projection — the fold", () => {
  const foldTables = () => ({
    conversations: [
      conv("fresh", { updated_at: EPOCH - H }),
      conv("fresh2", { updated_at: EPOCH - 2 * H }),
      // A 13h gap: the row AT the gap is the cut (never folded itself);
      // everything strictly below it is under the cut.
      conv("edge", { updated_at: EPOCH - 15 * H }),
      conv("old", { updated_at: EPOCH - 16 * H }),
      conv("old_pinned", { updated_at: EPOCH - 17 * H, inbox_pinned_at: EPOCH - 17 * H }),
      conv("old_pending", { updated_at: EPOCH - 18 * H, has_pending_messages: true }),
    ],
  });

  test("fold rows stay projection members with below_fold, and shown + folded is the whole set", async () => {
    const { liveness, projection } = await computeSessionsLiveness({ db: db(foldTables()) }, ME as any);
    expect(liveness.conversations_old.below_fold).toBe(true);
    expect(liveness.conversations_edge.below_fold).toBe(false);
    expect(liveness.conversations_fresh.below_fold).toBe(false);
    expect(liveness.conversations_old_pinned.below_fold).toBe(false); // pinned rows never fold
    expect(liveness.conversations_old_pending.below_fold).toBe(false); // queued work never folds
    const total = (t: Record<InboxBucket, number>) => Object.values(t).reduce((a, b) => a + b, 0);
    expect(total(projection.tally.shown) + total(projection.tally.folded)).toBe(Object.keys(liveness).length);
    expect(total(projection.tally.folded)).toBe(1);
    expect(projection.tally.folded.needs_input).toBe(1);
  });

  test("the base list keeps omitting fold rows unless show_all, and hidden_count is the fold count", async () => {
    const dflt = await computeInboxSessions({ db: db(foldTables()) }, ME as any, { show_all: false, includeLiveness: false });
    expect(dflt.sessions.map((s: any) => s._id)).not.toContain("conversations_old");
    expect(dflt.hidden_count).toBe(1);
    const all = await computeInboxSessions({ db: db(foldTables()) }, ME as any, { show_all: true, includeLiveness: false });
    expect(all.sessions.map((s: any) => s._id)).toContain("conversations_old");
    expect(all.hidden_count).toBe(1);
  });
});

describe("overlay projection — the time flip", () => {
  test("heartbeat window: a working row whose daemon stops heartbeating reads dead at heartbeat + window", async () => {
    const updatedAt = EPOCH - 30 * MIN;
    const heartbeat = EPOCH - 1000;
    const tables = {
      conversations: [conv("w", { updated_at: updatedAt })],
      managed_sessions: [
        { _id: "ms_w", user_id: ME, conversation_id: "conversations_w", last_heartbeat: heartbeat, agent_status: "working", agent_status_updated_at: updatedAt },
      ],
    };
    const { liveness } = await computeSessionsLiveness({ db: db(tables) }, ME as any);
    expect(liveness.conversations_w.bucket).toBe("working");
    // The heartbeat lapses before the trust TTL: the frozen status reads stopped, dead with output.
    expect(liveness.conversations_w.bucket_stale_at).toBe(heartbeat + HEARTBEAT_ALIVE_MS);
    expect(liveness.conversations_w.stale_bucket).toBe("needs_input");
  });

  test("trust TTL: a frozen working status on a live daemon decays to idle at updated_at + TTL", async () => {
    // Quiet for 59.5 minutes: the TTL lands 30s after the epoch, ahead of the heartbeat window.
    const updatedAt = EPOCH - STATUS_TRUST_TTL_MS + 30_000;
    const tables = {
      conversations: [conv("w", { updated_at: updatedAt })],
      managed_sessions: [
        { _id: "ms_w", user_id: ME, conversation_id: "conversations_w", last_heartbeat: EPOCH - 1000, agent_status: "working", agent_status_updated_at: updatedAt },
      ],
    };
    const { liveness } = await computeSessionsLiveness({ db: db(tables) }, ME as any);
    expect(liveness.conversations_w.bucket).toBe("working");
    expect(liveness.conversations_w.bucket_stale_at).toBe(updatedAt + STATUS_TRUST_TTL_MS);
    expect(liveness.conversations_w.stale_bucket).toBe("needs_input");
  });

  test("idle grace: a just-finished statusless row settles at updated_at + grace", async () => {
    const updatedAt = EPOCH - 10_000;
    const tables = {
      conversations: [conv("g", { updated_at: updatedAt })],
      managed_sessions: [
        // A live daemon with no status on this conversation: the recency gate rules.
        { _id: "ms_other", user_id: ME, conversation_id: "conversations_elsewhere", last_heartbeat: EPOCH - 1000 },
      ],
    };
    const { liveness } = await computeSessionsLiveness({ db: db(tables) }, ME as any);
    expect(liveness.conversations_g.bucket).toBe("working");
    expect(liveness.conversations_g.bucket_stale_at).toBe(updatedAt + AGENT_IDLE_GRACE_MS);
    expect(liveness.conversations_g.stale_bucket).toBe("needs_input");
  });

  test("child term: a live producing subagent keeps the parent working until the child's own term lapses", async () => {
    // The child is quiet past its producing grace and kept alive only by its
    // live active status, so the parent's first flip is the child's heartbeat.
    const childAt = EPOCH - 10 * MIN;
    const childHeartbeat = EPOCH - 1000;
    const tables = {
      conversations: [
        conv("p", { updated_at: EPOCH - 3 * H }),
        conv("c", { is_subagent: true, parent_conversation_id: "conversations_p", updated_at: childAt }),
      ],
      managed_sessions: [
        { _id: "ms_c", user_id: ME, conversation_id: "conversations_c", last_heartbeat: childHeartbeat, agent_status: "working", agent_status_updated_at: childAt },
      ],
    };
    const { liveness } = await computeSessionsLiveness({ db: db(tables) }, ME as any);
    expect(liveness.conversations_p.bucket).toBe("working");
    expect(liveness.conversations_p.bucket_stale_at).toBe(childHeartbeat + HEARTBEAT_ALIVE_MS);
    expect(liveness.conversations_p.stale_bucket).toBe("needs_input");
  });

  test("a settled row with no term left to flip carries null stamps", async () => {
    const { liveness } = await computeSessionsLiveness({ db: db({ conversations: [conv("s")] }) }, ME as any);
    expect(liveness.conversations_s.bucket).toBe("needs_input");
    expect(liveness.conversations_s.bucket_stale_at).toBeNull();
    expect(liveness.conversations_s.stale_bucket).toBeNull();
  });
});

describe("overlay projection — truncation flags", () => {
  test("recent, dismissed, stashed and owned name themselves at cap + 1", async () => {
    const many = (prefix: string, extra: (i: number) => Record<string, any>) =>
      Array.from({ length: 201 }, (_, i) => conv(`${prefix}${i}`, { updated_at: EPOCH - H - i * 1000, ...extra(i) }));
    const tables = {
      conversations: [
        ...many("r", () => ({})),
        ...many("d", (i) => ({ inbox_dismissed_at: EPOCH - H - i * 1000 })),
        ...many("s", (i) => ({ inbox_stashed_at: EPOCH - H - i * 1000 })),
      ],
      session_owners: Array.from({ length: 201 }, (_, i) => ({ _id: `session_owners_${i}`, user_id: ME, conversation_id: `conversations_r${i}`, added_by: ME, added_at: EPOCH - H })),
    };
    const { projection } = await computeSessionsLiveness({ db: db(tables) }, ME as any);
    expect(projection.truncated).toEqual(["recent", "dismissed", "stashed", "owned"]);
    const base = await computeInboxSessions({ db: db(tables) }, ME as any, { includeLiveness: false });
    expect(base.truncated).toEqual(["recent", "dismissed", "stashed", "owned"]);
  });

  test("pinned: newest pins win, the cap + 1st is dropped and flagged", async () => {
    // The fake index orders by updated_at; the real by_user_pinned index orders
    // by inbox_pinned_at, so the fixture keeps the two in step.
    const pins = Array.from({ length: INBOX_PINNED_CAP + 1 }, (_, i) =>
      conv(`p${i}`, { inbox_pinned_at: EPOCH - 40 * 24 * H - i * MIN, updated_at: EPOCH - 40 * 24 * H - i * MIN }));
    const { liveness, projection } = await computeSessionsLiveness({ db: db({ conversations: pins }) }, ME as any);
    expect(projection.truncated).toEqual(["pinned"]);
    expect(Object.keys(liveness)).toHaveLength(INBOX_PINNED_CAP);
    expect(liveness.conversations_p0).toBeDefined(); // the newest pin
    expect(liveness[`conversations_p${INBOX_PINNED_CAP}`]).toBeUndefined(); // the oldest pin
    expect(projection.tally.shown.pinned).toBe(INBOX_PINNED_CAP);
  });

  test("members and member_rows flag the team caps", async () => {
    const TEAM = "teams_1";
    const memberIds = Array.from({ length: 51 }, (_, i) => `users_m${i}`);
    const tables = {
      teams: [{ _id: TEAM }],
      team_memberships: [
        { _id: "tm_me", team_id: TEAM, user_id: ME },
        ...memberIds.map((id, i) => ({ _id: `tm_${i}`, team_id: TEAM, user_id: id })),
      ],
      users: [{ _id: ME, name: "Me" }, ...memberIds.map((id) => ({ _id: id, name: id }))],
      conversations: [
        conv("mine"),
        ...Array.from({ length: 61 }, (_, i) => conv(`m0_${i}`, { user_id: "users_m0", team_id: TEAM, is_private: false, updated_at: EPOCH - H - i * 1000 })),
      ],
    };
    const { projection } = await computeSessionsLiveness({ db: db(tables) }, ME as any, TEAM as any);
    expect(projection.scope).toBe("team");
    expect(projection.team_id).toBe(TEAM);
    // 60 teammate rows are idle foreign parents competing for the 40 scan slots.
    expect(projection.truncated).toEqual(["members", "member_rows", "foreign_scan"]);
  });
});

describe("base, crawl and byIds channels carry no projection or liveness", () => {
  const tables = () => ({
    conversations: [conv("a", { updated_at: EPOCH - MIN }), conv("b", { inbox_pinned_at: EPOCH - H })],
    managed_sessions: [
      { _id: "ms_a", user_id: ME, conversation_id: "conversations_a", last_heartbeat: EPOCH - 1000, agent_status: "working", agent_status_updated_at: EPOCH - MIN },
    ],
  });

  const assertNone = (rows: any[], fields: readonly string[]) => {
    for (const row of rows) for (const f of fields) expect(row[f] ?? null).toBeNull();
  };

  test("listInboxSessions base (include_liveness false) has neither projection nor liveness fields", async () => {
    const { sessions, truncated } = await computeInboxSessions({ db: db(tables()) }, ME as any, { includeLiveness: false, fastFieldsInOverlay: true });
    expect(sessions.length).toBe(2);
    assertNone(sessions, [...INBOX_PROJECTION_FIELDS, ...LIVENESS_FIELDS]);
    expect(truncated).toEqual([]);
  });

  test("even with liveness included, the base list never carries a bucket", async () => {
    const { sessions } = await computeInboxSessions({ db: db(tables()) }, ME as any, {});
    assertNone(sessions, INBOX_PROJECTION_FIELDS);
    expect(sessions.find((s: any) => s._id === "conversations_a").agent_status).toBe("working");
  });

  test("getInboxSessionsByIds and listInboxSessionsPaginated strip liveness and carry no projection", async () => {
    const byIds = await collectInboxSessionsByIds({ db: db(tables()) }, ME as any, ["conversations_a", "conversations_b"]);
    expect(byIds.sessions.length).toBe(2);
    assertNone(byIds.sessions, [...INBOX_PROJECTION_FIELDS, ...LIVENESS_FIELDS]);
    const page = await collectInboxSessionsPaginated({ db: db(tables()) }, ME as any, { paginationOpts: { numItems: 50, cursor: null } });
    expect(page.page.length).toBe(2);
    assertNone(page.page, [...INBOX_PROJECTION_FIELDS, ...LIVENESS_FIELDS]);
  });

  test("the base path with liveness off reads neither managed_sessions nor messages; the crawl reads no managed_sessions", async () => {
    const { ctx, ops } = countingCtx(db(tables()));
    await computeInboxSessions(ctx, ME as any, { includeLiveness: false, fastFieldsInOverlay: true });
    expect(ops.filter((o) => o.startsWith("managed_sessions") || o.startsWith("messages"))).toEqual([]);
    const crawl = countingCtx(db(tables()));
    await collectInboxSessionsPaginated(crawl.ctx, ME as any, { paginationOpts: { numItems: 50, cursor: null } });
    expect(crawl.ops.filter((o) => o.startsWith("managed_sessions"))).toEqual([]);
  });
});

describe("overlay read budget", () => {
  test("stamping adds no reads: the execution's reads are the scan, the maps, the decisions read and one newest-message read per non-idle row", async () => {
    const tables = {
      conversations: [
        conv("settled"),                                   // idle at the epoch: no probe
        conv("live", { updated_at: EPOCH - 10_000 }),      // not idle: one AUQ probe
        conv("nolastrole", { last_message_role: undefined }), // fallback read, reused as the probe
        conv("pinned", { inbox_pinned_at: EPOCH - H }),
        conv("dismissed", { inbox_dismissed_at: EPOCH - H }),
      ],
      managed_sessions: [
        { _id: "ms_live", user_id: ME, conversation_id: "conversations_live", last_heartbeat: EPOCH - 1000, agent_status: "working", agent_status_updated_at: EPOCH - 10_000 },
      ],
    };
    const { ctx, ops } = countingCtx(db(tables));
    await computeSessionsLiveness(ctx, ME as any);
    const by = (prefix: string) => ops.filter((o) => o.startsWith(prefix)).length;
    expect(by("managed_sessions")).toBe(1);
    expect(by("session_decisions")).toBe(1);
    expect(by("agent_tasks")).toBe(0);
    // One newest-message read for the non-idle row, one for the un-backfilled
    // row (shared by its fallback and its probe), none for settled rows.
    expect(by("messages")).toBe(2);
    // The scan: recent x2 ranges, pinned, dismissed x2, stashed x2, owners.
    expect(by("conversations")).toBe(7);
    expect(by("session_owners")).toBe(1);
    expect(by("get")).toBe(0);
    expect(ops.length).toBe(12);
  });
});

describe("inboxForCLI path — the same placement, tallied from the stamps", () => {
  test("computeInboxSessions with projection stamps every top-level row and the tally reads them", async () => {
    const tables = {
      conversations: [
        conv("q", { updated_at: EPOCH - MIN }),
        conv("pin", { inbox_pinned_at: EPOCH - H }),
        conv("err", { pending_api_error: true }),
        conv("edge", { updated_at: EPOCH - 20 * H }),
        conv("old", { updated_at: EPOCH - 21 * H }),
        conv("sub", { is_subagent: true, parent_conversation_id: "conversations_q", updated_at: EPOCH - MIN }),
      ],
      managed_sessions: [
        { _id: "ms_q", user_id: ME, conversation_id: "conversations_q", last_heartbeat: EPOCH - 1000, agent_status: "permission_blocked", agent_status_updated_at: EPOCH - MIN },
      ],
    };
    const { sessions, hidden_count } = await computeInboxSessions({ db: db(tables) }, ME as any, { show_all: true, projection: true });
    const row = (id: string) => sessions.find((s: any) => s._id === `conversations_${id}`);
    expect(row("q")).toMatchObject({ bucket: "questions", work_state: "needs_input", asking: true, below_fold: false });
    expect(row("pin")).toMatchObject({ bucket: "pinned", work_state: "needs_input", below_fold: false });
    expect(row("err")).toMatchObject({ bucket: "needs_input", work_state: "needs_input" });
    expect(row("old")).toMatchObject({ bucket: "needs_input", below_fold: true });
    expect(row("sub").bucket).toBeUndefined(); // children are never placed
    expect(hidden_count).toBe(1);

    const { counts, rows } = tallyInboxRows(sessions, { showAll: true, stateFilter: null, labelByConv: new Map() });
    expect(counts.needs_input).toBe(5);
    expect(counts.pinned).toBe(1);
    expect(counts.below_fold).toBe(1);
    expect(counts.total).toBe(5);
    expect(rows.find((r) => r.id === "conversations_q")).toMatchObject({ bucket: "questions", below_fold: false });
    expect(rows.find((r) => r.id === "conversations_old")).toMatchObject({ below_fold: true });
  });
});
