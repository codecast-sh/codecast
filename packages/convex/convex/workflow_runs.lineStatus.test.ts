// Status follows the line (docs/architecture/the-line-end-to-end.md LE16):
// a run's end never writes over a status the line already decided, every
// status the line writes lands in the task's history through the one status
// path, and the people who answer for a cause hear about a card waiting, a
// ship and a reopen. Run through the real mutations under convex-test.
import { describe, expect, test } from "bun:test";
import { convexTest } from "convex-test";
import { anyApi } from "convex/server";
import schema from "./schema";
import { hashToken } from "./apiTokens";
import { repairedClosedAt, repairedLineStatus, runEndStatus } from "./workflow_runs";

const api = anyApi as any;
const internal = anyApi as any;
const TOKEN = "l".repeat(64);
const T0 = 1_790_000_000_000;

const modules = {
  "./_generated/server.ts": () => import("./_generated/server"),
  "./syncOutbox.ts": () => import("./syncOutbox"),
  "./workflow_runs.ts": () => import("./workflow_runs"),
  "./tasks.ts": () => import("./tasks"),
  "./notificationRouter.ts": () => import("./notificationRouter"),
  "./sessionDecisions.ts": () => import("./sessionDecisions"),
  "./issueSync.ts": () => import("./issueSync"),
};

const node = (node_id: string, at: number, status = "completed") => ({ node_id, status, outcome: "success", started_at: at - 1000, completed_at: at });
const lineNodes = (...ends: string[]) => [node("start", T0), node("ground", T0 + 1), ...ends.map((id, i) => node(id, T0 + 10 + i))];

async function setup(task: Record<string, any>, run: Record<string, any> = {}) {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const owner = await ctx.db.insert("users", { name: "Founder", notification_preferences: { task_status_changes: true } } as any);
    const mate = await ctx.db.insert("users", { name: "Mate" } as any);
    await ctx.db.insert("api_tokens", { user_id: owner, token_hash: await hashToken(TOKEN), name: "cli", created_at: T0, last_used_at: T0 } as any);
    const workspace = `user:${owner}`;
    const conv = await ctx.db.insert("conversations", { user_id: owner, session_id: "sess-line", agent_type: "claude_code", status: "active", started_at: T0, updated_at: T0, message_count: 1 } as any);
    const taskId = await ctx.db.insert("tasks", {
      user_id: owner, workspace, short_id: "ct-1", title: "Checkout throws", status: "in_progress", task_type: "task", priority: "medium",
      source: "signal", created_at: T0, updated_at: T0, ...task,
    } as any);
    const runId = await ctx.db.insert("workflow_runs", {
      user_id: owner, workspace, task_id: taskId, workflow_name: "line", status: "running", node_statuses: lineNodes(),
      spawner_conversation_id: conv, created_at: T0, updated_at: T0, ...run,
    } as any);
    await ctx.db.patch(taskId, { workflow_run_id: runId } as any);
    return { owner, mate, taskId, runId, conv };
  });
  const end = (node_statuses: any[]) => t.run(async (ctx) => { await ctx.db.patch(ids.runId, { node_statuses } as any); });
  const finish = (run_status: "completed" | "failed" = "completed") =>
    t.mutation(api.workflow_runs.updateProgress, { api_token: TOKEN, run_id: ids.runId, current_node_id: "exit", node_id: "exit", node_status: "completed", run_status });
  const read = () => t.run(async (ctx) => ({
    task: (await ctx.db.get(ids.taskId)) as any,
    history: (await ctx.db.query("task_history").collect()).filter((h: any) => h.field === "status"),
    notes: (await ctx.db.query("notifications").collect()) as any[],
  }));
  return { t, ids, end, finish, read };
}

describe("a run's end (LE16)", () => {
  test("ship: the cause becomes done through the status path, and its people hear", async () => {
    const { t, ids, end, finish, read } = await setup({ status: "in_review" });
    await t.run(async (ctx) => { await ctx.db.patch(ids.taskId, { assignee: String(ids.mate), watch_until: T0 + 7 * 86_400_000 } as any); });
    await end(lineNodes("decide", "ship", "watch"));
    await finish();
    const { task, history, notes } = await read();
    expect(task.status).toBe("done");
    expect(task.closed_at).toBeGreaterThan(T0);
    expect(task.watch_until).toBe(T0 + 7 * 86_400_000);
    expect(history.map((h: any) => [h.old_value, h.new_value])).toEqual([["in_review", "done"]]);
    const shipped = notes.filter((n) => n.type === "change_shipped");
    expect(shipped.map((n) => String(n.recipient_user_id)).sort()).toEqual([String(ids.owner), String(ids.mate)].sort());
    expect(shipped[0].message).toContain("shipped the change for ct-1");
    // A second report of the same end changes nothing and says nothing again.
    await finish();
    expect((await read()).notes.filter((n) => n.type === "change_shipped")).toHaveLength(2);
  });

  test("drop and dissolve: the status the station wrote stands", async () => {
    for (const [station, status] of [["drop", "dropped"], ["dissolve", "done"]] as const) {
      const { end, finish, read } = await setup({ status, closed_at: T0 + 5 });
      await end(lineNodes(station));
      await finish();
      const { task, history } = await read();
      expect(task.status).toBe(status);
      expect(task.closed_at).toBe(T0 + 5);
      expect(history).toHaveLength(0);
    }
  });

  test("park: the cause goes back to open to wait for admission", async () => {
    const { end, finish, read } = await setup({ status: "in_progress" });
    await end(lineNodes("park"));
    await finish();
    const { task, history } = await read();
    expect(task.status).toBe("open");
    expect(history.map((h: any) => h.new_value)).toEqual(["open"]);
  });

  test("review reject: the open the verdict wrote stands", async () => {
    const { end, finish, read } = await setup({ status: "open", review_verdict: { verdict: "reject", at: T0 } });
    await end(lineNodes("review"));
    await finish();
    expect((await read()).task.status).toBe("open");
  });

  test("another workflow's completed run hands the work to review, with history", async () => {
    const { end, finish, read } = await setup({ status: "in_progress", source: undefined });
    await end([node("start", T0), node("implement", T0 + 1)]);
    await finish();
    const { task, history } = await read();
    expect(task.status).toBe("in_review");
    expect(history.map((h: any) => h.new_value)).toEqual(["in_review"]);
  });

  test("a failed run blocks the task and leaves its status", async () => {
    const { finish, read } = await setup({ status: "in_progress" });
    await finish("failed");
    const { task } = await read();
    expect(task).toMatchObject({ status: "in_progress", execution_status: "blocked" });
  });
});

describe("the gate (LE11, LE16)", () => {
  test("a card waiting moves the cause to review with history and tells the person holding it", async () => {
    const { t, ids, read } = await setup({ status: "in_progress" });
    const out = await t.mutation(api.workflow_runs.pauseAtGate, {
      api_token: TOKEN, run_id: ids.runId, node_id: "decide", prompt: "Ship this change?",
      choices: [{ key: "S", label: "[S] Ship", target: "ship" }, { key: "D", label: "[D] Drop", target: "drop" }],
    });
    expect(out.decision_short_id).toBeTruthy();
    const { task, history, notes } = await read();
    expect(task.status).toBe("in_review");
    expect(history.map((h: any) => [h.old_value, h.new_value])).toEqual([["in_progress", "in_review"]]);
    const waiting = notes.filter((n) => n.type === "card_waiting");
    expect(waiting).toHaveLength(1);
    expect(String(waiting[0].recipient_user_id)).toBe(String(ids.owner));
    expect(waiting[0].link).toBe(`/decisions/${out.decision_short_id}`);
  });

  test("the notice names the change by the card's headline, with the cause's id", async () => {
    const { t, ids, read } = await setup({ status: "in_progress" });
    await t.mutation(api.workflow_runs.pauseAtGate, {
      api_token: TOKEN, run_id: ids.runId, node_id: "decide", prompt: "Ship this change?",
      choices: [{ key: "S", label: "[S] Ship", target: "ship" }, { key: "D", label: "[D] Drop", target: "drop" }],
      // Not a whole card: the gate asks without it, and the headline still names the change.
      card: { headline: "Follow-ups lead with the question" },
    });
    const { notes } = await read();
    const waiting = notes.filter((n) => n.type === "card_waiting");
    expect(waiting).toHaveLength(1);
    expect(waiting[0].message).toContain("Follow-ups lead with the question (ct-1)");
  });

  const askCard = (t: any, runId: any) => t.mutation(api.workflow_runs.pauseAtGate, {
    api_token: TOKEN, run_id: runId, node_id: "decide", prompt: "Ship this change?",
    choices: [{ key: "S", label: "[S] Ship", target: "ship" }, { key: "D", label: "[D] Drop", target: "drop" }],
  });
  const waitingUnread = async (read: () => Promise<{ notes: any[] }>) =>
    (await read()).notes.filter((n) => n.type === "card_waiting" && !n.read);

  test("a card withdrawn with its run leaves no card waiting notice behind", async () => {
    const { t, ids, read } = await setup({ status: "in_progress" });
    await askCard(t, ids.runId);
    expect(await waitingUnread(read)).toHaveLength(1);
    // Dropping the cause cancels the run, which withdraws its open card.
    await t.mutation(api.tasks.update, { api_token: TOKEN, short_id: "ct-1", status: "dropped" });
    const decision = await t.run(async (ctx) => (await ctx.db.query("session_decisions").first()) as any);
    expect(decision.status).toBe("withdrawn");
    expect(await waitingUnread(read)).toHaveLength(0);
  });

  test("a runner stopped at its card fails the run and withdraws the card with it", async () => {
    const { t, ids, read } = await setup({ status: "in_progress" });
    await askCard(t, ids.runId);
    // What the runner sends on SIGINT/SIGTERM while it waits at the gate.
    await t.mutation(api.workflow_runs.updateProgress, {
      api_token: TOKEN, run_id: ids.runId, current_node_id: "decide", node_id: "decide",
      node_status: "failed", run_status: "failed", fail_reason: "the runner was stopped (SIGINT) at decide",
    });
    const decision = await t.run(async (ctx) => (await ctx.db.query("session_decisions").first()) as any);
    expect(decision.status).toBe("withdrawn");
    expect(await waitingUnread(read)).toHaveLength(0);
    const run = await t.run(async (ctx) => (await ctx.db.get(ids.runId)) as any);
    expect(run.fail_reason).toBe("the runner was stopped (SIGINT) at decide");
  });

  test("a card answered somewhere other than the notice settles the notice too", async () => {
    const { t, ids, read } = await setup({ status: "in_progress" });
    await askCard(t, ids.runId);
    const other = await t.run(async (ctx) => ctx.db.insert("notifications", {
      recipient_user_id: ids.owner, type: "card_waiting", entity_type: "task", entity_id: String(ids.taskId),
      link: "/decisions/someone-else", message: "another card", read: false, created_at: T0,
    } as any));
    await t.mutation(api.workflow_runs.respondToGateFromCli, { api_token: TOKEN, run_id: ids.runId, response: "S" });
    const unread = await waitingUnread(read);
    // Only this card's notice settles; another card's stays.
    expect(unread.map((n) => String(n._id))).toEqual([String(other)]);
  });

  test("a review approve inside a live line run leaves the cause in review: the run decides done", async () => {
    const { t, ids, read } = await setup({ status: "in_progress" });
    await t.mutation(api.tasks.update, { api_token: TOKEN, short_id: "ct-1", status: "done", review_verdict: "approve" });
    const { task } = await read();
    expect(task.status).toBe("in_review");
    expect(task.review_verdict?.verdict).toBe("approve");
    // Once the run is over, an approve closes as it always did.
    await t.run(async (ctx) => { await ctx.db.patch(ids.runId, { status: "completed" } as any); });
    await t.mutation(api.tasks.update, { api_token: TOKEN, short_id: "ct-1", status: "done", review_verdict: "approve" });
    expect((await read()).task.status).toBe("done");
  });
});

describe("a person's status wins (LM3)", () => {
  test("dropping a cause stops its live run and withdraws nothing it should keep", async () => {
    const { t, ids, read } = await setup({ status: "in_progress" }, { current_node_id: "implement" });
    await t.mutation(api.tasks.update, { api_token: TOKEN, short_id: "ct-1", status: "dropped" });
    const run = await t.run(async (ctx) => (await ctx.db.get(ids.runId)) as any);
    expect(run).toMatchObject({ status: "failed", fail_reason: "Stopped: the cause was dropped by a person" });
    expect((await read()).task.status).toBe("dropped");
  });

  test("the line's own drop station does not stop the run that is dropping", async () => {
    const { t, ids } = await setup({ status: "in_review" }, { current_node_id: "drop" });
    await t.mutation(api.tasks.update, { api_token: TOKEN, short_id: "ct-1", status: "dropped" });
    const run = await t.run(async (ctx) => (await ctx.db.get(ids.runId)) as any);
    expect(run.status).toBe("running");
  });

  test("a session's close is not a person's: the run goes on", async () => {
    const { t, ids } = await setup({ status: "in_progress" }, { current_node_id: "implement" });
    await t.mutation(api.tasks.update, { api_token: TOKEN, short_id: "ct-1", status: "dropped", conversation_id: "sess-line" });
    const run = await t.run(async (ctx) => (await ctx.db.get(ids.runId)) as any);
    expect(run.status).toBe("running");
  });
});

describe("the repair (LE16)", () => {
  test("moves causes the old run end left in review, dry run first", async () => {
    const { t, ids, end, read } = await setup({ status: "in_review", closed_at: T0 + 2 }, { status: "completed" });
    await end(lineNodes("decide", "ship", "watch"));
    const dry = await t.mutation(internal.workflow_runs.repairLineCauseStatus, { dry_run: true });
    expect(dry.moved).toEqual([{ task: "ct-1", from: "in_review", to: "done" }]);
    expect((await read()).task.status).toBe("in_review");
    const applied = await t.mutation(internal.workflow_runs.repairLineCauseStatus, { dry_run: false });
    expect(applied.moved).toHaveLength(1);
    const { task, history } = await read();
    expect(task.status).toBe("done");
    // Closed when the run shipped (watch completed at T0 + 12), not when the repair ran.
    expect(task.closed_at).toBe(T0 + 12);
    expect(history.map((h: any) => [h.old_value, h.new_value])).toEqual([["in_review", "done"]]);
    // Run again: nothing left to move.
    expect((await t.mutation(internal.workflow_runs.repairLineCauseStatus, { dry_run: false })).moved).toEqual([]);
    void ids;
  });

  test("a status a person moved after the run ended stands", async () => {
    const { t, ids, end } = await setup({ status: "in_review" }, { status: "completed", updated_at: T0 + 100 });
    await end(lineNodes("park"));
    await t.run(async (ctx) => {
      await ctx.db.insert("task_history", { task_id: ids.taskId, user_id: ids.owner, actor_type: "user", action: "updated", field: "status", old_value: "open", new_value: "in_review", created_at: T0 + 200 } as any);
    });
    const out = await t.mutation(internal.workflow_runs.repairLineCauseStatus, { dry_run: true });
    expect(out).toMatchObject({ moved: [], skipped: 1 });
  });
});

describe("the repair restamps its own close (LE16)", () => {
  test("a cause the first pass closed at repair time gets the ship's time", async () => {
    const repairAt = T0 + 50_000_000;
    const { t, ids, end, read } = await setup({ status: "done", closed_at: repairAt }, { status: "completed", updated_at: T0 + 100 });
    await end(lineNodes("decide", "ship", "watch"));
    await t.run(async (ctx) => {
      await ctx.db.insert("task_history", { task_id: ids.taskId, user_id: ids.owner, actor_type: "system", action: "updated", field: "status", old_value: "in_review", new_value: "done", created_at: repairAt } as any);
    });
    const dry = await t.mutation(internal.workflow_runs.repairLineCauseStatus, { dry_run: true });
    expect(dry.restamped).toEqual([{ task: "ct-1", from: repairAt, to: T0 + 12 }]);
    await t.mutation(internal.workflow_runs.repairLineCauseStatus, { dry_run: false });
    expect((await read()).task.closed_at).toBe(T0 + 12);
    expect((await t.mutation(internal.workflow_runs.repairLineCauseStatus, { dry_run: true })).restamped).toEqual([]);
  });

  test("a person's close stands", () => {
    const run = { status: "completed", updated_at: T0 + 100, node_statuses: lineNodes("watch") };
    const at = T0 + 50_000_000;
    expect(repairedClosedAt({ status: "done", closed_at: at }, run, [{ created_at: at, new_value: "done", actor_type: "user" }])).toBeNull();
    expect(repairedClosedAt({ status: "done", closed_at: at }, run, [{ created_at: at, new_value: "done", actor_type: "system" }])).toBe(T0 + 10);
    expect(repairedClosedAt({ status: "done", closed_at: T0 + 20 }, run, [{ created_at: T0 + 20, new_value: "done" }])).toBeNull();
  });
});

describe("runEndStatus and repairedLineStatus", () => {
  const nodes = (...ends: string[]) => lineNodes(...ends);
  test("never overwrites done or dropped", () => {
    expect(runEndStatus("done", "completed", nodes("watch"))).toBeNull();
    expect(runEndStatus("dropped", "completed", nodes())).toBeNull();
  });
  test("ship is done, park is open, a still working run goes to review, anything else stands", () => {
    expect(runEndStatus("in_review", "completed", nodes("watch"))).toBe("done");
    expect(runEndStatus("in_progress", "completed", nodes("park"))).toBe("open");
    expect(runEndStatus("in_progress", "completed", nodes())).toBe("in_review");
    expect(runEndStatus("open", "completed", nodes("review"))).toBeNull();
    expect(runEndStatus("in_progress", "failed", nodes("watch"))).toBeNull();
  });
  test("the repair reads what the run decided", () => {
    const run = (...ends: string[]) => ({ status: "completed", node_statuses: nodes(...ends) });
    expect(repairedLineStatus({ status: "in_review" }, run("watch"))).toBe("done");
    expect(repairedLineStatus({ status: "in_review" }, run("dissolve"))).toBe("done");
    expect(repairedLineStatus({ status: "in_review" }, run("drop"))).toBe("dropped");
    expect(repairedLineStatus({ status: "in_review" }, run("park"))).toBe("open");
    expect(repairedLineStatus({ status: "in_review", review_verdict: { verdict: "reject" } }, run("review"))).toBe("open");
    expect(repairedLineStatus({ status: "in_review" }, run("review"))).toBeNull();
    expect(repairedLineStatus({ status: "open" }, run("watch"))).toBeNull();
  });
});
