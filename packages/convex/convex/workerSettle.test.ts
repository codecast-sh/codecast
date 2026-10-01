import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { performTellParent, scheduleWorkerSettle } from "./workerSettle";
import { makeFakeDb } from "./testDb";

// A `cast spawn --subagent` worker reports to the session it nests under. On
// 2026-09-30 jx75xx3 spawned jx75tw6, pinned dormant "waiting on the worker",
// and ended its turn with no watch armed. The worker finished four hours later
// and nothing told the parent: it slept on a report nobody delivered, and the
// inbox filed its bare dormant claim under Needs Input. These pin the delivery.

const NOW = 1_800_000_000_000;
const USER = "users_me";
const PARENT = "conversations_parent";
const STATUS_TS = NOW - 50_000;
let time: ReturnType<typeof spyOn>;

beforeEach(() => { time = spyOn(Date, "now").mockReturnValue(NOW); });
afterEach(() => { time.mockRestore(); });

function worker(id: string, overrides: Record<string, any> = {}) {
  return {
    _id: `conversations_${id}`,
    user_id: USER,
    short_id: id,
    title: `Worker ${id}`,
    parent_conversation_id: PARENT,
    is_subagent: true,
    spawned_by_conversation_id: PARENT,
    status: "active",
    message_count: 40,
    thread_state: "Change is on branch call-action-timing, gate red on two main failures",
    thread_state_status: "done",
    thread_state_at: NOW - 60_000,
    thread_state_msg_count: 39,
    ...overrides,
  };
}

function session(id: string, agent_status: string, updatedAt = STATUS_TS) {
  return { _id: `managed_sessions_${id}`, user_id: USER, conversation_id: `conversations_${id}`, agent_status, agent_status_updated_at: updatedAt };
}

function world(workers: any[], sessions: any[], parent: Record<string, any> = {}, messages: any[] = []) {
  const tables: Record<string, any[]> = {
    messages,
    conversations: [{ _id: PARENT, user_id: USER, session_id: "parent-session", status: "active", short_id: "jx75xx3", ...parent }, ...workers],
    managed_sessions: sessions,
    pending_messages: [],
  };
  const scheduled: any[] = [];
  const ctx = { db: makeFakeDb(tables), scheduler: { runAfter: async (delay: number, fn: any, args: any) => { scheduled.push({ delay, args }); } } };
  return { ctx, tables, scheduled };
}

const wakes = (tables: Record<string, any[]>) => tables.pending_messages.filter((m) => m.conversation_id === PARENT);
const tell = (ctx: any, id: string, status_ts: number | undefined = STATUS_TS) =>
  performTellParent(ctx, { conversation_id: `conversations_${id}` as any, status_ts });

describe("a spawned worker's settle wakes its parent", () => {
  test("a finished worker tells its parent once, with its pinned line and how to read it", async () => {
    const { ctx, tables } = world([worker("jx75tw6")], [session("jx75tw6", "done")]);
    expect(await tell(ctx, "jx75tw6")).toEqual({ told: 1 });
    const [msg] = wakes(tables);
    expect(msg.content).toContain('title="Worker jx75tw6 finished"');
    expect(msg.content).toContain("Change is on branch call-action-timing");
    expect(msg.content).toContain("cast read jx75tw6");
    // The needs-input check runs more than once per settle; the episode tells once.
    expect(await tell(ctx, "jx75tw6")).toEqual({ told: 0, reason: "already" });
    expect(wakes(tables)).toHaveLength(1);
  });

  test("a worker that works on and settles again tells again", async () => {
    const { ctx, tables } = world([worker("jx75tw6")], [session("jx75tw6", "done")]);
    await tell(ctx, "jx75tw6");
    const w = tables.conversations.find((c) => c._id === "conversations_jx75tw6");
    Object.assign(w, { message_count: 60, thread_state: "Raised the gate cap", thread_state_msg_count: 59 });
    expect(await tell(ctx, "jx75tw6")).toEqual({ told: 1 });
    expect(wakes(tables)).toHaveLength(2);
  });

  test("stalls and blocks tell too, in their own words", async () => {
    const stopped = world([worker("a")], [session("a", "stopped")]);
    await tell(stopped.ctx, "a");
    expect(wakes(stopped.tables)[0].content).toContain('title="Worker a has stopped"');

    const prompt = world([worker("a")], [session("a", "permission_blocked")]);
    await tell(prompt.ctx, "a");
    expect(wakes(prompt.tables)[0].content).toContain('why="permission_blocked"');

    const blocked = world([worker("a", { thread_state_status: "blocked" })], [session("a", "idle")]);
    await tell(blocked.ctx, "a");
    expect(wakes(blocked.tables)[0].content).toContain('title="Worker a is blocked"');
  });

  test("a worker parked on a wake of its own, or still producing, tells nobody", async () => {
    for (const status of ["dormant", "waiting", "working", "thinking"]) {
      const { ctx, tables } = world([worker("a")], [session("a", status)]);
      await tell(ctx, "a");
      expect(wakes(tables)).toHaveLength(0);
    }
  });

  test("a plain settle with no fresh declaration still tells", async () => {
    // An old pinned dormant says nothing about this turn: the daemon's status is the verdict.
    const { ctx, tables } = world([worker("a", { thread_state_status: "dormant" })], [session("a", "idle")]);
    await tell(ctx, "a");
    expect(wakes(tables)[0].content).toContain('title="Worker a ended its turn"');
  });

  test("with nothing pinned, the report is the last thing a person typed, never a machine message", async () => {
    // jx7fee0 settled with no `cast state`; its last user-role row was a harness
    // <task-notification>, and the lead read that raw XML as the worker's report.
    const notification = "<task-notification> <task-id>bq6r273mk</task-id> <tool-use-id>toolu_01Hk</tool-use-id> <output-file>/tmp/x</output-file></task-notification>";
    const msg = (i: number, role: string, content: string, extra: Record<string, any> = {}) =>
      ({ _id: `messages_${i}`, conversation_id: "conversations_a", role, content, timestamp: NOW - 100_000 + i, ...extra });
    const typed = [
      msg(1, "user", "Reword the fee copy so it matches mobile"),
      msg(2, "assistant", "Rewording it now."),
      msg(3, "user", "", { tool_results: [{ tool_use_id: "t", content: "ok" }] }),
      msg(4, "user", '<session-message from="jx75xx3">any news?</session-message>'),
      msg(5, "user", notification),
    ];
    const pinless = { thread_state: undefined, thread_state_status: undefined, last_message_preview: notification };
    const { ctx, tables } = world([worker("a", pinless)], [session("a", "idle")], {}, typed);
    await tell(ctx, "a");
    const [wake] = wakes(tables);
    expect(wake.content).toContain(">Reword the fee copy so it matches mobile</worker-report>");
    expect(wake.content).not.toContain("task-notification");

    // Nothing a person typed: the report stays empty rather than showing plumbing.
    const machineOnly = world([worker("a", pinless)], [session("a", "idle")], {}, [msg(5, "user", notification)]);
    await tell(machineOnly.ctx, "a");
    expect(wakes(machineOnly.tables)[0].content).toContain('why="ended" since="1800000000000"></worker-report>');

    // A person writing from the web arrives wrapped; the report is their words.
    const fromWeb = world([worker("a", pinless)], [session("a", "idle")], {}, [msg(1, "user", '<user-message from="Ashot">\nShip the fee copy\n</user-message>'), msg(5, "user", notification)]);
    await tell(fromWeb.ctx, "a");
    expect(wakes(fromWeb.tables)[0].content).toContain(">Ship the fee copy</worker-report>");
  });

  test("workers that settle together reach the parent as one message", async () => {
    const { ctx, tables } = world(
      [worker("a"), worker("b"), worker("c")],
      [session("a", "done"), session("b", "done"), session("c", "dormant")],
    );
    expect(await tell(ctx, "a")).toEqual({ told: 2 });
    const [msg] = wakes(tables);
    expect(msg.content).toContain('title="2 workers settled"');
    expect(msg.content).toContain('<worker-report id="a" title="Worker a" why="done"');
    expect(msg.content).toContain('<worker-report id="b" title="Worker b" why="done"');
    expect(msg.content).not.toContain('id="c"');
    // b's own check finds its settle already told.
    expect(await tell(ctx, "b")).toEqual({ told: 0, reason: "already" });
    expect(wakes(tables)).toHaveLength(1);
  });

  test("rows that report elsewhere, a newer status, and a killed parent tell nobody", async () => {
    const cases: Array<[any, any, Record<string, any>, number | undefined, string]> = [
      [worker("a", { agent_task_id: "agent_tasks_x" }), session("a", "idle"), {}, STATUS_TS, "not_worker"],
      [worker("a", { org_role_id: "org_roles_x" }), session("a", "idle"), {}, STATUS_TS, "not_worker"],
      [worker("a", { is_workflow_sub: true }), session("a", "idle"), {}, STATUS_TS, "not_worker"],
      [worker("a"), session("a", "idle", STATUS_TS + 1), {}, STATUS_TS, "superseded"],
      [worker("a"), session("a", "idle"), { inbox_killed_at: NOW - 1 }, STATUS_TS, "no_parent"],
    ];
    for (const [w, s, parent, ts, reason] of cases) {
      const { ctx, tables } = world([w], [s], parent);
      expect(await tell(ctx, "a", ts)).toEqual({ told: 0, reason });
      expect(wakes(tables)).toHaveLength(0);
    }
  });

  test("a native subagent (no managed session of its own) is never told about", async () => {
    const { ctx, tables } = world([worker("a"), worker("native")], [session("a", "idle")]);
    await tell(ctx, "a");
    expect(wakes(tables)[0].content).not.toContain("native");
  });

  test("only spawned workers schedule the check", async () => {
    const { ctx, scheduled } = world([worker("a"), worker("run", { agent_task_id: "agent_tasks_x" })], []);
    await scheduleWorkerSettle(ctx, "conversations_a" as any, STATUS_TS);
    await scheduleWorkerSettle(ctx, "conversations_run" as any, STATUS_TS);
    await scheduleWorkerSettle(ctx, PARENT as any, STATUS_TS);
    expect(scheduled.map((s) => s.args.conversation_id)).toEqual(["conversations_a"]);
  });
});
