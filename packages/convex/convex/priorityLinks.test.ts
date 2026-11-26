// Evidence marks milestones done, and known links are set at creation
// (lib/priorityLinks.ts): each evidence kind recomputes the milestone with
// done_at = the evidence's own time, and each known link maps a session with
// no pass run.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { allModules } from "./testModules.testkit";
import { api, internal } from "./_generated/api";
import { hashToken } from "./apiTokens";
import { patchTask } from "./lib/taskWrite";
import { patchPullRequest } from "./prShepherd";
import { spawnSessionCore } from "./spawn";
import { setTaskStatus } from "./orgInit";
import { linkFromStart } from "./lib/priorityLinks";
import { TASK, SOURCE, ADA, apply, engineCtx, sameIssue } from "./issueSync.testkit";
import type { Id } from "./_generated/dataModel";

setDefaultTimeout(60_000);

const TOKEN = "cc_test_priority_links_ada";
const BEA_TOKEN = "cc_test_priority_links_bea";
const H = 3_600_000;
const NOW = Date.now();
const REPO = "acme/app";

const step = (key: string, refs: Array<{ kind: "task" | "pr" | "session"; id: string }> = []) =>
  ({ key, title: `Milestone ${key}`, tier: "critical" as const, tier_set_by: "pass" as const, refs, done: false });

/**
 * Ada's personal workspace holds pri-1: s1 names task ct-1, s2 names PR
 * acme/app#5, s3 and s4 name nothing (their sessions decide), s5 names ct-3
 * and ct-4. Bea owns pri-9. Sessions: cTask links ct-1, cPr links the PR,
 * cPin is mapped to s3, cDec to s4, cFree to nothing.
 */
async function world() {
  const t = convexTest(schema, allModules);
  const ids = await t.run(async (ctx) => {
    const ada = await ctx.db.insert("users", { name: "Ada" } as any);
    const bea = await ctx.db.insert("users", { name: "Bea" } as any);
    for (const [u, token] of [[ada, TOKEN], [bea, BEA_TOKEN]] as const) {
      await ctx.db.insert("api_tokens", { user_id: u, token_hash: await hashToken(token), name: "cli", created_at: NOW, last_used_at: NOW } as any);
    }
    // Priorities is on for both, so it is on in their personal workspaces too.
    const home = await ctx.db.insert("teams", { name: "Home", created_at: NOW, features: { priorities: true } } as any);
    for (const u of [ada, bea]) await ctx.db.insert("team_memberships", { user_id: u, team_id: home, role: "member", joined_at: 1 } as any);
    const ws = `user:${ada}`;
    const p1 = await ctx.db.insert("priorities", {
      user_id: ada, workspace: ws, short_id: "pri-1", title: "Ship it", summary: "", status: "active", ai_rank: 1,
      steps: [
        step("s1", [{ kind: "task", id: "ct-1" }]), step("s2", [{ kind: "pr", id: `${REPO}#5` }]), step("s3"), step("s4"),
        step("s5", [{ kind: "task", id: "ct-3" }, { kind: "task", id: "ct-4" }]), step("s6", [{ kind: "task", id: "ct-5" }]), step("s7", [{ kind: "pr", id: `${REPO}#6` }]),
      ],
      first_seen_at: NOW, last_active_at: NOW, pass_at: NOW, created_at: NOW, updated_at: NOW, session_count: 2,
    } as any);
    const p9 = await ctx.db.insert("priorities", {
      user_id: bea, workspace: `user:${bea}`, short_id: "pri-9", title: "Bea's", summary: "", status: "active", ai_rank: 1,
      steps: [step("s1")], first_seen_at: NOW, last_active_at: NOW, pass_at: NOW, created_at: NOW, updated_at: NOW, session_count: 0,
    } as any);
    const conv = (short_id: string, fields: Record<string, unknown> = {}) => ctx.db.insert("conversations", {
      user_id: ada, agent_type: "claude_code", session_id: `sess-${short_id}`, short_id, title: short_id,
      started_at: NOW, updated_at: NOW, message_count: 1, is_private: true, status: "active", ...fields,
    } as any);
    const cTask = await conv("jx7task");
    const cPr = await conv("jx7pr01");
    const cPin = await conv("jx7pin1", { priority_id: p1, priority_step_key: "s3" });
    const cDec = await conv("jx7dec1", { priority_id: p1, priority_step_key: "s4" });
    const cFree = await conv("jx7free");
    const plan = await ctx.db.insert("plans", { user_id: ada, workspace: ws, short_id: "pl-1", title: "Plan", status: "active", source: "human", created_at: NOW, updated_at: NOW } as any);
    const task = (short_id: string, fields: Record<string, unknown> = {}) => ctx.db.insert("tasks", {
      user_id: ada, workspace: ws, short_id, title: short_id, status: "open", task_type: "task", priority: "medium", source: "human",
      created_at: NOW, updated_at: NOW, ...fields,
    } as any);
    const ct1 = await task("ct-1", { conversation_ids: [cTask] });
    const ct3 = await task("ct-3", { plan_id: plan });
    const ct4 = await task("ct-4");
    // No session links ct-5: its owner's priorities are where it is found.
    const ct5 = await task("ct-5");
    const pullRequest = (number: number, fields: Record<string, unknown> = {}) => ctx.db.insert("pull_requests", {
      repository: REPO, number, github_pr_id: 1000 + number, title: `PR ${number}`, body: "", state: "open", author_github_username: "ada",
      linked_session_ids: [cPr], created_at: NOW, updated_at: NOW, ...fields,
    } as any);
    const pr = await pullRequest(5);
    // A pull request of another team's repository counts toward none of Ada's personal priorities.
    const elsewhere = await ctx.db.insert("teams", { name: "Elsewhere", created_at: NOW } as any);
    const foreignPr = await pullRequest(6, { team_id: elsewhere });
    return { ada, bea, p1, p9, cTask, cPr, cPin, cDec, cFree, ct1, ct3, ct4, ct5, pr, foreignPr };
  });
  return { t, ...ids };
}

const stepOf = async (t: any, p: Id<"priorities">, key: string) => (await t.run((ctx: any) => ctx.db.get(p))).steps.find((s: any) => s.key === key);
const convOf = (t: any, id: Id<"conversations">) => t.run((ctx: any) => ctx.db.get(id));

describe("a pass never undoes what tasks and pull requests say", () => {
  const applyPlan = (t: any, ada: Id<"users">, started_at: number, updates: unknown[]) => t.mutation((internal as any).priorityPassRun.applyPlan, {
    user_id: ada, workspace: `user:${ada}`, started_at, from_cursor: 1, cursor_at: 2, model: "m",
    plan: { creates: [], updates, merges: [], sessions: [], unmap: [], notes: [], rewritten: [] },
  });

  test("a task closing while the model reads: the stale plan renames another milestone, and s1 stays done at the close", async () => {
    const { t, ada, p1, ct1 } = await world();
    // The pass read pri-1 with s1 open; its task closes during the call.
    const read = (await t.run((ctx: any) => ctx.db.get(p1))).steps;
    const closedAt = NOW - H;
    await t.run(async (ctx: any) => patchTask(ctx, await ctx.db.get(ct1), { status: "done", closed_at: closedAt }));
    expect(await stepOf(t, p1, "s1")).toMatchObject({ done: true, done_at: closedAt });
    await applyPlan(t, ada, NOW, [{ short_id: "pri-1", patch: { steps: read.map((s: any) => (s.key === "s3" ? { ...s, title: "Renamed" } : s)) } }]);
    expect(await stepOf(t, p1, "s1")).toMatchObject({ done: true, done_at: closedAt });
    expect((await stepOf(t, p1, "s3")).title).toBe("Renamed");
  });

  test("the pass cannot flip a milestone its merged pull request closed back to not done; only evidence reopens it", async () => {
    const { t, ada, p1, pr } = await world();
    const mergedAt = NOW - 2 * H;
    await t.run((ctx: any) => patchPullRequest(ctx, pr, { state: "merged", merged_at: mergedAt }));
    expect(await stepOf(t, p1, "s2")).toMatchObject({ done: true, done_at: mergedAt });
    const steps = (await t.run((ctx: any) => ctx.db.get(p1))).steps;
    await applyPlan(t, ada, NOW, [{ short_id: "pri-1", patch: { steps: steps.map((s: any) => (s.key === "s2" ? { key: s.key, title: s.title, tier: s.tier, tier_set_by: "pass", refs: s.refs, done: false } : s)) } }]);
    expect(await stepOf(t, p1, "s2")).toMatchObject({ done: true, done_at: mergedAt });
  });

  test("a done pin naming its milestone lands while the model reads: the stale plan keeps it done; the person can reopen it", async () => {
    const { t, ada, p1, cPin } = await world();
    const read = (await t.run((ctx: any) => ctx.db.get(p1))).steps;
    await t.mutation(api.conversations.setThreadState, { api_token: TOKEN, session: "jx7pin1", text: "Shipped", status: "done", serves: "pri-1/s3" });
    const pinnedAt = (await convOf(t, cPin)).thread_state_at;
    expect(await stepOf(t, p1, "s3")).toMatchObject({ done: true, done_at: pinnedAt, done_set_by: "evidence" });
    // The stale plan shows s3 open and renames s4; a later one leaves s3 out altogether.
    await applyPlan(t, ada, NOW, [{ short_id: "pri-1", patch: { steps: read.map((s: any) => (s.key === "s4" ? { ...s, title: "Renamed" } : s)) } }]);
    expect(await stepOf(t, p1, "s3")).toMatchObject({ done: true, done_at: pinnedAt, done_set_by: "evidence" });
    expect((await stepOf(t, p1, "s4")).title).toBe("Renamed");
    await applyPlan(t, ada, NOW, [{ short_id: "pri-1", patch: { steps: read.filter((s: any) => s.key !== "s3") } }]);
    expect(await stepOf(t, p1, "s3")).toMatchObject({ done: true, done_at: pinnedAt, done_set_by: "evidence" });
    await t.withIdentity({ subject: `${ada}|session` }).mutation((api as any).priorities.setStepDone, { short_id: "pri-1", step_key: "s3", done: false });
    expect(await stepOf(t, p1, "s3")).toMatchObject({ done: false, done_set_by: "person" });
  });

  test("nor its closed task's; a task reopening does reopen it", async () => {
    const { t, ada, p1, ct1 } = await world();
    await t.run(async (ctx: any) => patchTask(ctx, await ctx.db.get(ct1), { status: "done", closed_at: NOW - H }));
    const steps = (await t.run((ctx: any) => ctx.db.get(p1))).steps;
    await applyPlan(t, ada, NOW, [{ short_id: "pri-1", patch: { steps: steps.map((s: any) => (s.key === "s1" ? { key: s.key, title: s.title, tier: s.tier, tier_set_by: "pass", refs: s.refs, done: false } : s)) } }]);
    expect(await stepOf(t, p1, "s1")).toMatchObject({ done: true, done_at: NOW - H });
    await t.run(async (ctx: any) => patchTask(ctx, await ctx.db.get(ct1), { status: "in_progress", closed_at: undefined }));
    expect((await stepOf(t, p1, "s1")).done).toBe(false);
  });
});

describe("evidence marks a milestone done at the evidence's own time", () => {
  test("a linked task closing: done_at is the task's close, not when it was written", async () => {
    const { t, p1, ct1 } = await world();
    const closedAt = NOW - 3 * H;
    await t.run(async (ctx: any) => patchTask(ctx, await ctx.db.get(ct1), { status: "done", closed_at: closedAt, updated_at: NOW }));
    expect(await stepOf(t, p1, "s1")).toMatchObject({ done: true, done_at: closedAt });
    // Reopened, the milestone reopens with it.
    await t.run(async (ctx: any) => patchTask(ctx, await ctx.db.get(ct1), { status: "in_progress", closed_at: undefined }));
    const reopened = await stepOf(t, p1, "s1");
    expect(reopened.done).toBe(false);
    expect(reopened.done_at).toBeUndefined();
  });

  test("`cast task update --status done` lands the same way", async () => {
    const { t, p1, ct1 } = await world();
    await t.mutation(api.tasks.update, { api_token: TOKEN, short_id: "ct-1", status: "done" });
    const task = await t.run((ctx: any) => ctx.db.get(ct1));
    expect(await stepOf(t, p1, "s1")).toMatchObject({ done: true, done_at: task.closed_at });
  });

  test("done_at is when the done condition became true: the last open task dropped after another finished", async () => {
    const { t, p1, ct3, ct4 } = await world();
    await t.run(async (ctx: any) => patchTask(ctx, await ctx.db.get(ct3), { status: "done", closed_at: NOW - 3 * H }));
    expect((await stepOf(t, p1, "s5")).done).toBe(false);
    await t.run(async (ctx: any) => patchTask(ctx, await ctx.db.get(ct4), { status: "dropped", closed_at: NOW - H }));
    expect(await stepOf(t, p1, "s5")).toMatchObject({ done: true, done_at: NOW - H });
  });

  test("a task no session links is found through its owner", async () => {
    const { t, p1, ct5 } = await world();
    await t.run(async (ctx: any) => patchTask(ctx, await ctx.db.get(ct5), { status: "done", closed_at: NOW - H }));
    expect(await stepOf(t, p1, "s6")).toMatchObject({ done: true, done_at: NOW - H });
  });

  test("an org proposal's close (orgInit setTaskStatus) lands the same way", async () => {
    const { t, p1, ct1 } = await world();
    const at = NOW - 2 * H;
    await t.run(async (ctx: any) => setTaskStatus(ctx, {}, await ctx.db.get(ct1), "done", at));
    expect(await stepOf(t, p1, "s1")).toMatchObject({ done: true, done_at: at });
    await t.run(async (ctx: any) => setTaskStatus(ctx, {}, await ctx.db.get(ct1), "open", NOW));
    expect((await stepOf(t, p1, "s1")).done).toBe(false);
  });

  test("a cascade closing many tasks reads the owner's priorities once", async () => {
    const { t, p1, ct1, ct3, ct4, ct5 } = await world();
    const reads = await t.run(async (ctx: any) => {
      let n = 0;
      const db = new Proxy(ctx.db, {
        get(target: any, prop: string) {
          if (prop === "query") return (table: string) => { if (table === "priorities") n++; return target.query(table); };
          const v = target[prop];
          return typeof v === "function" ? v.bind(target) : v;
        },
      });
      const counted = { ...ctx, db };
      for (const id of [ct1, ct3, ct4, ct5]) await patchTask(counted, await ctx.db.get(id), { status: "done", closed_at: NOW - H });
      return n;
    });
    expect(reads).toBe(1);
    for (const key of ["s1", "s5", "s6"]) expect((await stepOf(t, p1, key)).done).toBe(true);
  });

  test("a linked PR merging: done_at is the merge", async () => {
    const { t, p1, pr } = await world();
    const mergedAt = NOW - 2 * H;
    await t.run((ctx: any) => patchPullRequest(ctx, pr, { state: "merged", merged_at: mergedAt }));
    expect(await stepOf(t, p1, "s2")).toMatchObject({ done: true, done_at: mergedAt });
  });

  test("a team PR linked only from a private session reaches its team milestone; closing the last open one unmerged finishes it", async () => {
    const { t, ada } = await world();
    const { p, open } = await t.run(async (ctx: any) => {
      const acme = await ctx.db.insert("teams", { name: "Acme", created_at: NOW, features: { priorities: true } });
      await ctx.db.insert("team_memberships", { user_id: ada, team_id: acme, role: "member", joined_at: 1 });
      const p = await ctx.db.insert("priorities", {
        user_id: ada, workspace: `team:${acme}`, short_id: "pri-3", title: "Team PRs", summary: "", status: "active", ai_rank: 1,
        steps: [step("s1", [{ kind: "pr", id: `${REPO}#7` }, { kind: "pr", id: `${REPO}#8` }])], first_seen_at: NOW, last_active_at: NOW, pass_at: NOW, created_at: NOW, updated_at: NOW,
      });
      const priv = await ctx.db.insert("conversations", {
        user_id: ada, team_id: acme, agent_type: "claude_code", session_id: "sess-privpr", short_id: "jx7ppr1", title: "private",
        started_at: NOW, updated_at: NOW, message_count: 1, is_private: true, team_visibility: "private", status: "active",
      });
      const pr = (number: number, fields: Record<string, unknown>) => ctx.db.insert("pull_requests", {
        team_id: acme, repository: REPO, number, github_pr_id: 2000 + number, title: `PR ${number}`, body: "", author_github_username: "ada",
        linked_session_ids: [priv], created_at: NOW, updated_at: NOW, ...fields,
      });
      await pr(7, { state: "merged", merged_at: NOW - 3 * H });
      return { p, open: await pr(8, { state: "open" }) };
    });
    await t.run((ctx: any) => patchPullRequest(ctx, open, { state: "closed", closed_at: NOW - H }));
    expect(await stepOf(t, p, "s1")).toMatchObject({ done: true, done_at: NOW - H });
  });

  test("a PR of another team's workspace counts toward no personal milestone", async () => {
    const { t, p1, foreignPr } = await world();
    await t.run((ctx: any) => patchPullRequest(ctx, foreignPr, { state: "merged", merged_at: NOW - H }));
    expect((await stepOf(t, p1, "s7")).done).toBe(false);
  });

  test("a decision answered on a mapped session closes nothing: a card is a question asked mid-work", async () => {
    const { t, ada, p1, cDec } = await world();
    const decision = await t.run((ctx: any) => ctx.db.insert("session_decisions", {
      conversation_id: cDec, session_id: "sess-jx7dec1", user_id: ada, question: "Flip the flag?", options: [{ label: "Yes" }, { label: "No" }],
      blocking: true, status: "pending", created_at: NOW,
    }));
    await t.withIdentity({ subject: `${ada}|session` }).mutation(api.sessionDecisions.resolve, { decision_id: decision, status: "answered", answer_index: 0 });
    expect((await t.run((ctx: any) => ctx.db.get(decision))).resolved_at).toBeNumber();
    expect((await stepOf(t, p1, "s4")).done).toBe(false);
  });

  test("a bare done pin closes nothing (it means the turn was delivered); the reply names the milestone and how to close it", async () => {
    const { t, p1 } = await world();
    const res = await t.mutation(api.conversations.setThreadState, { api_token: TOKEN, session: "jx7pin1", text: "Shipped", status: "done" });
    expect((await stepOf(t, p1, "s3")).done).toBe(false);
    expect(res.milestone).toEqual({ serves: "pri-1/s3", title: "Milestone s3" });
    // A working pin, or a done one that names its milestone, gets no hint.
    expect((await t.mutation(api.conversations.setThreadState, { api_token: TOKEN, session: "jx7pin1", text: "More", status: "working" })).milestone).toBeUndefined();
  });

  test("a done pin serving its milestone closes it at the pin time, and a later one keeps that time", async () => {
    const { t, p1, cPin } = await world();
    const res = await t.mutation(api.conversations.setThreadState, { api_token: TOKEN, session: "jx7pin1", text: "Shipped", status: "done", serves: "pri-1/s3" });
    expect(res.milestone).toBeUndefined();
    const pinnedAt = (await convOf(t, cPin)).thread_state_at;
    expect(await stepOf(t, p1, "s3")).toMatchObject({ done: true, done_at: pinnedAt });
    await new Promise((r) => setTimeout(r, 5));
    await t.mutation(api.conversations.setThreadState, { api_token: TOKEN, session: "jx7pin1", text: "Shipped again", status: "done", serves: "pri-1/s3" });
    expect((await stepOf(t, p1, "s3")).done_at).toBe(pinnedAt);
  });

  test("a done pin naming another milestone, or from a worker, closes nothing", async () => {
    const { t, ada, p1, cPin } = await world();
    await t.run((ctx: any) => ctx.db.insert("conversations", {
      user_id: ada, agent_type: "claude_code", session_id: "sess-jx7wrk1", short_id: "jx7wrk1", title: "w", started_at: NOW, updated_at: NOW, message_count: 1, is_private: true, status: "active",
      priority_id: p1, priority_step_key: "s4", parent_conversation_id: cPin,
    }));
    await t.mutation(api.conversations.setThreadState, { api_token: TOKEN, session: "jx7pin1", text: "Shipped", status: "done", serves: "pri-1/s4" });
    await t.mutation(api.conversations.setThreadState, { api_token: TOKEN, session: "jx7wrk1", text: "Shipped", status: "done", serves: "pri-1/s4" });
    expect([(await stepOf(t, p1, "s3")).done, (await stepOf(t, p1, "s4")).done]).toEqual([false, false]);
  });

  test("a team task linked only from a private session lands on its team milestone", async () => {
    const { t, ada } = await world();
    const { p, task } = await t.run(async (ctx: any) => {
      const acme = await ctx.db.insert("teams", { name: "Acme", created_at: NOW, features: { priorities: true } });
      await ctx.db.insert("team_memberships", { user_id: ada, team_id: acme, role: "member", joined_at: 1 });
      const ws = `team:${acme}`;
      const p = await ctx.db.insert("priorities", {
        user_id: ada, workspace: ws, short_id: "pri-2", title: "Team", summary: "", status: "active", ai_rank: 1,
        steps: [step("s1", [{ kind: "task", id: "ct-20" }])], first_seen_at: NOW, last_active_at: NOW, pass_at: NOW, created_at: NOW, updated_at: NOW,
      });
      const c = await ctx.db.insert("conversations", {
        user_id: ada, team_id: acme, agent_type: "claude_code", session_id: "sess-team", short_id: "jx7team", title: "private",
        started_at: NOW, updated_at: NOW, message_count: 1, is_private: true, team_visibility: "private", status: "active",
      });
      const task = await ctx.db.insert("tasks", {
        user_id: ada, team_id: acme, workspace: ws, short_id: "ct-20", title: "t", status: "open", task_type: "task", priority: "medium", source: "human",
        created_at: NOW, updated_at: NOW, conversation_ids: [c],
      });
      return { p, task };
    });
    await t.run(async (ctx: any) => patchTask(ctx, await ctx.db.get(task), { status: "done", closed_at: NOW - H }));
    expect(await stepOf(t, p, "s1")).toMatchObject({ done: true, done_at: NOW - H });
  });

  test("session evidence never closes a milestone its open task still holds", async () => {
    const { t, p1, cPin } = await world();
    await t.run((ctx: any) => ctx.db.patch(cPin, { priority_step_key: "s1" }));
    await t.mutation(api.conversations.setThreadState, { api_token: TOKEN, session: "jx7pin1", text: "Done for now", status: "done" });
    expect((await stepOf(t, p1, "s1")).done).toBe(false);
  });
});

describe("a known link maps a session at creation, with no pass", () => {
  test("a session started from a milestone's Start, and its priority's count follows", async () => {
    const { t, ada, p1 } = await world();
    const authed = t.withIdentity({ subject: `${ada}|session` });
    await authed.mutation(api.dispatch.dispatch, { action: "createSession", args: [{ agent_type: "claude_code", session_id: "stub-start", priority: "pri-1", priority_step: "s2" }] });
    const conv = await t.run((ctx: any) => ctx.db.query("conversations").withIndex("by_session_id", (q: any) => q.eq("session_id", "stub-start")).first());
    expect([String(conv.priority_id), conv.priority_step_key]).toEqual([String(p1), "s2"]);
    expect((await t.run((ctx: any) => ctx.db.get(p1))).session_count).toBe(3);
  });

  const startIn = (t: any, ada: Id<"users">, session_id: string, start: Record<string, string>, agent_type = "claude_code") =>
    t.withIdentity({ subject: `${ada}|session` }).mutation(api.dispatch.dispatch, { action: "createSession", args: [{ agent_type, session_id, ...start }] });
  const bySession = (t: any, session_id: string) => t.run((ctx: any) => ctx.db.query("conversations").withIndex("by_session_id", (q: any) => q.eq("session_id", session_id)).first());
  const planNamed = (t: any, short_id: string) => t.run((ctx: any) => ctx.db.query("plans").withIndex("by_short_id", (q: any) => q.eq("short_id", short_id)).first());

  test("Start with the milestone's own plan binds the session to it, as a plan bind does", async () => {
    const { t, ada, p1 } = await world();
    // pl-1 holds ct-3, half of s5's tasks: s5's plan by the attribution rules.
    await startIn(t, ada, "stub-plan", { priority: "pri-1", priority_step: "s5", plan: "pl-1" });
    const conv = await bySession(t, "stub-plan");
    const plan = await planNamed(t, "pl-1");
    expect(String(conv.active_plan_id)).toBe(String(plan._id));
    expect(conv.plan_ids.map(String)).toEqual([String(plan._id)]);
    expect(plan.session_ids.map(String)).toContain(String(conv._id));
    expect(String(plan.current_session_id)).toBe(String(conv._id));
    expect([String(conv.priority_id), conv.priority_step_key]).toEqual([String(p1), "s5"]);
  });

  test("a plan that is not the milestone's binds nothing, though the milestone still links", async () => {
    const { t, ada, p1 } = await world();
    // s2 names only a PR: no plan is its own, and pri-1 has no plan.
    await startIn(t, ada, "stub-other-step", { priority: "pri-1", priority_step: "s2", plan: "pl-1" });
    const conv = await bySession(t, "stub-other-step");
    expect(conv.active_plan_id).toBeUndefined();
    expect((await planNamed(t, "pl-1")).current_session_id).toBeUndefined();
    expect([String(conv.priority_id), conv.priority_step_key]).toEqual([String(p1), "s2"]);
  });

  test("a teammate's team plan binds nothing", async () => {
    const { t, ada, bea } = await world();
    await t.run(async (ctx: any) => {
      const team = await ctx.db.insert("teams", { name: "Acme", created_at: NOW } as any);
      for (const u of [ada, bea]) await ctx.db.insert("team_memberships", { user_id: u, team_id: team, role: "member", joined_at: NOW } as any);
      await ctx.db.insert("plans", { user_id: bea, team_id: team, workspace: `team:${team}`, short_id: "pl-9", title: "Bea's plan", status: "active", source: "human", created_at: NOW, updated_at: NOW } as any);
    });
    await startIn(t, ada, "stub-team-plan", { priority: "pri-1", priority_step: "s5", plan: "pl-9" });
    expect((await bySession(t, "stub-team-plan")).active_plan_id).toBeUndefined();
    expect((await planNamed(t, "pl-9")).current_session_id).toBeUndefined();
  });

  test("a plan with no valid priority beside it binds nothing", async () => {
    const { t, ada } = await world();
    await startIn(t, ada, "stub-bare-plan", { plan: "pl-1" });
    await startIn(t, ada, "stub-bea-pri", { priority: "pri-9", priority_step: "s1", plan: "pl-1" });
    await startIn(t, ada, "stub-no-pri", { priority: "pri-404", priority_step: "s5", plan: "pl-1" });
    for (const id of ["stub-bare-plan", "stub-bea-pri", "stub-no-pri"]) expect((await bySession(t, id)).active_plan_id).toBeUndefined();
    expect((await planNamed(t, "pl-1")).current_session_id).toBeUndefined();
  });

  test("a hosted Start links and binds when created, and a replayed create takes back nothing moved or rebound since", async () => {
    const { t, ada, p1, cFree } = await world();
    const start = { priority: "pri-1", priority_step: "s5", plan: "pl-1" };
    await startIn(t, ada, "stub-hosted", start, "codecast");
    const conv = await bySession(t, "stub-hosted");
    const plan = await planNamed(t, "pl-1");
    expect([String(conv.priority_id), conv.priority_step_key, String(conv.active_plan_id)]).toEqual([String(p1), "s5", String(plan._id)]);
    // A pass moves the session and another session takes the plan; then the outbox re-fires the create.
    await t.run(async (ctx: any) => {
      await ctx.db.patch(conv._id, { priority_step_key: "s3" });
      await ctx.db.patch(plan._id, { current_session_id: cFree });
    });
    await startIn(t, ada, "stub-hosted", start, "codecast");
    expect((await bySession(t, "stub-hosted")).priority_step_key).toBe("s3");
    expect(String((await planNamed(t, "pl-1")).current_session_id)).toBe(String(cFree));
  });

  test("Start on someone else's priority maps nothing", async () => {
    const { t, ada } = await world();
    await t.withIdentity({ subject: `${ada}|session` }).mutation(api.dispatch.dispatch, { action: "createSession", args: [{ agent_type: "claude_code", session_id: "stub-other", priority: "pri-9", priority_step: "s1" }] });
    const conv = await t.run((ctx: any) => ctx.db.query("conversations").withIndex("by_session_id", (q: any) => q.eq("session_id", "stub-other")).first());
    expect(conv.priority_id).toBeUndefined();
  });

  test("`cast task start` on a task a milestone names", async () => {
    const { t, p1, cFree } = await world();
    await t.mutation(api.tasks.update, { api_token: TOKEN, short_id: "ct-1", status: "in_progress", conversation_id: "sess-jx7free" });
    const conv = await convOf(t, cFree);
    expect([String(conv.priority_id), conv.priority_step_key]).toEqual([String(p1), "s1"]);
  });

  test("a plan bind where the plan holds at least half of a milestone's tasks, and not over an existing link", async () => {
    const { t, p1, cFree, cPin } = await world();
    await t.mutation(api.plans.bindSession, { api_token: TOKEN, short_id: "pl-1", session_id: "sess-jx7free" });
    const conv = await convOf(t, cFree);
    expect([String(conv.priority_id), conv.priority_step_key]).toEqual([String(p1), "s5"]);
    await t.mutation(api.plans.bindSession, { api_token: TOKEN, short_id: "pl-1", session_id: "sess-jx7pin1" });
    expect((await convOf(t, cPin)).priority_step_key).toBe("s3");
  });

  test("a Task-tool subagent the daemon syncs rolls up under its parent: no link, no count", async () => {
    const { t, ada, p1, cPin } = await world();
    const child = await t.mutation(api.conversations.createConversation, {
      api_token: TOKEN, user_id: ada, agent_type: "claude_code", session_id: "sub-1", project_path: "/tmp/x", parent_conversation_id: String(cPin),
    } as any);
    expect((await convOf(t, child)).priority_id).toBeUndefined();
    expect((await t.run((ctx: any) => ctx.db.get(p1))).session_count).toBe(2);
  });

  test("a handoff inherits its source's milestone", async () => {
    const { t, ada, p1, cDec } = await world();
    const { conversationId } = await t.run(async (ctx: any) => spawnSessionCore(ctx, ada, { handoffFrom: await ctx.db.get(cDec), projectPath: "/tmp/x" }));
    const conv = await convOf(t, conversationId);
    expect([String(conv.priority_id), conv.priority_step_key]).toEqual([String(p1), "s4"]);
  });

  test("a fork another person makes of a shared session is not mapped to the owner's priority", async () => {
    const { t, bea, cDec } = await world();
    await t.run((ctx: any) => ctx.db.patch(cDec, { share_token: "share-dec" }));
    const forkId = await t.withIdentity({ subject: `${bea}|session` }).mutation(api.conversations.forkConversation, { share_token: "share-dec" });
    const conv = await convOf(t, forkId);
    expect(String(conv.user_id)).toBe(String(bea));
    expect(conv.priority_id).toBeUndefined();
  });

  test("Start from a session listed to a team never maps it to a personal priority", async () => {
    const { t, ada } = await world();
    const conv = await t.run(async (ctx: any) => {
      const acme = await ctx.db.insert("teams", { name: "Acme", created_at: NOW });
      await ctx.db.insert("team_memberships", { user_id: ada, team_id: acme, role: "member", joined_at: 1 });
      return ctx.db.insert("conversations", {
        user_id: ada, team_id: acme, agent_type: "claude_code", session_id: "sess-listed", short_id: "jx7list", title: "listed",
        started_at: NOW, updated_at: NOW, message_count: 1, is_private: false, team_visibility: "full", status: "active",
      });
    });
    expect(await t.run((ctx: any) => linkFromStart(ctx, ada, conv, "pri-1", "s2"))).toBe(false);
    expect((await convOf(t, conv)).priority_id).toBeUndefined();
  });

  test("a `cast spawn --subagent` worker inherits its parent's milestone", async () => {
    const { t, ada, p1, cDec } = await world();
    const { conversationId } = await t.run((ctx: any) => spawnSessionCore(ctx, ada, { subagentFields: { parent_conversation_id: cDec, is_subagent: true }, projectPath: "/tmp/x" }));
    const conv = await convOf(t, conversationId);
    expect([String(conv.priority_id), conv.priority_step_key]).toEqual([String(p1), "s4"]);
  });

  test("a fork inherits its source's milestone", async () => {
    const { t, p1 } = await world();
    const res: any = await t.mutation(api.conversations.forkFromMessage, { api_token: TOKEN, conversation_id: "jx7dec1" });
    const forkId = res?.conversation_id ?? res;
    const conv = await convOf(t, forkId);
    expect([String(conv.priority_id), conv.priority_step_key]).toEqual([String(p1), "s4"]);
  });
});

describe("the person's corrections stand against evidence and links", () => {
  const setStep = (t: any, p: Id<"priorities">, key: string, fields: Record<string, unknown>) => t.run(async (ctx: any) => {
    const row = await ctx.db.get(p);
    await ctx.db.patch(p, { steps: row.steps.map((s: any) => (s.key === key ? { ...s, ...fields } : s)) });
  });

  test("evidence never overwrites a done state the person set", async () => {
    const { t, p1, ct1, ct5 } = await world();
    await setStep(t, p1, "s1", { done: true, done_at: NOW - 5 * H, done_set_by: "person" });
    await setStep(t, p1, "s6", { done: false, done_set_by: "person" });
    await t.run(async (ctx: any) => patchTask(ctx, await ctx.db.get(ct1), { status: "done", closed_at: NOW - H }));
    expect(await stepOf(t, p1, "s1")).toMatchObject({ done: true, done_at: NOW - 5 * H });
    await t.run(async (ctx: any) => patchTask(ctx, await ctx.db.get(ct1), { status: "in_progress", closed_at: undefined }));
    expect(await stepOf(t, p1, "s1")).toMatchObject({ done: true, done_at: NOW - 5 * H });
    await t.run(async (ctx: any) => patchTask(ctx, await ctx.db.get(ct5), { status: "done", closed_at: NOW - H }));
    expect((await stepOf(t, p1, "s6")).done).toBe(false);
  });

  test("evidence never touches a milestone the person dropped", async () => {
    const { t, p1, ct5 } = await world();
    await setStep(t, p1, "s6", { dropped: true });
    await t.run(async (ctx: any) => patchTask(ctx, await ctx.db.get(ct5), { status: "done", closed_at: NOW - H }));
    expect(await stepOf(t, p1, "s6")).toMatchObject({ done: false, dropped: true });
  });

  test("a link never moves a session the person placed", async () => {
    const { t, p1, cFree } = await world();
    await t.run((ctx: any) => ctx.db.patch(cFree, { priority_id: p1, priority_step_key: "s3", priority_set_by: "person" }));
    await t.mutation(api.tasks.update, { api_token: TOKEN, short_id: "ct-1", status: "in_progress", conversation_id: "sess-jx7free" });
    expect((await convOf(t, cFree)).priority_step_key).toBe("s3");
  });

  test("a link never maps a session to a priority the person said it is not part of", async () => {
    const { t, p1, cFree } = await world();
    await t.run((ctx: any) => ctx.db.patch(cFree, { priority_not: [p1] }));
    await t.mutation(api.tasks.update, { api_token: TOKEN, short_id: "ct-1", status: "in_progress", conversation_id: "sess-jx7free" });
    expect((await convOf(t, cFree)).priority_id).toBeUndefined();
  });

  test("a link never maps a session to a milestone the person dropped", async () => {
    const { t, ada, p1, cFree } = await world();
    await setStep(t, p1, "s1", { dropped: true });
    await t.mutation(api.tasks.update, { api_token: TOKEN, short_id: "ct-1", status: "in_progress", conversation_id: "sess-jx7free" });
    expect((await convOf(t, cFree)).priority_id).toBeUndefined();
    expect(await t.run((ctx: any) => linkFromStart(ctx, ada, cFree, "pri-1", "s1"))).toBe(false);
    expect((await convOf(t, cFree)).priority_id).toBeUndefined();
  });
});

describe("an inbound issue sync closing or reopening a task", () => {
  test("recomputes the milestone naming it, at the close's time", async () => {
    const { ctx, tables } = engineCtx({
      tasks: [{ ...structuredClone(TASK), workspace: "team:team_cc" }], issue_sync_sources: [SOURCE], users: [ADA], task_history: [], task_comments: [],
      conversations: [], entity_conversations: [],
      priorities: [{
        _id: "pri_1", user_id: "user_owner", workspace: "team:team_cc", short_id: "pri-1", title: "Sync", summary: "", status: "active",
        steps: [step("s1", [{ kind: "task", id: "ct-1" }])], first_seen_at: NOW, last_active_at: NOW, pass_at: NOW, created_at: NOW, updated_at: NOW,
      }],
    });
    await apply(ctx, { source_id: "src_1", issue: sameIssue({ state: { id: "s_done", name: "Done", type: "completed" } }) });
    const closedAt = tables.tasks[0].closed_at;
    expect(tables.priorities[0].steps[0]).toMatchObject({ done: true, done_at: closedAt });
    await apply(ctx, { source_id: "src_1", issue: sameIssue({ state: { id: "s_doing", name: "In Progress", type: "started" }, updatedAt: "2026-09-01T12:00:00.000Z" }) });
    expect(tables.tasks[0].status).toBe("in_progress");
    expect(tables.priorities[0].steps[0].done).toBe(false);
  });
});
