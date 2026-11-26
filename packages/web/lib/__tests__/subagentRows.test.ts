import { afterEach, describe, expect, test } from "bun:test";
import type { InboxSession } from "../../store/inboxStore";
import { resolveShowSubagents, resolveSubagentFilter, resolveSubagentRows, subagentLiveOf, subagentPasses, subagentRowsOf, subagentStatusOf, useInboxStore } from "../../store/inboxStore";
import { subagentStateGroups } from "../subagentRows";
import { SESSION_STATUSES } from "../sessionStatus";

const NOW = 1_700_000_000_000;
let seq = 0;
// A Convex-shaped row, settled past the idle grace (lib/__tests__/sessionStatus.test.ts).
const row = (extra: Record<string, unknown> = {}): InboxSession => ({
  _id: `jx7${String(++seq).padStart(29, "0")}`,
  session_id: `s${seq}`,
  agent_type: "claude_code",
  title: `sub ${seq}`,
  message_count: 6,
  updated_at: NOW - 5 * 60_000,
  agent_status_updated_at: NOW - 5 * 60_000,
  started_at: NOW - 30 * 60_000,
  last_heartbeat: NOW - 5_000,
  is_idle: true,
  has_pending: false,
  is_connected: true,
  is_subagent: true,
  ...extra,
}) as InboxSession;

// One child per state the rail can give a subagent.
const working = (extra = {}) => row({ is_idle: false, agent_status: "working", ...extra });
const waiting = (extra = {}) => row({ spawned_by_conversation_id: "jx7parent", agent_status: "idle", ...extra });
const failed = (extra = {}) => row({ agent_status: "idle", pending_api_error: true, pending_api_error_kind: "limit", ...extra });
const finished = (extra = {}) => row(extra); // a Claude Code subagent whose turn ended: Done
const stashed = (extra = {}) => row({ agent_status: "idle", settle_verdict: "done", inbox_stashed_at: NOW - 1_000, ...extra });

describe("subagentStatusOf", () => {
  test("reads each child's own card verdict", () => {
    expect(subagentStatusOf(working(), NOW)).toBe("working");
    expect(subagentStatusOf(waiting(), NOW)).toBe("needs_you");
    expect(subagentStatusOf(failed(), NOW)).toBe("error");
    expect(subagentStatusOf(finished(), NOW)).toBe("done");
    expect(subagentStatusOf(stashed(), NOW)).toBe("stashed");
  });
  test("a row with only a parent pointer is a Claude Code subagent too: finished, Done", () => {
    expect(subagentStatusOf(row({ is_subagent: undefined, parent_conversation_id: "jx7parent" }), NOW)).toBe("done");
  });
});

describe("the card's live facts", () => {
  afterEach(() => useInboxStore.setState({ sessionDecisions: {}, pendingMessages: {} } as any));

  test("a pending decision makes a finished subagent read Needs you, and the filter keeps it", () => {
    const asker = finished();
    expect(subagentStatusOf(asker, NOW)).toBe("done");
    useInboxStore.setState({ sessionDecisions: { d1: { _id: "d1", conversation_id: String(asker._id), status: "pending", blocking: true } } } as any);
    expect(subagentLiveOf(asker, NOW).asking).toBe(true);
    expect(subagentStatusOf(asker, NOW)).toBe("needs_you");
    expect(subagentRowsOf([asker], NOW, "active").map((r) => r.status)).toEqual(["needs_you"]);
  });

  test("facts can be passed in instead of read from the store", () => {
    const asker = finished();
    const state = { sessionDecisions: { d1: { _id: "d1", conversation_id: String(asker._id), status: "pending", blocking: true } } } as any;
    expect(subagentLiveOf(asker, NOW, state).asking).toBe(true);
    expect(subagentLiveOf(asker, NOW, {}).asking).toBe(false);
  });
});

describe("a set-aside child", () => {
  test("still running, it reads Stashed but the filter keeps it as working", () => {
    const runningStashed = row({ is_idle: false, agent_status: "working", inbox_stashed_at: NOW - 1_000, updated_at: NOW - 2_000, agent_status_updated_at: NOW - 2_000 });
    expect(subagentStatusOf(runningStashed, NOW)).toBe("stashed");
    expect(subagentRowsOf([runningStashed], NOW, "active").map((r) => r.status)).toEqual(["stashed"]);
    expect(subagentRowsOf([stashed()], NOW, "active")).toEqual([]);
  });
});

describe("filter levels", () => {
  test("Working or waiting keeps needs you, error, working and starting", () => {
    const kept = SESSION_STATUSES.filter((s) => subagentPasses(s, "active"));
    expect(kept).toEqual(["needs_you", "error", "working", "starting"]);
  });
  test("Also done adds done", () => {
    const kept = SESSION_STATUSES.filter((s) => subagentPasses(s, "active_done"));
    expect(kept).toEqual(["needs_you", "error", "working", "starting", "done"]);
  });
  test("All keeps every state", () => {
    expect(SESSION_STATUSES.filter((s) => subagentPasses(s, "all"))).toEqual([...SESSION_STATUSES]);
  });
  test("subagentRowsOf applies the level", () => {
    const kids = [working(), waiting(), failed(), finished(), stashed()];
    const statuses = (filter: "active" | "active_done" | "all") => subagentRowsOf(kids, NOW, filter).map((r) => r.status);
    expect(statuses("active")).toEqual(["needs_you", "error", "working"]);
    expect(statuses("active_done")).toEqual(["needs_you", "error", "working", "done"]);
    expect(statuses("all")).toEqual(["needs_you", "error", "working", "done", "stashed"]);
  });
  test("the open child survives the filter", () => {
    const open = finished();
    const rows = subagentRowsOf([working(), open], NOW, "active", String(open._id));
    expect(rows.map((r) => r.session)).toContain(open);
    expect(subagentRowsOf([working(), open], NOW, "active").map((r) => r.session)).not.toContain(open);
  });
  test("nothing left is an empty list", () => {
    expect(subagentRowsOf([finished(), stashed()], NOW, "active")).toEqual([]);
  });
});

describe("ordering and dedupe", () => {
  test("most urgent state first, newest first within a state", () => {
    const oldWork = working({ updated_at: NOW - 10 * 60_000, agent_status_updated_at: NOW - 10 * 60_000 });
    const newWork = working({ updated_at: NOW - 60_000, agent_status_updated_at: NOW - 60_000 });
    const ask = waiting();
    const rows = subagentRowsOf([oldWork, newWork, ask], NOW, "all");
    expect(rows.map((r) => r.session)).toEqual([ask, newWork, oldWork]);
  });
  test("a child listed twice (a nested worker that also waits on you) shows once", () => {
    const w = waiting();
    const rows = subagentRowsOf([w, working(), w], NOW, "all");
    expect(rows.filter((r) => r.session === w)).toHaveLength(1);
    expect(rows).toHaveLength(2);
  });
  test("subagentStateGroups counts per state, in order, opening the newest", () => {
    const newer = working({ updated_at: NOW - 60_000, agent_status_updated_at: NOW - 60_000 });
    const rows = subagentRowsOf([working(), newer, waiting(), finished()], NOW, "all");
    const groups = subagentStateGroups(rows);
    expect(groups.map((g) => [g.status, g.count])).toEqual([["needs_you", 1], ["working", 2], ["done", 1]]);
    expect(groups[1].newest).toBe(newer);
  });
});

describe("prefs", () => {
  test("rows: the pick, else the legacy toggle's Full rows, else Folded", () => {
    expect(resolveSubagentRows(undefined)).toBe("folded");
    expect(resolveSubagentRows({ show_subagents: true })).toBe("full");
    expect(resolveSubagentRows({ show_subagents: false })).toBe("folded");
    expect(resolveSubagentRows({ show_subagents: true, subagent_rows: "compact" })).toBe("compact");
    expect(resolveSubagentRows({ subagent_rows: "hidden" })).toBe("hidden");
  });
  test("resolveShowSubagents means Full rows", () => {
    expect(resolveShowSubagents({ show_subagents: true })).toBe(true);
    expect(resolveShowSubagents({ show_subagents: true, subagent_rows: "folded" })).toBe(false);
    expect(resolveShowSubagents({ subagent_rows: "full" })).toBe(true);
  });
  test("filter: the pick, else Working or waiting", () => {
    expect(resolveSubagentFilter(undefined)).toBe("active");
    expect(resolveSubagentFilter({ subagent_filter: "all" })).toBe("all");
  });
});
