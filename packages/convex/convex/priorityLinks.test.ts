// Evidence marks milestones done, and known links are set at creation
// (lib/priorityLinks.ts): each evidence kind recomputes the milestone with
// done_at = the evidence's own time, and each known link maps a session with
// no pass run.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { allModules } from "./testModules.testkit";
import { api } from "./_generated/api";
import { hashToken } from "./apiTokens";
import { patchTask } from "./lib/taskWrite";
import { patchPullRequest } from "./prShepherd";
import { spawnSessionCore } from "./spawn";
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
    const ws = `user:${ada}`;
    const p1 = await ctx.db.insert("priorities", {
      user_id: ada, workspace: ws, short_id: "pri-1", title: "Ship it", summary: "", status: "active", rank: 1, rank_set_by: "pass",
      steps: [step("s1", [{ kind: "task", id: "ct-1" }]), step("s2", [{ kind: "pr", id: `${REPO}#5` }]), step("s3"), step("s4"), step("s5", [{ kind: "task", id: "ct-3" }, { kind: "task", id: "ct-4" }])],
      first_seen_at: NOW, last_active_at: NOW, pass_at: NOW, created_at: NOW, updated_at: NOW, session_count: 2,
    } as any);
    const p9 = await ctx.db.insert("priorities", {
      user_id: bea, workspace: `user:${bea}`, short_id: "pri-9", title: "Bea's", summary: "", status: "active", rank: 1, rank_set_by: "pass",
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
    await task("ct-3", { plan_id: plan });
    await task("ct-4");
    const pr = await ctx.db.insert("pull_requests", {
      repository: REPO, number: 5, github_pr_id: 1005, title: "PR 5", body: "", state: "open", author_github_username: "ada",
      linked_session_ids: [cPr], created_at: NOW, updated_at: NOW,
    } as any);
    return { ada, bea, p1, p9, cTask, cPr, cPin, cDec, cFree, ct1, pr };
  });
  return { t, ...ids };
}

const stepOf = async (t: any, p: Id<"priorities">, key: string) => (await t.run((ctx: any) => ctx.db.get(p))).steps.find((s: any) => s.key === key);
const convOf = (t: any, id: Id<"conversations">) => t.run((ctx: any) => ctx.db.get(id));

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

  test("a linked PR merging: done_at is the merge", async () => {
    const { t, p1, pr } = await world();
    const mergedAt = NOW - 2 * H;
    await t.run((ctx: any) => patchPullRequest(ctx, pr, { state: "merged", merged_at: mergedAt }));
    expect(await stepOf(t, p1, "s2")).toMatchObject({ done: true, done_at: mergedAt });
  });

  test("a decision answered on a mapped session: done_at is the answer", async () => {
    const { t, ada, p1, cDec } = await world();
    const decision = await t.run((ctx: any) => ctx.db.insert("session_decisions", {
      conversation_id: cDec, session_id: "sess-jx7dec1", user_id: ada, question: "Flip the flag?", options: [{ label: "Yes" }, { label: "No" }],
      blocking: true, status: "pending", created_at: NOW,
    }));
    await t.withIdentity({ subject: `${ada}|session` }).mutation(api.sessionDecisions.resolve, { decision_id: decision, status: "answered", answer_index: 0 });
    const row = await t.run((ctx: any) => ctx.db.get(decision));
    expect(row.resolved_at).toBeNumber();
    expect(await stepOf(t, p1, "s4")).toMatchObject({ done: true, done_at: row.resolved_at });
  });

  test("a pin declared done on a mapped session: done_at is the pin, and a later pin keeps it", async () => {
    const { t, p1, cPin } = await world();
    await t.mutation(api.conversations.setThreadState, { api_token: TOKEN, session: "jx7pin1", text: "Shipped", status: "done" });
    const pinnedAt = (await convOf(t, cPin)).thread_state_at;
    expect(await stepOf(t, p1, "s3")).toMatchObject({ done: true, done_at: pinnedAt });
    await new Promise((r) => setTimeout(r, 5));
    await t.mutation(api.conversations.setThreadState, { api_token: TOKEN, session: "jx7pin1", text: "Shipped again", status: "done" });
    expect((await stepOf(t, p1, "s3")).done_at).toBe(pinnedAt);
  });

  test("in a team workspace, through a session listed to the team", async () => {
    const { t, ada } = await world();
    const { p, task } = await t.run(async (ctx: any) => {
      const acme = await ctx.db.insert("teams", { name: "Acme", created_at: NOW, features: { priorities: true } });
      await ctx.db.insert("team_memberships", { user_id: ada, team_id: acme, role: "member", joined_at: 1 });
      const ws = `team:${acme}`;
      const p = await ctx.db.insert("priorities", {
        user_id: ada, workspace: ws, short_id: "pri-2", title: "Team", summary: "", status: "active", rank: 1, rank_set_by: "pass",
        steps: [step("s1", [{ kind: "task", id: "ct-20" }])], first_seen_at: NOW, last_active_at: NOW, pass_at: NOW, created_at: NOW, updated_at: NOW,
      });
      const c = await ctx.db.insert("conversations", {
        user_id: ada, team_id: acme, agent_type: "claude_code", session_id: "sess-team", short_id: "jx7team", title: "team",
        started_at: NOW, updated_at: NOW, message_count: 1, is_private: false, team_visibility: "full", status: "active",
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

  test("a subagent the daemon syncs inherits its parent's milestone", async () => {
    const { t, ada, p1, cPin } = await world();
    const child = await t.mutation(api.conversations.createConversation, {
      api_token: TOKEN, user_id: ada, agent_type: "claude_code", session_id: "sub-1", project_path: "/tmp/x", parent_conversation_id: String(cPin),
    } as any);
    const conv = await convOf(t, child);
    expect([String(conv.priority_id), conv.priority_step_key]).toEqual([String(p1), "s3"]);
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
