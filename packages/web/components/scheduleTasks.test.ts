import { describe, expect, it } from "bun:test";
import { partitionScheduleInbox, type TaskRow } from "./scheduleTasks";
import { isSessionHardBlocked, visualOrderSessions, type InboxSession } from "../store/inboxStore";

// The schedule → inbox projection under the synthesis model: one row per armed
// schedule, sessions absorbed behind rows (resting loop homes + uneventful
// runs), and escalation — anything needing a human stays a loose triage card.

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

// A machine-delivered last turn (scheduled injection) — loops rest only then.
const MACHINE_TURN = '<scheduled-task title="t" task-id="x">go</scheduled-task>';

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

describe("partitionScheduleInbox rows", () => {
  it("gives every armed schedule exactly one row — inject, spawn, once, event alike", () => {
    const p = partitionScheduleInbox(
      [
        task("loop", { originating_conversation_id: "home" }),
        task("once", { originating_conversation_id: "conv", schedule_type: "once" }),
        task("spawn", {}),
        task("done", { status: "completed" }),
      ],
      { home: session("home"), conv: session("conv") },
    );
    expect(p.rows.map((r) => r.task._id).sort()).toEqual(["loop", "once", "spawn"]);
  });

  it("sorts soonest fire first; paused sinks to the bottom", () => {
    const now = Date.now();
    const p = partitionScheduleInbox(
      [
        task("late", { run_at: now + 9_000_000 }),
        task("soon", { run_at: now + 60_000 }),
        task("paused", { status: "paused", run_at: now + 1 }),
      ],
      {},
    );
    expect(p.rows.map((r) => r.task._id)).toEqual(["soon", "late", "paused"]);
    expect(p.nextRunAt).toBe(now + 60_000);
  });

  it("counts unread outcomes against the watermark", () => {
    const now = Date.now();
    const p = partitionScheduleInbox(
      [
        task("new", { last_run_at: now - 1000 }),
        task("old", { last_run_at: now - 100_000 }),
        task("never", { last_run_at: undefined }),
      ],
      {},
      { seenAt: now - 50_000 },
    );
    expect(p.unreadCount).toBe(1);
    expect(p.rows.find((r) => r.task._id === "new")?.unread).toBe(true);
    expect(p.rows.find((r) => r.task._id === "old")?.unread).toBe(false);
  });
});

describe("absorption (behind-the-row) rules", () => {
  it("a resting loop home is absorbed; a once follow-up never absorbs its conversation", () => {
    const sessions = {
      home: session("home", { last_user_message: MACHINE_TURN }),
      conv: session("conv", { last_user_message: MACHINE_TURN }),
    };
    const p = partitionScheduleInbox(
      [
        task("loop", { originating_conversation_id: "home" }),
        task("once", { originating_conversation_id: "conv", schedule_type: "once" }),
      ],
      sessions,
    );
    expect(p.absorbedIds.has("home")).toBe(true);
    expect(p.absorbedIds.has("conv")).toBe(false);
  });

  it("human-typed last turn, pinned, or hard-blocked homes are never absorbed", () => {
    const sessions = {
      human: session("human", { last_user_message: "hey can you check something" }),
      pinned: session("pinned", { is_pinned: true, last_user_message: MACHINE_TURN }),
      blocked: session("blocked", { agent_status: "permission_blocked", last_user_message: MACHINE_TURN }),
    };
    const p = partitionScheduleInbox(
      [
        task("t1", { originating_conversation_id: "human" }),
        task("t2", { originating_conversation_id: "pinned" }),
        task("t3", { originating_conversation_id: "blocked" }),
      ],
      sessions,
    );
    expect(p.absorbedIds.size).toBe(0);
    expect(p.rows).toHaveLength(3); // rows exist regardless — only absorption is conditional
  });

  it("uneventful spawn runs absorb; hard-blocked or flagged-latest runs escalate", () => {
    const sessions = {
      quiet: session("quiet", { agent_task_id: "sp", updated_at: 100 }),
      blocked: session("blocked", { agent_task_id: "sp", agent_status: "permission_blocked" }),
      latest: session("latest", { agent_task_id: "sp", updated_at: 5000 }),
    };
    const p = partitionScheduleInbox(
      [task("sp", { last_run_conversation_id: "latest", last_run_needs_attention: true })],
      sessions,
    );
    expect(p.absorbedIds.has("quiet")).toBe(true);
    expect(p.absorbedIds.has("blocked")).toBe(false);
    expect(p.absorbedIds.has("latest")).toBe(false);
  });

  it("row openId prefers home conv (inject) / newest absorbed run, falling back to last recorded run", () => {
    const sessions = {
      home: session("home"),
      r1: session("r1", { agent_task_id: "sp", updated_at: 1000 }),
      r2: session("r2", { agent_task_id: "sp", updated_at: 2000 }),
    };
    const p = partitionScheduleInbox(
      [
        task("loop", { originating_conversation_id: "home" }),
        task("sp", {}),
        task("neverrun", { last_run_conversation_id: "folded" }),
      ],
      sessions,
    );
    const byId = Object.fromEntries(p.rows.map((r) => [r.task._id, r]));
    expect(byId["loop"].openId).toBe("home");
    expect(byId["sp"].openId).toBe("r2");
    expect(byId["neverrun"].openId).toBe("folded");
  });

  it("armedInjectByConv maps every armed inject schedule (once included) for the kill toast", () => {
    const p = partitionScheduleInbox(
      [
        task("loop", { originating_conversation_id: "home" }),
        task("once", { originating_conversation_id: "home", schedule_type: "once" }),
      ],
      { home: session("home") },
    );
    expect(p.armedInjectByConv.get("home")?.map((t) => t._id)).toEqual(["loop", "once"]);
  });
});

describe("isSessionHardBlocked", () => {
  it("blocks on poll, permission prompt, api error, and dead-with-messages — not a plain finished turn", () => {
    expect(isSessionHardBlocked(session("a", { awaiting_input: true }))).toBe(true);
    expect(isSessionHardBlocked(session("b", { agent_status: "permission_blocked" }))).toBe(true);
    expect(isSessionHardBlocked(session("c", { pending_api_error: true } as Partial<InboxSession>))).toBe(true);
    expect(isSessionHardBlocked(session("d", { agent_status: "stopped" }))).toBe(true);
    expect(isSessionHardBlocked(session("e", { is_idle: true }))).toBe(false);
  });

  it("a queued outbound message means the user already acted", () => {
    expect(isSessionHardBlocked(session("a", { awaiting_input: true }), new Set(["a"]))).toBe(false);
  });
});

describe("visualOrderSessions absorbed projection", () => {
  const sessions: Record<string, InboxSession> = {
    resting: session("resting", { is_idle: true }),
    ni: session("ni", { is_idle: true }),
    run: session("run", { is_idle: true, agent_task_id: "sp" }),
  };

  it("drops absorbed sessions from nav entirely", () => {
    const order = visualOrderSessions(sessions, new Set(), null, new Set(), {
      absorbedIds: new Set(["resting", "run"]),
    }).map((s) => s._id);
    expect(order).toEqual(["ni"]);
  });

  it("without the set, behavior is unchanged", () => {
    const order = visualOrderSessions(sessions, new Set(), null, new Set(), {}).map((s) => s._id);
    expect(order.sort()).toEqual(["ni", "resting", "run"]);
  });
});
