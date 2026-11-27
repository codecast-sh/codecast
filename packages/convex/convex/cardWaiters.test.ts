// A card other work waits on reaches a person fast (lib/cardWaiters.ts,
// pl-1146 piece 2): at two waiting changes it is escalated to the people it
// was asked of with the count as its note, and they get one push; more
// waiters update the count without another push until the next threshold.
// The incident case runs end to end: two runs stop the same way, their tasks
// wait on the cause, and the fix's approval card on the cause escalates.
// Synthetic data, under convex-test.
import { describe, expect, test } from "bun:test";
import { convexTest } from "convex-test";
import { anyApi } from "convex/server";
import schema from "./schema";
import { allModules } from "./testModules.testkit";
import { hashToken } from "./apiTokens";
import { askCore } from "./sessionDecisions";
import { addDepCore } from "./tasks";
import { addWaitCore } from "./taskWaits";
import { postApprovalCard } from "./lib/changeApprovalCards";
import { cardWaiters } from "./lib/cardWaiters";

const api = anyApi as any;
const TOKEN = "w".repeat(64);
const T0 = Date.now();

async function world() {
  const t = convexTest(schema, allModules);
  const ids = await t.run(async (ctx: any) => {
    const me = await ctx.db.insert("users", { name: "Ana", push_token: "ExponentPushToken[x]", notifications_enabled: true });
    await ctx.db.insert("api_tokens", { user_id: me, token_hash: await hashToken(TOKEN), name: "cli", created_at: T0, last_used_at: T0 });
    const team = await ctx.db.insert("teams", { name: "Acme", created_at: T0 });
    await ctx.db.insert("team_memberships", { user_id: me, team_id: team, role: "member", joined_at: T0 });
    const conv = await ctx.db.insert("conversations", {
      user_id: me, team_id: team, session_id: "sess-fix", agent_type: "claude_code", status: "active", message_count: 1, started_at: T0, updated_at: T0, git_remote_url: "git@github.com:acme/app.git",
    });
    return { me, team, ws: `team:${team}`, conv };
  });
  const task = (short_id: string) => t.run((ctx: any) => ctx.db.insert("tasks", {
    user_id: ids.me, team_id: ids.team, workspace: ids.ws, short_id, title: short_id, status: "in_progress", task_type: "task", priority: "medium", source: "human", created_at: T0, updated_at: T0,
  }));
  const ask = async (taskRef?: string) => {
    const r = await t.run((ctx: any) => askCore(ctx, { userId: ids.me }, { session_id: "sess-fix", question: "Ship the fix?", options: [{ label: "Ship" }, { label: "Hold" }], category: "approach", ...(taskRef ? { task: taskRef } : {}) }));
    expect(r.error).toBeUndefined();
    return r as { id: any; short_id: string };
  };
  const blockOn = (dep: string, blocker: string) => t.run((ctx: any) => addDepCore(ctx, ids.me, { short_id: dep, blocked_by: blocker }));
  const get = (id: any) => t.run((ctx: any) => ctx.db.get(id));
  /** The escalation notices (bell row and phone push) codecast sent. */
  const notices = () => t.run(async (ctx: any) => ({
    bell: (await ctx.db.query("notifications").collect()).filter((n: any) => n.type === "decision_escalated"),
    push: (await ctx.db.query("push_outbox").collect()).filter((r: any) => r.type === "decision_escalated"),
  }));
  return { t, ids, task, ask, blockOn, get, notices };
}

describe("a card two changes wait on is escalated to its people", () => {
  test("two tasks blocked by the card's task: escalated with the count, one push naming it", async () => {
    const { ids, task, ask, blockOn, get, notices } = await world();
    await task("ct-1");
    await task("ct-2");
    await task("ct-3");
    const card = await ask("ct-1");
    await blockOn("ct-2", "ct-1");
    expect(((await get(card.id)) as any).escalated).toBeUndefined();
    await blockOn("ct-3", "ct-1");
    const row: any = await get(card.id);
    expect(row.escalated).toMatchObject({ note: "2 changes wait on this", waiting: 2, to: [ids.me] });
    expect(row.escalated.by).toBeUndefined();
    // Who may answer is unchanged.
    expect(row.asked_user_ids).toEqual([ids.me]);
    const { bell, push } = await notices();
    expect(bell).toHaveLength(1);
    expect(bell[0]).toMatchObject({ recipient_user_id: ids.me, message: '2 changes wait on this: "Ship the fix?"', link: `/decisions/${card.short_id}` });
    expect(push).toHaveLength(1);
    expect(push[0].body).toContain("2 changes wait on this");
  });

  test("a third waiter updates the count without pushing again; the fifth pushes once more", async () => {
    const { task, ask, blockOn, get, notices } = await world();
    for (const s of ["ct-1", "ct-2", "ct-3", "ct-4", "ct-5", "ct-6"]) await task(s);
    const card = await ask("ct-1");
    await blockOn("ct-2", "ct-1");
    await blockOn("ct-3", "ct-1");
    await blockOn("ct-4", "ct-1");
    expect(((await get(card.id)) as any).escalated).toMatchObject({ note: "3 changes wait on this", waiting: 3 });
    expect((await notices()).push).toHaveLength(1);
    // The same edge again changes nothing.
    await blockOn("ct-4", "ct-1");
    expect((await notices()).push).toHaveLength(1);
    await blockOn("ct-5", "ct-1");
    await blockOn("ct-6", "ct-1");
    expect(((await get(card.id)) as any).escalated).toMatchObject({ note: "5 changes wait on this", waiting: 5 });
    expect((await notices()).push).toHaveLength(2);
  });

  test("a card one change waits on stays as it was", async () => {
    const { task, ask, blockOn, get, notices } = await world();
    await task("ct-1");
    await task("ct-2");
    const card = await ask("ct-1");
    await blockOn("ct-2", "ct-1");
    expect(((await get(card.id)) as any).escalated).toBeUndefined();
    expect((await notices()).bell).toHaveLength(0);
  });

  test("a card asked on a task two changes already wait on escalates as it is asked", async () => {
    const { task, ask, blockOn, get, notices } = await world();
    for (const s of ["ct-1", "ct-2", "ct-3"]) await task(s);
    await blockOn("ct-2", "ct-1");
    await blockOn("ct-3", "ct-1");
    const card = await ask("ct-1");
    expect(((await get(card.id)) as any).escalated).toMatchObject({ waiting: 2 });
    expect((await notices()).push).toHaveLength(1);
  });

  test("tasks waiting on the card itself count, and closed ones do not", async () => {
    const { t, ids, task, ask, blockOn, get, notices } = await world();
    for (const s of ["ct-1", "ct-2", "ct-3"]) await task(s);
    const closed = await task("ct-4");
    const card = await ask();
    await t.run((ctx: any) => ctx.db.patch(closed, { status: "done" }));
    await t.run((ctx: any) => addWaitCore(ctx, ids.me, "ct-4", { target: { kind: "decision", decision: card.short_id } }));
    await t.run((ctx: any) => addWaitCore(ctx, ids.me, "ct-2", { target: { kind: "decision", decision: card.short_id } }));
    expect(((await get(card.id)) as any).escalated).toBeUndefined();
    await t.run((ctx: any) => addWaitCore(ctx, ids.me, "ct-3", { target: { kind: "decision", decision: card.short_id } }));
    expect(((await get(card.id)) as any).escalated).toMatchObject({ note: "2 changes wait on this", waiting: 2 });
    expect((await notices()).push).toHaveLength(1);
    expect(await t.run(async (ctx: any) => cardWaiters(ctx, await ctx.db.get(card.id)))).toBe(2);
    void blockOn;
  });

  test("a person's escalation keeps their note", async () => {
    const { t, ids, task, ask, blockOn, get, notices } = await world();
    for (const s of ["ct-1", "ct-2", "ct-3"]) await task(s);
    const card = await ask("ct-1");
    const mine = { by: ids.me, at: T0, note: "Needs a call today", to: [ids.me] };
    await t.run((ctx: any) => ctx.db.patch(card.id, { escalated: mine }));
    await blockOn("ct-2", "ct-1");
    await blockOn("ct-3", "ct-1");
    expect(((await get(card.id)) as any).escalated).toEqual(mine);
    expect((await notices()).bell).toHaveLength(0);
  });
});

// The incident end to end: Union's change shape, where every failure of the land segment routes to one `stopped` exit.
const node = (id: string, type: string, label = id) => ({ id, label, shape: "box", type });
const GRAPH = {
  nodes: [node("start", "start"), node("land__pr", "command"), node("land__ci", "command", "CI"), node("stopped", "exit", "Not merged"), node("exit", "exit")],
  edges: [],
};

describe("an incident's fix reaches a person fast", () => {
  test("two runs stopped by one cause: the approval card on the cause escalates once, naming both", async () => {
    const { t, ids, task, get, notices } = await world();
    const { wf, runs } = await t.run(async (ctx: any) => {
      await ctx.db.insert("org_roles", { name: "Release", handle: "release", host_user_id: ids.me, team_id: ids.team, scope: { project_ids: [], plan_ids: [] }, status: "active", created_at: T0, updated_at: T0 });
      const wf = await ctx.db.insert("workflows", { user_id: ids.me, name: "change", slug: "change", label: "Change", ...GRAPH, created_at: T0, updated_at: T0 });
      return { wf, runs: [] as any[] };
    });
    const run = (taskId: any) => t.run((ctx: any) => ctx.db.insert("workflow_runs", {
      user_id: ids.me, workflow_id: wf, task_id: taskId, workspace: ids.ws, team_id: ids.team, status: "running", current_node_id: "land__pr",
      node_statuses: [], spawner_conversation_id: ids.conv, primary_conversation_id: ids.conv, runner_device: "laptop", created_at: T0, updated_at: T0,
    }));
    runs.push(await run(await task("ct-901")), await run(await task("ct-902")));
    const report = (runId: any, body: Record<string, unknown>) => t.mutation(api.workflow_runs.updateProgress, { api_token: TOKEN, run_id: runId, ...body });
    const stop = async (runId: any) => {
      await report(runId, { current_node_id: "land__ci", node_id: "land__ci", node_status: "running" });
      await report(runId, { current_node_id: "land__ci", node_id: "land__ci", node_status: "failed", outcome: "failure" });
      await report(runId, { current_node_id: "stopped", node_id: "stopped", node_status: "failed", run_status: "failed", fail_reason: "Stopped: CI failed 3 times." });
      await new Promise((done) => setTimeout(done, 20));
      await t.finishInProgressScheduledFunctions();
    };

    await stop(runs[0]);
    const causeOf = async () => {
      const r: any = await get(runs[0]);
      const sig = await t.run((ctx: any) => ctx.db.query("signals").withIndex("by_workspace_fingerprint", (q: any) => q.eq("workspace", ids.ws).eq("fingerprint", r.stop_fingerprint)).first());
      return (await get(sig.task_id)) as any;
    };
    const cause = await causeOf();
    // The fix, shipped on the cause, waits for a person's approval before any run is held by it.
    const fixRun = await run(cause._id);
    const posted = await t.run(async (ctx: any) => postApprovalCard(ctx, {
      repository: "acme/app", pr_number: 7, head_sha: "a".repeat(40), key: "k1", judged: [], reason: "judged",
      to: { user_id: ids.me, name: "Ana" }, run: await ctx.db.get(fixRun), pr: null, title: "Fix CI", now: Date.now(), words: "Looks right.",
    }));
    expect(posted).not.toBeNull();
    expect(((await get(posted!.card_id)) as any).escalated).toBeUndefined();

    await stop(runs[1]);
    expect(((await get(runs[1])) as any).incident_task_id).toEqual(cause._id);
    const card: any = await get(posted!.card_id);
    expect(card.escalated).toMatchObject({ note: "2 changes wait on this", waiting: 2, to: [ids.me] });
    // Still the person's to approve: nobody else was asked.
    expect(card.approval.asked).toEqual([ids.me]);
    const { bell, push } = await notices();
    expect(bell).toHaveLength(1);
    expect(push).toHaveLength(1);
  });
});
