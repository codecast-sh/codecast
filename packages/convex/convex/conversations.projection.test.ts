import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  computeInboxSessions,
  computeSessionsLiveness,
  collectInboxSessionsByIds,
  collectInboxSessionsPaginated,
  tallyInboxRows,
  INBOX_PROJECTION_FIELDS,
  INBOX_LIVENESS_FIELDS,
  INBOX_FAST_FIELDS,
  _resetChildAuqProbeCacheForTests,
} from "./conversations";
import { INBOX_PINNED_CAP } from "./inboxProjection";
import {
  AGENT_IDLE_GRACE_MS,
  STATUS_TRUST_TTL_MS,
  HEARTBEAT_ALIVE_MS,
} from "./inboxFilters";
import { digestProjection, inboxEpoch, INBOX_FACT_FIELDS, INBOX_PROJECTION_VERSION, deriveLiveAt, rowLiveDeadlines, computeBucketStale, placeProjectableRow, rollupParentIdOf, type InboxBucket } from "@codecast/shared/contracts";
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
beforeEach(() => { nowSpy = spyOn(Date, "now").mockReturnValue(NOW); _resetChildAuqProbeCacheForTests(); });
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
    // BYTE identical (C2): no raw execution timestamp may reach the payload,
    // so Convex suppresses the push between real changes.
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(first.projection.epoch).toBe(EPOCH);
    expect((first.projection as any).as_of).toBeUndefined();
    expect(first.projection).toMatchObject({ v: INBOX_PROJECTION_VERSION, user_id: ME, scope: "mine", team_id: null, truncated: [] });
  });

  test("the digest is the shared algorithm over every (id, bucket, fold) triple, hidden included; the kill switch nulls it", async () => {
    const tables = {
      conversations: [conv("a"), conv("anchor", { anchor_id: "anchors_1" }), conv("d", { inbox_dismissed_at: EPOCH - H })],
    };
    const { liveness, projection } = await computeSessionsLiveness({ db: db(tables) }, ME as any);
    const pairs = Object.entries(liveness).map(([id, row]) => [id, row.bucket!, row.below_fold!] as [string, string, boolean]);
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
    // Children are never projection MEMBERS — no bucket, no digest entry —
    // but the live probed ones ride the map as FACT-ONLY rows so a replica can
    // compute the parent rollup itself (C1).
    expect(liveness.conversations_child_perm.agent_status).toBe("permission_blocked");
    expect(liveness.conversations_child_perm.bucket).toBeUndefined();
    expect(liveness.conversations_child_auq.awaiting_input).toBe(true);
    expect(liveness.conversations_child_auq.bucket).toBeUndefined();
    expect(liveness.conversations_child_auq.last_turn_allows_park).toBeDefined();
    // An idle child is not probed and ships no fact row.
    expect(Object.keys(liveness)).not.toContain("conversations_child_quiet");
    // Every fact is EXPLICIT on the wire (C1, one writer): a row with no
    // managed status ships `agent_status: null`, never an absent key — Convex
    // drops undefined, and a replica that merges only the keys it receives
    // kept a "stopped" from the day the daemon died (prod, 2026-09-01).
    const wire = JSON.parse(JSON.stringify(liveness));
    expect(wire.conversations_decide.agent_status).toBeNull();
    for (const [id, row] of Object.entries<any>(wire)) {
      if (row.bucket === undefined) continue; // fact-only child rows carry what the probe read
      for (const f of INBOX_FACT_FIELDS) expect(Object.prototype.hasOwnProperty.call(row, f), `${id}.${f}`).toBe(true);
    }
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

describe("overlay projection — a team files as one group", () => {
  test("a teammate rides its lead: bucket, fold and time flip follow the lead on the overlay and in the CLI stamping", async () => {
    const tables = {
      conversations: [
        conv("lead", { updated_at: EPOCH - MIN, agent_team_name: "team", agent_name: "team-lead" }),
        conv("mate_done", { updated_at: EPOCH - 2 * MIN, status: "completed", spawned_by_conversation_id: "conversations_lead", agent_team_name: "team" }),
        conv("mate_pinned", { updated_at: EPOCH - 3 * MIN, inbox_pinned_at: EPOCH - 3 * MIN, spawned_by_conversation_id: "conversations_lead", agent_team_name: "team" }),
        conv("mate_lead_absent", { updated_at: EPOCH - 4 * MIN, spawned_by_conversation_id: "conversations_nobody", agent_team_name: "team" }),
        conv("edge", { updated_at: EPOCH - 30 * H }),
        conv("old_lead", { updated_at: EPOCH - 31 * H, agent_team_name: "team", agent_name: "team-lead" }),
        conv("mate_fresh_under_old_lead", { updated_at: EPOCH - 5 * MIN, spawned_by_conversation_id: "conversations_old_lead", agent_team_name: "team" }),
      ],
      managed_sessions: [
        { _id: "ms_lead", user_id: ME, conversation_id: "conversations_lead", last_heartbeat: EPOCH - 1000, agent_status: "working", agent_status_updated_at: EPOCH - MIN },
        { _id: "ms_mate_done", user_id: ME, conversation_id: "conversations_mate_done", last_heartbeat: EPOCH - 1000, agent_status: "stopped", agent_status_updated_at: EPOCH - 2 * MIN },
      ],
    };
    const { liveness, projection } = await computeSessionsLiveness({ db: db(tables) }, ME as any);
    expect(liveness.conversations_lead).toMatchObject({ bucket: "working", below_fold: false });
    // The finished worker keeps its own verdict (needs_input: dead with
    // output) but files with its lead, time flip included.
    expect(liveness.conversations_mate_done).toMatchObject({ bucket: "working", work_state: "needs_input", below_fold: false });
    expect(liveness.conversations_mate_done.bucket_stale_at).toBe(liveness.conversations_lead.bucket_stale_at);
    expect(liveness.conversations_mate_done.stale_bucket).toBe(liveness.conversations_lead.stale_bucket);
    // A pin is the viewer's act on the row: it keeps that place.
    expect(liveness.conversations_mate_pinned).toMatchObject({ bucket: "pinned" });
    // No lead present: the row places on its own.
    expect(liveness.conversations_mate_lead_absent).toMatchObject({ bucket: "needs_input", below_fold: false });
    // The fold rides too: a fresh teammate folds with its lead under the cut.
    expect(liveness.conversations_old_lead).toMatchObject({ below_fold: true });
    expect(liveness.conversations_mate_fresh_under_old_lead).toMatchObject({ bucket: "needs_input", below_fold: true });
    expect(projection.tally.shown.working).toBe(2);
    expect(projection.tally.shown.pinned).toBe(1);
    expect(projection.tally.folded.needs_input).toBe(2);
    // The CLI stamping files the team the same way.
    _resetChildAuqProbeCacheForTests();
    const cli = await computeInboxSessions({ db: db(tables) }, ME as any, { show_all: true, projection: true });
    const cliRow = (id: string) => cli.sessions.find((s: any) => s._id === `conversations_${id}`);
    expect(cliRow("mate_done")).toMatchObject({ bucket: "working", work_state: "needs_input", below_fold: false });
    expect(cliRow("mate_fresh_under_old_lead")).toMatchObject({ bucket: "needs_input", below_fold: true });
    expect(cliRow("mate_pinned")).toMatchObject({ bucket: "pinned" });
    expect(cliRow("mate_lead_absent")).toMatchObject({ bucket: "needs_input" });
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

describe("overlay read budget — the child probe cache", () => {
  test("child AUQ probes are cached by (child id, message_count): a repeat execution pays zero message reads and emits the same payload", async () => {
    const tables = () => ({
      conversations: [
        conv("parent", { updated_at: EPOCH - MIN }),
        conv("child", { is_subagent: true, parent_conversation_id: "conversations_parent", updated_at: EPOCH - MIN }),
      ],
      managed_sessions: [
        { _id: "ms_parent", user_id: ME, conversation_id: "conversations_parent", last_heartbeat: EPOCH - 1000, agent_status: "working", agent_status_updated_at: EPOCH - MIN },
        { _id: "ms_child", user_id: ME, conversation_id: "conversations_child", last_heartbeat: EPOCH - 1000, agent_status: "working", agent_status_updated_at: EPOCH - MIN },
      ],
      messages: [
        { _id: "messages_auq", conversation_id: "conversations_child", role: "assistant", timestamp: EPOCH - MIN, tool_calls: [{ name: "AskUserQuestion" }] },
      ],
    });
    const cold = countingCtx(db(tables()));
    const first = await computeSessionsLiveness(cold.ctx, ME as any);
    expect(first.liveness.conversations_parent.asking).toBe(true);
    expect(first.liveness.conversations_child.awaiting_input).toBe(true); // the fact-only child row
    const coldChildReads = cold.ops.filter((o) => o.startsWith("messages")).length;
    expect(coldChildReads).toBeGreaterThanOrEqual(1);

    const warm = countingCtx(db(tables()));
    const second = await computeSessionsLiveness(warm.ctx, ME as any);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    // The child probe answered from the (id, message_count) cache. The
    // parent's own reads are unchanged.
    expect(warm.ops.filter((o) => o.startsWith("messages")).length).toBe(coldChildReads - 1);
  });

  test("a message_count change invalidates the cached probe", async () => {
    const base = {
      conversations: [
        conv("parent", { updated_at: EPOCH - MIN }),
        conv("child", { is_subagent: true, parent_conversation_id: "conversations_parent", updated_at: EPOCH - MIN }),
      ],
      managed_sessions: [
        { _id: "ms_child", user_id: ME, conversation_id: "conversations_child", last_heartbeat: EPOCH - 1000, agent_status: "working", agent_status_updated_at: EPOCH - MIN },
      ],
      messages: [
        { _id: "messages_auq", conversation_id: "conversations_child", role: "assistant", timestamp: EPOCH - MIN, tool_calls: [{ name: "AskUserQuestion" }] },
      ],
    };
    const first = await computeSessionsLiveness({ db: db(base) }, ME as any);
    expect(first.liveness.conversations_parent.asking).toBe(true);
    // The answer arrives: a newer tool_result message, message_count bumped.
    const answered = {
      ...base,
      conversations: base.conversations.map((c: any) => c._id === "conversations_child" ? { ...c, message_count: 5 } : c),
      messages: [
        ...base.messages,
        { _id: "messages_answer", conversation_id: "conversations_child", role: "user", timestamp: EPOCH - MIN + 1000, tool_results: [{}] },
      ],
    };
    const second = await computeSessionsLiveness({ db: db(answered) }, ME as any);
    expect(second.liveness.conversations_parent.asking).toBe(false);
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


// The replica's live derivation IS the server's (ct-47609, sync-convergence
// C1/C2): over the facts an overlay row ships, the shared deriveLiveAt at the
// epoch reproduces the row's live fields exactly, and the shared deadline
// list plus computeBucketStale reproduce the row's time flip. Whatever the
// server stamps, a replica holding the same facts computes the same thing at
// the same instants.
describe("the replica's live derivation is the server's", () => {
  test("deriveLiveAt at the epoch equals the shipped live fields; rowLiveDeadlines + computeBucketStale equal the shipped flip", async () => {
    const tables = {
      conversations: [
        conv("graced", { updated_at: EPOCH - 30_000, message_count: 6 }),
        conv("decay", { updated_at: EPOCH - 2 * H, message_count: 40 }),
        conv("unanswered", { updated_at: EPOCH - 2 * MIN, message_count: 12, last_message_role: "user" }),
        conv("parent", { updated_at: EPOCH - 10 * MIN, message_count: 9 }),
        conv("child", { is_subagent: true, parent_conversation_id: "conversations_parent", updated_at: EPOCH - 2 * MIN, message_count: 4 }),
        conv("waiting", { updated_at: EPOCH - 3 * H, message_count: 20 }),
        conv("done", { updated_at: EPOCH - 5 * H, message_count: 30, thread_state_status: "done" }),
        conv("dead", { updated_at: EPOCH - 3 * MIN, message_count: 7 }),
        conv("own", { updated_at: EPOCH - MIN, message_count: 3 }),
      ],
      managed_sessions: [
        { _id: "ms_graced", user_id: ME, conversation_id: "conversations_graced", last_heartbeat: EPOCH - 5_000, agent_status: "idle", agent_status_updated_at: EPOCH - 30_000 },
        { _id: "ms_decay", user_id: ME, conversation_id: "conversations_decay", last_heartbeat: EPOCH - 5_000, agent_status: "working", agent_status_updated_at: EPOCH - 2 * H },
        { _id: "ms_parent", user_id: ME, conversation_id: "conversations_parent", last_heartbeat: EPOCH - 5_000, agent_status: "idle", agent_status_updated_at: EPOCH - 10 * MIN },
        { _id: "ms_child", user_id: ME, conversation_id: "conversations_child", last_heartbeat: EPOCH - 5_000, agent_status: "working", agent_status_updated_at: EPOCH - 2 * MIN },
        { _id: "ms_waiting", user_id: ME, conversation_id: "conversations_waiting", last_heartbeat: EPOCH - 5_000, agent_status: "waiting", agent_status_updated_at: EPOCH - 3 * H, open_tasks: [{ id: "t1" }], open_tasks_at: EPOCH - 4 * MIN },
        { _id: "ms_done", user_id: ME, conversation_id: "conversations_done", last_heartbeat: EPOCH - 5 * H, agent_status: "done", agent_status_updated_at: EPOCH - 5 * H },
        { _id: "ms_dead", user_id: ME, conversation_id: "conversations_dead", last_heartbeat: EPOCH - 4 * MIN, agent_status: "working", agent_status_updated_at: EPOCH - 3 * MIN },
        { _id: "ms_own", user_id: ME, conversation_id: "conversations_own", last_heartbeat: EPOCH - 1000, agent_status: "permission_blocked", agent_status_updated_at: EPOCH - MIN },
      ],
    };
    const { liveness } = await computeSessionsLiveness({ db: db(tables) }, ME as any);
    let checkedLive = 0;
    let checkedFlip = 0;
    for (const [cid, row] of Object.entries<any>(liveness)) {
      const conv = tables.conversations.find((c: any) => c._id === cid)!;
      const facts = { ...conv, ...row };
      const live = deriveLiveAt(facts, EPOCH);
      expect({ agent_status: live.agent_status, is_idle: live.is_idle, is_unresponsive: live.is_unresponsive, awaiting_input: live.awaiting_input, is_connected: live.daemon_alive })
        .toEqual({ agent_status: row.agent_status, is_idle: row.is_idle, is_unresponsive: row.is_unresponsive, awaiting_input: row.awaiting_input, is_connected: row.is_connected });
      checkedLive++;
      // The flip: members whose asking cannot change with time (false, and an
      // ask only ever drops) and that ride no lead.
      if (row.bucket === undefined || row.asking || rollupParentIdOf(conv as any)) continue;
      const stale = computeBucketStale(
        {
          deadlines: rowLiveDeadlines(facts),
          placeAt: (t) => placeProjectableRow({ ...facts, ...deriveLiveAt(facts, t) }, false, t),
          current: row.bucket,
        },
        EPOCH,
      );
      expect(stale).toEqual({ bucket_stale_at: row.bucket_stale_at, stale_bucket: row.stale_bucket });
      checkedFlip++;
    }
    expect(checkedLive).toBeGreaterThanOrEqual(8);
    expect(checkedFlip).toBeGreaterThanOrEqual(5);
    expect(liveness.conversations_graced).toMatchObject({ agent_status_updated_at: EPOCH - 30_000, last_role_is_user: false, is_idle: false });
    expect(liveness.conversations_parent.is_idle).toBe(false);
    expect(liveness.conversations_parent.producing_until).toBeGreaterThan(EPOCH);
    expect(liveness.conversations_unanswered).toMatchObject({ last_role_is_user: true, agent_status: null });
    expect(liveness.conversations_decay).toMatchObject({ agent_status: "idle", is_idle: true });
    expect(liveness.conversations_dead).toMatchObject({ agent_status: "stopped", is_connected: false });
  });
});
