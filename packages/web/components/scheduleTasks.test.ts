import { describe, expect, it } from "bun:test";
import { partitionScheduleInbox, type TaskRow } from "./scheduleTasks";
import { isSessionHardBlocked, visualOrderSessions, type InboxSession } from "../store/inboxStore";

// The schedule → inbox projection: standing sessions (armed recurring inject
// schedules), spawn-schedule groups that collapse their runs, and escalation —
// a hard-blocked or flagged run must stay a loose triage card.

const session = (id: string, extra: Partial<InboxSession> = {}): InboxSession => ({
  _id: id,
  session_id: `session-${id}`,
  updated_at: Date.now(),
  agent_type: "claude_code",
  message_count: 3,
  is_idle: true,
  has_pending: false,
  last_user_message: "hi",
  title: `Session ${id}`,
  ...extra,
});

const task = (id: string, extra: Partial<TaskRow> = {}): TaskRow => ({
  _id: id,
  title: `Task ${id}`,
  prompt: "do the thing",
  status: "scheduled",
  schedule_type: "recurring",
  interval_ms: 3_600_000,
  run_at: Date.now() + 3_600_000,
  run_count: 1,
  created_at: Date.now() - 86_400_000,
  ...extra,
});

describe("partitionScheduleInbox", () => {
  it("maps armed recurring inject schedules to standing AND armed-inject; once-inject only to armed-inject", () => {
    const sessions = { home: session("home") };
    const p = partitionScheduleInbox(
      [
        task("t1", { originating_conversation_id: "home" }),
        task("t2", { originating_conversation_id: "home", schedule_type: "once" }),
      ],
      sessions,
    );
    expect(p.standingByConv.get("home")?.map((t) => t._id)).toEqual(["t1"]);
    expect(p.armedInjectByConv.get("home")?.map((t) => t._id)).toEqual(["t1", "t2"]);
    expect(p.spawnGroups).toEqual([]);
  });

  it("ignores non-armed schedules entirely", () => {
    const p = partitionScheduleInbox(
      [task("t1", { originating_conversation_id: "home", status: "completed" })],
      { home: session("home") },
    );
    expect(p.standingByConv.size).toBe(0);
    expect(p.armedInjectByConv.size).toBe(0);
  });

  it("collapses spawn-schedule runs under a group, newest first", () => {
    const sessions = {
      r1: session("r1", { agent_task_id: "sp1", updated_at: 1000 }),
      r2: session("r2", { agent_task_id: "sp1", updated_at: 2000 }),
      other: session("other"),
    };
    const p = partitionScheduleInbox([task("sp1")], sessions);
    expect(p.spawnGroups).toHaveLength(1);
    expect(p.spawnGroups[0].runs.map((r) => r._id)).toEqual(["r2", "r1"]);
    expect([...p.groupedRunIds].sort()).toEqual(["r1", "r2"]);
  });

  it("escalates hard-blocked runs and flagged latest runs out of the group", () => {
    const sessions = {
      blocked: session("blocked", { agent_task_id: "sp1", agent_status: "permission_blocked" }),
      latest: session("latest", { agent_task_id: "sp1", updated_at: 5000 }),
      old: session("old", { agent_task_id: "sp1", updated_at: 100 }),
    };
    const p = partitionScheduleInbox(
      [task("sp1", { last_run_conversation_id: "latest", last_run_needs_attention: true })],
      sessions,
    );
    const grouped = p.spawnGroups[0].runs.map((r) => r._id);
    expect(grouped).toEqual(["old"]);
    expect(p.groupedRunIds.has("blocked")).toBe(false);
    expect(p.groupedRunIds.has("latest")).toBe(false);
  });

  it("skips hidden and subagent runs", () => {
    const sessions = {
      dismissed: session("dismissed", { agent_task_id: "sp1", inbox_dismissed_at: Date.now() }),
      child: session("child", { agent_task_id: "sp1", parent_conversation_id: "p" }),
    };
    const p = partitionScheduleInbox([task("sp1")], sessions);
    expect(p.spawnGroups[0].runs).toEqual([]);
  });
});

describe("isSessionHardBlocked", () => {
  it("blocks on poll, permission prompt, api error, and dead-with-messages — not on a plain finished turn", () => {
    expect(isSessionHardBlocked(session("a", { awaiting_input: true }))).toBe(true);
    expect(isSessionHardBlocked(session("b", { agent_status: "permission_blocked" }))).toBe(true);
    expect(isSessionHardBlocked(session("c", { pending_api_error: true } as Partial<InboxSession>))).toBe(true);
    expect(isSessionHardBlocked(session("d", { agent_status: "stopped" }))).toBe(true);
    // The deliberate difference from isSessionWaitingForInput: idle-with-messages
    // is the uneventful steady state of standing automation, NOT a blocker.
    expect(isSessionHardBlocked(session("e", { is_idle: true }))).toBe(false);
  });

  it("a queued outbound message means the user already acted", () => {
    expect(isSessionHardBlocked(session("a", { awaiting_input: true }), new Set(["a"]))).toBe(false);
  });
});

describe("visualOrderSessions schedule projection", () => {
  const sessions: Record<string, InboxSession> = {
    standing: session("standing", { is_idle: true }),
    ni: session("ni", { is_idle: true }),
    run: session("run", { is_idle: true, agent_task_id: "sp1" }),
  };

  it("hoists standing rows after pinned and drops grouped runs", () => {
    const order = visualOrderSessions(sessions, new Set(), null, new Set(), {
      standingIds: new Set(["standing"]),
      groupedRunIds: new Set(["run"]),
    }).map((s) => s._id);
    expect(order).toEqual(["standing", "ni"]);
  });

  it("collapsed standing section hides its rows from nav", () => {
    const order = visualOrderSessions(sessions, new Set(), null, new Set(), {
      standingIds: new Set(["standing"]),
      groupedRunIds: new Set(["run"]),
      collapsedSections: { standing: true },
    }).map((s) => s._id);
    expect(order).toEqual(["ni"]);
  });

  it("without the sets, behavior is unchanged", () => {
    const order = visualOrderSessions(sessions, new Set(), null, new Set(), {}).map((s) => s._id);
    expect(order.sort()).toEqual(["ni", "run", "standing"]);
  });
});
