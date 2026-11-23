// conversations.parked_wake_kind through the real mutations, not the wrapper
// alone (parkedWake.test.ts): a run started and cancelled from the CLI, a task
// bound, blocked, unblocked and closed, and a wait set on a task the session
// does not hold (lib/parkedWake.ts, functions.ts).
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { convexTest } from "convex-test";
import { anyApi } from "convex/server";
import schema from "./schema";
import { hashToken } from "./apiTokens";
import { allModules } from "./testModules.testkit";

setDefaultTimeout(60_000);

const api = anyApi as any;
const internal = anyApi as any;
const TOKEN = "t".repeat(64);
const SESSION = "sess-s";
const OTHER = "sess-o";

async function setup() {
  const t = convexTest(schema, allModules);
  const ids = await t.run(async (ctx: any) => {
    const user = await ctx.db.insert("users", { name: "Me" } as any);
    await ctx.db.insert("api_tokens", { user_id: user, token_hash: await hashToken(TOKEN), name: "cli", created_at: 0, last_used_at: 0 } as any);
    const conv = await ctx.db.insert("conversations", {
      user_id: user, agent_type: "claude_code", session_id: SESSION, short_id: "jxsess1", title: "s",
      started_at: 1, updated_at: 1, status: "active", message_count: 0,
    } as any);
    await ctx.db.insert("conversations", {
      user_id: user, agent_type: "claude_code", session_id: OTHER, short_id: "jxother", title: "o",
      started_at: 1, updated_at: 1, status: "active", message_count: 0,
    } as any);
    return { user, conv };
  });
  const cli = { api_token: TOKEN };
  const kind = () => t.run(async (ctx: any) => (await ctx.db.get(ids.conv)).parked_wake_kind ?? "none");
  const task = async (title: string) => (await t.mutation(api.tasks.create, { ...cli, title, workspace: "personal" })).short_id as string;
  /** `cast task start` from the session: binds it as active_task_id. */
  const start = (shortId: string, session = SESSION) => t.mutation(api.tasks.update, { ...cli, short_id: shortId, status: "in_progress", conversation_id: session });
  return { t, ...ids, cli, kind, task, start };
}

describe("parked_wake_kind through the real mutations", () => {
  test("a run started from the CLI parks its spawner until it is cancelled", async () => {
    const s = await setup();
    const r = await s.t.mutation(api.workflow_runs.createFromCli, { ...s.cli, workflow_name: "change", spawner_session: SESSION });
    expect(await s.kind()).toBe("run");
    await s.t.mutation(api.workflow_runs.cancelFromCli, { ...s.cli, run_id: r.run_id });
    expect(await s.kind()).toBe("none");
  });

  test("a run on the task the session holds parks it", async () => {
    const s = await setup();
    const a = await s.task("A");
    await s.start(a);
    const r = await s.t.mutation(api.workflow_runs.createFromCli, { ...s.cli, workflow_name: "change", spawner_session: SESSION, task_id: a });
    expect(await s.kind()).toBe("run");
    await s.t.mutation(api.workflow_runs.cancelFromCli, { ...s.cli, run_id: r.run_id });
    expect(await s.kind()).toBe("none");
  });

  test("a dep on the held task parks it; the blocker closing clears it", async () => {
    const s = await setup();
    const a = await s.task("A");
    const b = await s.task("B");
    // Another session holds B: its blocker stamp is exact.
    await s.start(b, OTHER);
    await s.start(a);
    expect(await s.kind()).toBe("none");
    await s.t.mutation(api.tasks.addDep, { ...s.cli, short_id: a, blocked_by: b, conversation_id: SESSION });
    expect(await s.kind()).toBe("blocker");
    await s.t.mutation(api.tasks.update, { ...s.cli, short_id: b, status: "done" });
    expect(await s.kind()).toBe("none");
  });

  test("removing the dep clears it", async () => {
    const s = await setup();
    const a = await s.task("A");
    const b = await s.task("B");
    await s.start(a);
    await s.t.mutation(api.tasks.addDep, { ...s.cli, short_id: a, blocked_by: b, conversation_id: SESSION });
    // Nobody holds B: closed only by a person or a lost webhook, so it parks
    // as a wait, with the wait's lifetime.
    expect(await s.kind()).toBe("wait");
    await s.t.mutation(api.tasks.removeDep, { ...s.cli, short_id: a, blocked_by: b, conversation_id: SESSION });
    expect(await s.kind()).toBe("none");
  });

  // The session holds C and sets a wait on A, which nothing ties to C: the
  // wait is its wake (parked_on_task_ids), so it parks until the wait is met.
  test("the setter of a wait on a task it does not hold parks until the wait is met", async () => {
    const s = await setup();
    const a = await s.task("A");
    const c = await s.task("C");
    await s.start(c);
    const res = await s.t.mutation(api.taskWaits.addWait, { ...s.cli, short_id: a, ref: "2h", conversation_id: SESSION, time_zone: "UTC" });
    expect(res).toMatchObject({ parked: true, wait: { state: "waiting", created_in: String(s.conv) } });
    const aId = await s.t.run(async (ctx: any) => (await ctx.db.query("tasks").withIndex("by_short_id", (q: any) => q.eq("short_id", a)).first())._id);
    expect(await s.t.run(async (ctx: any) => (await ctx.db.get(s.conv)).parked_on_task_ids)).toEqual([aId]);
    expect(await s.kind()).toBe("wait");
    // The clock reaches the wait's time: the settle the add scheduled.
    await s.t.mutation(internal.taskWaits.settleTimeWait, { task_id: aId, wait_id: res.wait.id, at: res.wait.at });
    expect(await s.kind()).toBe("none");
  });

  // A session that waits on two tasks stays parked on the first after setting
  // the second, and the list holds the newest PARKED_ON_CAP.
  test("waits on two tasks both count, and the list keeps the newest ten", async () => {
    const s = await setup();
    const held = await s.task("held");
    await s.start(held);
    const wait = (shortId: string, ref = "2h") => s.t.mutation(api.taskWaits.addWait, { ...s.cli, short_id: shortId, ref, conversation_id: SESSION, time_zone: "UTC" });
    const tasks: string[] = [];
    for (let i = 0; i < 11; i++) tasks.push(await s.task(`T${i}`));
    const first = await wait(tasks[0]);
    await wait(tasks[1]);
    const idOf = (sid: string) => s.t.run(async (ctx: any) => (await ctx.db.query("tasks").withIndex("by_short_id", (q: any) => q.eq("short_id", sid)).first())._id);
    // Settling the second leaves the first owed.
    const secondId = await idOf(tasks[1]);
    const second = (await s.t.run(async (ctx: any) => (await ctx.db.get(secondId)).waits))[0];
    await s.t.mutation(internal.taskWaits.settleTimeWait, { task_id: secondId, wait_id: second.id, at: second.at });
    expect(await s.kind()).toBe("wait");
    await s.t.mutation(internal.taskWaits.settleTimeWait, { task_id: await idOf(tasks[0]), wait_id: first.wait.id, at: first.wait.at });
    expect(await s.kind()).toBe("none");
    // A new wait on each of eleven tasks (a later time than the settled ones).
    for (const sid of tasks) await wait(sid, "3h");
    const list = await s.t.run(async (ctx: any) => (await ctx.db.get(s.conv)).parked_on_task_ids);
    expect(list).toEqual(await Promise.all(tasks.slice(1).map(idOf)));
  });
});
