// A wait wakes the session that set it (TG2), not only the session that holds
// its task: jx7cn1s held ct-99108, parked on a PR wait it set on ct-99107, and
// when the PR merged nobody woke it, because nobody held ct-99107.
import { describe, expect, test } from "bun:test";
import { convexTest } from "convex-test";
import { anyApi } from "convex/server";
import schema from "./schema";
import { hashToken } from "./apiTokens";
import { allModules } from "./testModules.testkit";
import { patchPullRequest } from "./prShepherd";

const api = anyApi as any;
const TOKEN = "s".repeat(64);
const REPO = "codecast-sh/codecast";

type Setup = {
  /** Who holds ct-7, the task waited on: nobody, the setter, or another session. */
  holderOfA?: "none" | "setter" | "other";
  setterKilled?: boolean;
  /** ct-7 is also blocked by the open task ct-9. */
  alsoBlockedByTask?: boolean;
  /** The setter's held task ct-8 lists ct-7 in blocked_by (jx7cn1s's shape). */
  heldWaitsOnA?: boolean;
};

async function setup({ holderOfA = "none", setterKilled = false, alsoBlockedByTask = false, heldWaitsOnA = false }: Setup = {}) {
  const t = convexTest(schema, allModules);
  const ids = await t.run(async (ctx) => {
    const user = await ctx.db.insert("users", { name: "Ana" } as any);
    await ctx.db.insert("api_tokens", { user_id: user, token_hash: await hashToken(TOKEN), name: "cli", created_at: 0, last_used_at: 0 } as any);
    const team = await ctx.db.insert("teams", { name: "Acme", created_at: 0, invite_code: "x" } as any);
    await ctx.db.insert("team_memberships", { user_id: user, team_id: team, role: "admin", joined_at: 0 } as any);
    const ws = `team:${team}`;
    const task = (short_id: string, extra: Record<string, unknown> = {}) =>
      ctx.db.insert("tasks", { user_id: user, team_id: team, workspace: ws, title: `Task ${short_id}`, short_id, status: "in_review", priority: "medium", source: "human", created_at: 0, updated_at: 0, ...extra } as any);
    if (alsoBlockedByTask) await task("ct-9", { status: "open", blocks: ["ct-7"] });
    const a = await task("ct-7", alsoBlockedByTask ? { blocked_by: ["ct-9"] } : {});
    const b = await task("ct-8", { status: "in_progress", ...(heldWaitsOnA ? { blocked_by: ["ct-7"] } : {}) });
    const c = await task("ct-10", { status: "in_progress" });
    const conv = async (session_id: string, holds: any, extra: Record<string, unknown> = {}) => {
      const id = await ctx.db.insert("conversations", { user_id: user, team_id: team, agent_type: "claude_code", session_id, title: session_id, short_id: `jx${session_id}`, started_at: 0, updated_at: 0, message_count: 0, status: "active", is_private: false, ...(holds ? { active_task_id: holds } : {}), ...extra } as any);
      if (holds) {
        const row = await ctx.db.get(holds);
        await ctx.db.patch(holds, { conversation_ids: [...((row as any).conversation_ids ?? []), id] } as any);
      }
      return id;
    };
    const setter = await conv("setter", holderOfA === "setter" ? a : b, setterKilled ? { inbox_killed_at: 1 } : {});
    const setter2 = await conv("setter2", c);
    const other = holderOfA === "other" ? await conv("other", a) : null;
    const planner = await conv("planner", null);
    const pr = (number: number) =>
      ctx.db.insert("pull_requests", { team_id: team, github_pr_id: number, repository: REPO, number, title: `PR ${number}`, body: "", state: "open", author_github_username: "ana", linked_session_ids: [], created_at: 0, updated_at: 0 } as any);
    return { team, a, setter, setter2, other, planner, pr108: await pr(108), pr109: await pr(109) };
  });

  const cli = { api_token: TOKEN };
  /** `cast task dep ct-7 --blocked-by <repo>#<n>` from a session (or a person's terminal). */
  const wait = (session: string | null = "setter", n = 108, suffix = "") =>
    t.mutation(api.taskWaits.addWait, { ...cli, short_id: "ct-7", ref: `${REPO}#${n}${suffix}`, ...(session ? { conversation_id: session } : {}) });
  /** The PR moves through its one writer, which schedules the settle; the
   *  settle runs here, as the scheduler would run it. */
  const movePr = async (state: "merged" | "closed", n = 108) => {
    const pr = n === 108 ? ids.pr108 : ids.pr109;
    await t.run((ctx) => patchPullRequest(ctx as any, pr, { state }));
    await t.mutation(api.taskWaits.settlePr, { pr_id: pr });
  };
  const wakes = async (conv: any) =>
    (await t.run(async (ctx) => (await ctx.db.query("pending_messages").collect()).filter((m) => String(m.conversation_id) === String(conv)))).map((m) => {
      expect(m.origin).toBe("scheduler");
      return m.content as string;
    });
  const waitsOf = (shortId = "ct-7") =>
    t.run(async (ctx) => ((await ctx.db.query("tasks").withIndex("by_short_id", (q) => q.eq("short_id", shortId)).first()) as any)?.waits ?? []);
  return { t, ids, cli, wait, movePr, wakes, waitsOf };
}

// The setter holds ct-8, which still lists ct-7 in blocked_by: the wait it set
// clearing is not ct-8's unblock, so it is told to stay parked on ct-7's close.
const PARK = "ct-8 still waits for ct-7 to close; you are woken as ct-8's owner when ct-8 is unblocked. Pin dormant naming ct-7 and end your turn.";
const UNBLOCKED_108 = `ct-7 ("Task ct-7") is unblocked: PR ${REPO}#108 merged. You set the wait on PR ${REPO}#108 on it, so continue the work that waited on it.`;
// Nobody holds ct-7 in the default setup, so no one else will replan it.
const REPLAN = "Replan your own work (ct-8). Nobody holds ct-7, so no one else will replan it.";
const NOBODY = "ct-8 still waits for ct-7 to close. Nobody holds ct-7. If its work is done, close it; otherwise pin blocked naming ct-7, since a person has to move it.";

describe("a wait wakes the session that set it", () => {
  test("a session waiting on a task it does not hold is woken once when the PR merges", async () => {
    const { t, ids, wait, movePr, wakes, waitsOf } = await setup();
    const res = await wait();
    expect(res.wait).toMatchObject({ state: "waiting", created_in: String(ids.setter) });
    await movePr("merged");
    // The settle reads the PR as it stands, so a repeat adds nothing.
    await t.mutation(api.taskWaits.settlePr, { pr_id: ids.pr108 });
    expect(await wakes(ids.setter)).toEqual([UNBLOCKED_108]);
    expect((await waitsOf())[0].setter_told_at).toBeNumber();
  });

  test("a wait met while another wait still blocks is told when the last one clears", async () => {
    const { ids, wait, movePr, wakes } = await setup();
    await wait("setter", 108);
    await wait("setter2", 109);
    await movePr("merged", 108);
    expect(await wakes(ids.setter)).toEqual([]);
    await movePr("merged", 109);
    expect(await wakes(ids.setter)).toEqual([`ct-7 ("Task ct-7") is unblocked: PR ${REPO}#109 merged. You set the wait on PR ${REPO}#108 on it, so continue the work that waited on it.`]);
    expect(await wakes(ids.setter2)).toHaveLength(1);
  });

  test("a wait met while a task still blocks is told when that edge is removed", async () => {
    const { t, ids, cli, wait, movePr, wakes } = await setup({ alsoBlockedByTask: true });
    await wait();
    await movePr("merged");
    expect(await wakes(ids.setter)).toEqual([]);
    await t.mutation(api.tasks.removeDep, { ...cli, short_id: "ct-7", blocked_by: "ct-9" });
    expect(await wakes(ids.setter)).toEqual([expect.stringMatching(/^ct-7 \("Task ct-7"\) is unblocked: .*You set the wait on PR codecast-sh\/codecast#108 on it/)]);
  });

  test("a setter is told once per wait, not again when the task is blocked and unblocked later", async () => {
    const { ids, wait, movePr, wakes } = await setup();
    await wait();
    await movePr("merged", 108);
    await wait(null, 109);
    await movePr("merged", 109);
    expect(await wakes(ids.setter)).toEqual([UNBLOCKED_108]);
  });

  test("a session holding the task records no setter and hears once, as its owner", async () => {
    const { ids, wait, movePr, wakes } = await setup({ holderOfA: "setter" });
    expect((await wait()).wait.created_in).toBeUndefined();
    await movePr("merged");
    expect(await wakes(ids.setter)).toEqual([expect.stringMatching(/Nothing it waits on is open any more/)]);
  });

  test("a session holding no task is wiring the graph and is not woken", async () => {
    const { ids, wait, movePr, wakes } = await setup();
    expect((await wait("planner")).wait.created_in).toBeUndefined();
    await movePr("merged");
    expect(await wakes(ids.planner)).toEqual([]);
  });

  test("a task created with a wait does not wake the session that created it", async () => {
    const { t, ids, cli, wakes, waitsOf } = await setup();
    await t.mutation(api.tasks.create, { ...cli, title: "Wired", workspace: "team", team_id: ids.team, waits: [`${REPO}#108`], conversation_id: "setter" });
    const created = await t.run(async (ctx) => (await ctx.db.query("tasks").collect()).find((r: any) => r.title === "Wired") as any);
    expect((await waitsOf(created.short_id))[0].created_in).toBeUndefined();
    await t.run((ctx) => patchPullRequest(ctx as any, ids.pr108, { state: "merged" }));
    await t.mutation(api.taskWaits.settlePr, { pr_id: ids.pr108 });
    expect(await wakes(ids.setter)).toEqual([]);
  });

  test("the owner and a different setter each hear once", async () => {
    const { ids, wait, movePr, wakes } = await setup({ holderOfA: "other" });
    await wait();
    await movePr("merged");
    expect(await wakes(ids.other)).toEqual([expect.stringMatching(/Nothing it waits on is open any more/)]);
    expect(await wakes(ids.setter)).toEqual([UNBLOCKED_108]);
  });

  test("a killed setter is not woken", async () => {
    const { ids, wait, movePr, wakes } = await setup({ setterKilled: true });
    await wait();
    await movePr("merged");
    expect(await wakes(ids.setter)).toEqual([]);
  });

  test("a PR closed without merging tells the setter its wait can no longer clear", async () => {
    const { ids, wait, movePr, wakes } = await setup();
    await wait();
    await movePr("closed");
    expect(await wakes(ids.setter)).toEqual([`ct-7 ("Task ct-7") is still blocked: PR ${REPO}#108 closed without merging, so the wait you set on it can no longer clear. ${REPLAN}`]);
  });

  test("a wait someone else removes tells its setter it is gone", async () => {
    const { t, ids, cli, wait, wakes } = await setup();
    await wait();
    await t.mutation(api.taskWaits.removeWait, { ...cli, short_id: "ct-7", ref: `${REPO}#108` });
    expect(await wakes(ids.setter)).toEqual([
      `Ana removed the wait on PR ${REPO}#108 you set on ct-7 ("Task ct-7"), so it will not wake you. Nothing it waits on is open any more. Check whether the work that waited on it can go ahead, and replan it if not.`,
    ]);
  });

  test("a removed wait is told to its setter while the task is still blocked", async () => {
    const { t, ids, cli, wait, wakes } = await setup({ alsoBlockedByTask: true });
    await wait();
    await t.mutation(api.taskWaits.removeWait, { ...cli, short_id: "ct-7", ref: `${REPO}#108`, conversation_id: "setter2" });
    expect(await wakes(ids.setter)).toEqual([`session jxsetter2 removed the wait on PR ${REPO}#108 you set on ct-7 ("Task ct-7"), so it will not wake you. ct-7 is still blocked. Check whether the work that waited on it can go ahead, and replan it if not.`]);
  });

  test("a setter removing its own wait is not told", async () => {
    const { t, ids, cli, wait, wakes } = await setup();
    await wait();
    await t.mutation(api.taskWaits.removeWait, { ...cli, short_id: "ct-7", ref: `${REPO}#108`, conversation_id: "setter" });
    expect(await wakes(ids.setter)).toEqual([]);
  });

  test("a session adding a wait a planner already set becomes its setter", async () => {
    const { ids, wait, movePr, wakes } = await setup();
    expect((await wait("planner")).wait.created_in).toBeUndefined();
    const res = await wait("setter");
    expect(res).toMatchObject({ existing: true, parked: true, wait: { created_in: String(ids.setter) } });
    await movePr("merged");
    expect(await wakes(ids.setter)).toEqual([UNBLOCKED_108]);
    expect(await wakes(ids.planner)).toEqual([]);
  });

  test("a session adding a wait another session set is not its setter, and is told so", async () => {
    const { ids, wait, movePr, wakes } = await setup();
    expect((await wait("setter")).parked).toBe(true);
    const res = await wait("setter2");
    expect(res).toMatchObject({ existing: true, parked: false, wait: { created_in: String(ids.setter) } });
    await movePr("merged");
    expect(await wakes(ids.setter)).toEqual([UNBLOCKED_108]);
    expect(await wakes(ids.setter2)).toEqual([]);
  });

  test("a met wait not yet told that someone removes as history tells its setter", async () => {
    const { t, ids, cli, wait, movePr, wakes } = await setup({ alsoBlockedByTask: true });
    await wait();
    await movePr("merged");
    await t.mutation(api.taskWaits.removeWait, { ...cli, short_id: "ct-7", ref: `${REPO}#108` });
    await t.mutation(api.tasks.removeDep, { ...cli, short_id: "ct-7", blocked_by: "ct-9" });
    expect(await wakes(ids.setter)).toEqual([
      `Ana removed the wait on PR ${REPO}#108 you set on ct-7 ("Task ct-7"), so it will not wake you. ct-7 is still blocked. Check whether the work that waited on it can go ahead, and replan it if not.`,
    ]);
  });

  test("a removal that unblocks the task tells a setter of a met and a removed wait once", async () => {
    const { t, ids, cli, wait, movePr, wakes } = await setup();
    await wait("setter", 108);
    await wait("setter", 109);
    await movePr("merged", 108);
    await t.mutation(api.taskWaits.removeWait, { ...cli, short_id: "ct-7", ref: `${REPO}#109` });
    expect(await wakes(ids.setter)).toEqual([
      `ct-7 ("Task ct-7") is unblocked: Ana removed the wait on PR ${REPO}#109. You set the wait on PR ${REPO}#108 on it, which was met, and the wait on PR ${REPO}#109, which Ana removed. Check whether the work that waited on them can go ahead, and continue it or replan it.`,
    ]);
  });

  test("a ref repeated at a task's create records no setter", async () => {
    const { t, ids, cli, waitsOf } = await setup();
    await t.mutation(api.tasks.create, { ...cli, title: "Wired", workspace: "team", team_id: ids.team, waits: [`${REPO}#108`, `${REPO}#108`], conversation_id: "setter" });
    const created = await t.run(async (ctx) => (await ctx.db.query("tasks").collect()).find((r: any) => r.title === "Wired") as any);
    const waits = await waitsOf(created.short_id);
    expect(waits).toHaveLength(1);
    expect(waits[0].created_in).toBeUndefined();
  });

  test("a setter of two waits that fail together hears once", async () => {
    const { ids, wait, movePr, wakes } = await setup();
    await wait("setter", 108);
    await wait("setter", 108, ":checks");
    await movePr("closed");
    const got = await wakes(ids.setter);
    expect(got).toHaveLength(1);
    expect(got[0]).toStartWith(`ct-7 ("Task ct-7") is still blocked: PR ${REPO}#108 closed without merging; `);
    expect(got[0]).toEndWith(`, so the waits you set on it can no longer clear. ${REPLAN}`);
  });

  test("a met checks wait someone else re-adds keeps its setter", async () => {
    const { t, ids, cli, wait, wakes, waitsOf } = await setup({ alsoBlockedByTask: true });
    const checks = async (checks_state: string) => {
      await t.run((ctx) => ctx.db.patch(ids.pr108, { checks_state } as any));
      await t.mutation(api.taskWaits.settlePr, { pr_id: ids.pr108 });
    };
    await wait("setter", 108, ":checks");
    await checks("success");
    await t.run((ctx) => ctx.db.patch(ids.pr108, { checks_state: "failure" } as any));
    const res = await wait("planner", 108, ":checks");
    expect(res.wait).toMatchObject({ state: "waiting", created_in: String(ids.setter) });
    expect(res.wait.setter_told_at).toBeUndefined();
    expect(await waitsOf()).toHaveLength(1);
    await checks("success");
    await t.mutation(api.tasks.removeDep, { ...cli, short_id: "ct-7", blocked_by: "ct-9" });
    expect(await wakes(ids.setter)).toEqual([expect.stringMatching(/^ct-7 \("Task ct-7"\) is unblocked: .*You set the wait on green checks for PR codecast-sh\/codecast#108 on it/)]);
  });

  test("a met checks wait another parked session re-adds stays its first setter's", async () => {
    const { t, ids, cli, wait, wakes } = await setup({ alsoBlockedByTask: true });
    const checks = async (checks_state: string) => {
      await t.run((ctx) => ctx.db.patch(ids.pr108, { checks_state } as any));
      await t.mutation(api.taskWaits.settlePr, { pr_id: ids.pr108 });
    };
    await wait("setter", 108, ":checks");
    await checks("success");
    await t.run((ctx) => ctx.db.patch(ids.pr108, { checks_state: "failure" } as any));
    const res = await wait("setter2", 108, ":checks");
    expect(res).toMatchObject({ parked: false, wait: { state: "waiting", created_in: String(ids.setter) } });
    await checks("success");
    await t.mutation(api.tasks.removeDep, { ...cli, short_id: "ct-7", blocked_by: "ct-9" });
    expect(await wakes(ids.setter)).toEqual([expect.stringMatching(/^ct-7 \("Task ct-7"\) is unblocked: .*You set the wait on green checks for PR codecast-sh\/codecast#108 on it/)]);
    expect(await wakes(ids.setter2)).toEqual([]);
  });

  test("a wait a person set records no session and wakes only the owner", async () => {
    const { ids, wait, movePr, wakes } = await setup({ holderOfA: "other" });
    expect((await wait(null)).wait.created_in).toBeUndefined();
    await movePr("merged");
    expect(await wakes(ids.other)).toHaveLength(1);
    expect(await wakes(ids.setter)).toEqual([]);
  });

  test("a setter whose held task does not wait on the task hears no held-task clause", async () => {
    const { ids, wait, movePr, wakes } = await setup();
    await wait("setter2");
    await movePr("merged");
    expect(await wakes(ids.setter2)).toEqual([`ct-7 ("Task ct-7") is unblocked: PR ${REPO}#108 merged. You set the wait on PR ${REPO}#108 on it, so continue the work that waited on it.`]);
  });

  test("a setter that declared its work done is not woken, and its wait is still stamped", async () => {
    const { t, ids, wait, movePr, wakes, waitsOf } = await setup();
    await wait("setter2");
    await t.run((ctx) => ctx.db.patch(ids.setter2, { thread_state_status: "done", thread_state_at: Date.now() } as any));
    await movePr("merged");
    expect(await wakes(ids.setter2)).toEqual([]);
    expect((await waitsOf())[0].setter_told_at).toBeNumber();
  });

  // A done pin older than the latest turn answered an earlier turn: the
  // setter is parked again, and is woken.
  test("a setter whose done pin predates its latest turn is woken", async () => {
    const { t, ids, wait, movePr, wakes } = await setup();
    await wait("setter2");
    await t.run((ctx) => ctx.db.patch(ids.setter2, { thread_state_status: "done", thread_state_at: 1_000, last_turn_at: 2_000 } as any));
    await movePr("merged");
    expect(await wakes(ids.setter2)).toHaveLength(1);
  });
});

// A failed wait's setter replans its own work; the task's blockers are its
// owner's, who is told to edit them at the same moment.
describe("a setter told its wait failed", () => {
  test("is pointed at its own work, not the task's blockers", async () => {
    const { ids, wait, movePr, wakes } = await setup();
    await wait("setter2");
    await movePr("closed");
    const [got] = await wakes(ids.setter2);
    expect(got).toBe(`ct-7 ("Task ct-7") is still blocked: PR ${REPO}#108 closed without merging, so the wait you set on it can no longer clear. Replan your own work (ct-10). Nobody holds ct-7, so no one else will replan it.`);
    expect(got).not.toContain("cast task dep");
  });

  test("with an owner holding the task, it leaves the task's blockers to that owner", async () => {
    const { ids, wait, movePr, wakes } = await setup({ holderOfA: "other" });
    await wait("setter2");
    await movePr("closed");
    expect(await wakes(ids.setter2)).toEqual([
      `ct-7 ("Task ct-7") is still blocked: PR ${REPO}#108 closed without merging, so the wait you set on it can no longer clear. Replan your own work (ct-10), and leave ct-7's blockers to its owner.`,
    ]);
  });
});

// A task closed with waits still owed to their setters: each setter hears once
// that its wait will not wake it, and the wait is stamped.
describe("a task closed with owed setter waits", () => {
  test("tells each setter once, and not the session that closed it", async () => {
    const { t, ids, cli, wait, wakes, waitsOf } = await setup();
    await wait("setter2");
    await wait("setter", 109);
    await t.mutation(api.tasks.update, { ...cli, short_id: "ct-7", status: "done", conversation_id: "setter" });
    expect(await wakes(ids.setter2)).toEqual([`ct-7 ("Task ct-7") was closed as done; the wait you set on it will not wake you. Check whether your work can go ahead.`]);
    expect(await wakes(ids.setter)).toEqual([]);
    expect((await waitsOf()).every((w: any) => typeof w.setter_told_at === "number")).toBe(true);
    // Reopened and closed again: nobody is told twice.
    await t.mutation(api.tasks.update, { ...cli, short_id: "ct-7", status: "open" });
    await t.mutation(api.tasks.update, { ...cli, short_id: "ct-7", status: "dropped" });
    expect(await wakes(ids.setter2)).toHaveLength(1);
  });

  test("a closed task's setter is no longer parked on it", async () => {
    const { t, ids, cli, wait } = await setup();
    await wait("setter2");
    expect(await t.run(async (ctx: any) => (await ctx.db.get(ids.setter2)).parked_wake_kind)).toBe("wait");
    await t.mutation(api.tasks.update, { ...cli, short_id: "ct-7", status: "done" });
    expect(await t.run(async (ctx: any) => (await ctx.db.get(ids.setter2)).parked_wake_kind)).toBe("none");
  });
});

// A setter whose held task still lists the task in blocked_by is woken when
// that task unblocks. Nothing may close the task (a PR merged outside a flow
// closes none), so a met or failed wait still tells it, with what holds its
// task and what it can do. A close wakes it as the held task's owner, not
// with a closed notice. A removal tells it, with the park. Any other setter
// gets the plain text.
describe("setter texts when the held task still waits on the task", () => {
  // The caller joins a wait another session set: it is not the setter, but
  // its own task waits on ct-7 closing, so its blocker stamp parks it.
  // The joiner is not the setter, so the wait tells it nothing: "held", not
  // "close", and no notice is promised.
  test("joining another session's wait answers held when the held task waits on the task", async () => {
    const { wait } = await setup({ heldWaitsOnA: true });
    expect((await wait("setter2")).parked).toBe(true);
    expect(await wait("setter")).toMatchObject({ existing: true, parked: "held", owns: true });
    // A caller whose task does not wait on ct-7 hears nothing new.
    const plain = await setup();
    await plain.wait("setter2");
    expect((await plain.wait("setter")).parked).toBe(false);
  });

  test("the add answers parked: close, with whether the caller owns its held task", async () => {
    const { wait } = await setup({ heldWaitsOnA: true });
    expect(await wait("setter")).toMatchObject({ parked: "close", owns: true });
    // Another, newer session owns ct-8: the setter does not.
    const shared = await setup({ heldWaitsOnA: true });
    await shared.t.run(async (ctx: any) => {
      const setter = await ctx.db.get(shared.ids.setter);
      const owner = await ctx.db.insert("conversations", { user_id: setter.user_id, agent_type: "claude_code", session_id: "owner", title: "owner", short_id: "jxowner", started_at: 0, updated_at: 5, message_count: 0, status: "active", is_private: false, active_task_id: setter.active_task_id } as any);
      await ctx.db.patch(setter.active_task_id, { conversation_ids: [...((await ctx.db.get(setter.active_task_id)).conversation_ids ?? []), owner] });
    });
    expect(await shared.wait("setter")).toMatchObject({ parked: "close", owns: false });
    const plain = await setup();
    expect((await plain.wait("setter")).parked).toBe(true);
  });

  // jx7cn1s: ct-7 in review with nobody holding it, S holding ct-8 (blocked by
  // ct-7) and waiting on PR #108. The PR merges outside a flow, so nothing
  // closes ct-7: S must hear it once, with what still holds ct-8.
  // Nobody holds ct-7: no owner is told, and nothing may close it, so the
  // setter closes a finished ct-7 or pins blocked for a person (its own stamp
  // is a "wait", which surfaces it after 72h at most).
  test("a met wait on an ownerless task tells it once to close it or pin blocked", async () => {
    const { ids, wait, movePr, wakes, waitsOf } = await setup({ heldWaitsOnA: true });
    await wait("setter");
    await movePr("merged");
    expect(await wakes(ids.setter)).toEqual([`ct-7 ("Task ct-7") is unblocked: PR ${REPO}#108 merged. ${NOBODY}`]);
    expect((await waitsOf())[0].setter_told_at).toBeNumber();
  });

  test("a failed wait on an ownerless task says the same", async () => {
    const { ids, wait, movePr, wakes } = await setup({ heldWaitsOnA: true });
    await wait("setter");
    await movePr("closed");
    expect(await wakes(ids.setter)).toEqual([
      `ct-7 ("Task ct-7") is still blocked: PR ${REPO}#108 closed without merging, so the wait you set on it can no longer clear. ${NOBODY}`,
    ]);
  });

  // ct-7's owner is told at the same moment to continue, so the setter asks
  // it rather than closing ct-7 itself.
  test("with an owner, the setter is told to ask it", async () => {
    const met = await setup({ heldWaitsOnA: true, holderOfA: "other" });
    await met.wait("setter");
    await met.movePr("merged");
    expect(await met.wakes(met.ids.setter)).toEqual([
      `ct-7 ("Task ct-7") is unblocked: PR ${REPO}#108 merged. ct-8 still waits for ct-7 to close: ask session jxother to close ct-7 when its work is done; you are woken as ct-8's owner when ct-8 is unblocked. Pin dormant naming ct-7 and end your turn.`,
    ]);
    const failed = await setup({ heldWaitsOnA: true, holderOfA: "other" });
    await failed.wait("setter");
    await failed.movePr("closed");
    expect(await failed.wakes(failed.ids.setter)).toEqual([
      `ct-7 ("Task ct-7") is still blocked: PR ${REPO}#108 closed without merging, so the wait you set on it can no longer clear. ct-8 still waits for ct-7 to close, so replan with session jxother, or drop the dependency.`,
    ]);
  });

  test("a removal on an ownerless task tells it to close it or pin blocked", async () => {
    const { t, ids, cli, wait, wakes } = await setup({ heldWaitsOnA: true });
    await wait("setter");
    await t.mutation(api.taskWaits.removeWait, { ...cli, short_id: "ct-7", ref: `${REPO}#108` });
    expect(await wakes(ids.setter)).toEqual([`Ana removed the wait on PR ${REPO}#108 you set on ct-7 ("Task ct-7"), so it will not wake you. ${NOBODY}`]);
  });

  test("a removal on a held task tells it to stay parked", async () => {
    const { t, ids, cli, wait, wakes } = await setup({ heldWaitsOnA: true, holderOfA: "other" });
    await wait("setter");
    await t.mutation(api.taskWaits.removeWait, { ...cli, short_id: "ct-7", ref: `${REPO}#108` });
    expect(await wakes(ids.setter)).toEqual([`Ana removed the wait on PR ${REPO}#108 you set on ct-7 ("Task ct-7"), so it will not wake you. ${PARK}`]);
  });

  test("a closed task: the held task's owner wake, not a closed notice", async () => {
    const { t, ids, cli, wait, wakes } = await setup({ heldWaitsOnA: true });
    await wait("setter");
    await t.mutation(api.tasks.update, { ...cli, short_id: "ct-7", status: "done" });
    const got = await wakes(ids.setter);
    expect(got).toHaveLength(1);
    expect(got[0]).toStartWith(`ct-8 ("Task ct-8") is unblocked: ct-7 done.`);
  });

  test("a task dropped: a setter with other work is told to replan", async () => {
    const { t, ids, cli, wait, wakes } = await setup();
    await wait("setter2");
    await t.mutation(api.tasks.update, { ...cli, short_id: "ct-7", status: "dropped" });
    expect(await wakes(ids.setter2)).toEqual([`ct-7 ("Task ct-7") was closed (dropped); the wait you set on it will not wake you. Replan your own work.`]);
  });

  test("a removed wait while the task is still blocked, for a setter with other work", async () => {
    const { t, ids, cli, wait, wakes } = await setup({ alsoBlockedByTask: true });
    await wait("setter2");
    await t.mutation(api.taskWaits.removeWait, { ...cli, short_id: "ct-7", ref: `${REPO}#108` });
    expect(await wakes(ids.setter2)).toEqual([
      `Ana removed the wait on PR ${REPO}#108 you set on ct-7 ("Task ct-7"), so it will not wake you. ct-7 is still blocked. Check whether the work that waited on it can go ahead, and replan it if not.`,
    ]);
  });
});

// The setter's own held task may be held back by something else entirely: it
// is told what, not to "continue the work".
describe("a setter whose held task has other open blockers", () => {
  const heldBy = async (t: any, ids: any, fields: Record<string, unknown>) =>
    t.run(async (ctx: any) => ctx.db.patch((await ctx.db.get(ids.setter2)).active_task_id, fields));

  test("a met wait names what still holds its task", async () => {
    const { t, ids, wait, movePr, wakes } = await setup();
    await heldBy(t, ids, { waits: [{ id: "w9", kind: "pr_merged", repository: REPO, pr_number: 109, state: "waiting", created_at: 0 }], waiting_since: 0 });
    await wait("setter2");
    await movePr("merged");
    expect(await wakes(ids.setter2)).toEqual([
      `ct-7 ("Task ct-7") is unblocked: PR ${REPO}#108 merged. ct-10 still waits for PR #109 to merge; you are woken as ct-10's owner when ct-10 is unblocked. Pin dormant naming it and end your turn.`,
    ]);
  });

  // Another session holds ct-10 too, and owns it: ct-10 unblocking wakes that
  // one, not this setter.
  test("a setter that does not own its held task is not promised its wake", async () => {
    const { t, ids, wait, movePr, wakes } = await setup();
    await heldBy(t, ids, { waits: [{ id: "w9", kind: "pr_merged", repository: REPO, pr_number: 109, state: "waiting", created_at: 0 }], waiting_since: 0 });
    await t.run(async (ctx: any) => {
      const held = (await ctx.db.get(ids.setter2)).active_task_id;
      const owner = await ctx.db.insert("conversations", { user_id: (await ctx.db.get(ids.setter2)).user_id, agent_type: "claude_code", session_id: "owner", title: "owner", short_id: "jxowner", started_at: 0, updated_at: 5, message_count: 0, status: "active", is_private: false, active_task_id: held } as any);
      await ctx.db.patch(held, { conversation_ids: [...((await ctx.db.get(held)).conversation_ids ?? []), owner] });
    });
    await wait("setter2");
    await movePr("merged");
    expect(await wakes(ids.setter2)).toEqual([
      `ct-7 ("Task ct-7") is unblocked: PR ${REPO}#108 merged. ct-10 still waits for PR #109 to merge; ct-10's owning session (jxowner) is woken when it is unblocked. Pin dormant naming it and end your turn.`,
    ]);
  });

  test("a failed wait names it too", async () => {
    const { t, ids, wait, movePr, wakes } = await setup({ alsoBlockedByTask: true });
    await heldBy(t, ids, { blocked_by: ["ct-9"] });
    await wait("setter2");
    await movePr("closed");
    expect(await wakes(ids.setter2)).toEqual([
      `ct-7 ("Task ct-7") is still blocked: PR ${REPO}#108 closed without merging, so the wait you set on it can no longer clear. Replan the work that waited on it. Nobody holds ct-7, so no one else will replan it. ct-10 also still waits for ct-9 to close.`,
    ]);
  });
});

// A sibling wait failing: the owner is told to replace it, so the task may
// still unblock. The setter of a met wait is neither told nor stamped, and
// stays parked; a wait stamp's lifetime bounds a task that never unblocks.
describe("a sibling wait failing", () => {
  test("leaves the setter of a met wait parked, untold and unstamped", async () => {
    const { t, ids, wait, movePr, wakes, waitsOf } = await setup();
    await wait("setter2", 108);
    await wait("planner", 109);
    await movePr("merged", 108);
    await movePr("closed", 109);
    expect(await wakes(ids.setter2)).toEqual([]);
    expect((await waitsOf()).find((w: any) => w.pr_number === 108).setter_told_at).toBeUndefined();
    expect(await t.run(async (ctx: any) => (await ctx.db.get(ids.setter2)).parked_wake_kind)).toBe("wait");
  });
});

// A session reviewing the task it holds holds it to review, not to do: like a
// planner, it records no setter when it sets a wait elsewhere.
describe("a reviewer setting a wait", () => {
  test("records no setter and does not park", async () => {
    const { t, ids, wait } = await setup();
    await t.run(async (ctx: any) => ctx.db.patch(ids.setter2, { review_of_task_id: (await ctx.db.get(ids.setter2)).active_task_id }));
    const res = await wait("setter2");
    expect(res.wait.created_in).toBeUndefined();
    expect(res.parked).toBeFalsy();
  });
});

// The wait a session set on a task it does not hold is a server-seen wake
// (conversations.parked_on_task_ids, lib/parkedWake.ts): setter2 holds ct-10,
// which nothing blocks, and parks on a PR wait it set on ct-7.
describe("a wait the session set parks it", () => {
  const kindOf = (t: any, conv: any) => t.run(async (ctx: any) => ((await ctx.db.get(conv)) as any).parked_wake_kind ?? "none");

  test("setting the wait parks the setter until the PR merges and it is told", async () => {
    const { t, ids, wait, movePr, wakes } = await setup();
    expect((await wait("setter2")).parked).toBe(true);
    const parkedOn = () => t.run(async (ctx) => ((await ctx.db.get(ids.setter2)) as any).parked_on_task_ids);
    expect(await parkedOn()).toEqual([ids.a]);
    expect(await kindOf(t, ids.setter2)).toBe("wait");
    await movePr("merged");
    expect(await wakes(ids.setter2)).toHaveLength(1);
    expect(await kindOf(t, ids.setter2)).toBe("none");
    // Nothing is owed any more, so the list goes with it.
    expect((await parkedOn()) ?? null).toBeNull();
  });

  test("a met wait still owed to its setter keeps it parked until the task unblocks", async () => {
    const { t, ids, cli, wait, movePr } = await setup({ alsoBlockedByTask: true });
    await wait("setter2");
    await movePr("merged");
    expect(await kindOf(t, ids.setter2)).toBe("wait");
    await t.mutation(api.tasks.removeDep, { ...cli, short_id: "ct-7", blocked_by: "ct-9" });
    expect(await kindOf(t, ids.setter2)).toBe("none");
  });

  test("joining a planner's wait parks the joiner", async () => {
    const { t, ids, wait } = await setup();
    await wait("planner");
    expect((await wait("setter2")).parked).toBe(true);
    expect(await kindOf(t, ids.setter2)).toBe("wait");
  });

  test("someone else removing the wait clears the setter's stamp", async () => {
    const { t, ids, cli, wait } = await setup();
    await wait("setter2");
    await t.mutation(api.taskWaits.removeWait, { ...cli, short_id: "ct-7", ref: `${REPO}#108` });
    expect(await kindOf(t, ids.setter2)).toBe("none");
  });
});
