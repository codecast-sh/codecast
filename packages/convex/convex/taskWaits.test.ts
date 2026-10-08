// Waits (docs/architecture/task-graph.md TG2): a wait checks its target when it
// is set, settles on the PR, decision or time event it names, and the moment a
// task's last blocker clears (a wait, or a blocker task closing) the task is
// told once and its owning session is woken.
import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { hashToken } from "./apiTokens";
import { addWait, removeWait, settleTimeWait } from "./taskWaits";
import { firePrTrigger } from "./prShepherd";
import { reopenCore, settleClientResolution, withdrawCore } from "./sessionDecisions";
import { update } from "./tasks";

const USER = "u_user";
const TEAM = "team_1";
const TOKEN = "task-waits-test-token";
const REPO = "acme/app";

async function makeCtx(over: Record<string, any[]> = {}) {
  const tables: Record<string, any[]> = {
    users: [{ _id: USER, name: "User" }, { _id: "u_bob", name: "Bob" }],
    api_tokens: [{ _id: "token_1", user_id: USER, token_hash: await hashToken(TOKEN) }],
    team_memberships: [{ _id: "tm_1", user_id: USER, team_id: TEAM, role: "member" }],
    tasks: [],
    task_history: [],
    task_comments: [],
    pull_requests: [],
    session_decisions: [],
    conversations: [],
    pending_messages: [],
    notifications: [],
    ...over,
  };
  const scheduled: any[] = [];
  const ctx: any = {
    auth: { async getUserIdentity() { return { subject: `${USER}|session` }; } },
    db: makeFakeDb(tables),
    scheduler: {
      runAfter: async () => null,
      runAt: async (at: number, _fn: any, args: any) => { scheduled.push({ at, args }); return null; },
    },
    runMutation: async () => null,
  };
  return { ctx, tables, scheduled };
}

const task = (shortId: string, over: any = {}) => ({
  _id: `task_${shortId}`,
  short_id: shortId,
  user_id: USER,
  title: `Task ${shortId}`,
  status: "open",
  priority: "medium",
  source: "human",
  created_at: 1,
  updated_at: 1,
  ...over,
});

const pr = (number: number, over: any = {}) => ({
  _id: `pr_${number}`,
  team_id: TEAM,
  github_pr_id: number,
  repository: REPO,
  number,
  title: `PR ${number}`,
  body: "",
  state: "open",
  author_github_username: "someone",
  linked_session_ids: [],
  created_at: 1,
  updated_at: 1,
  ...over,
});

const decision = (n: number, over: any = {}) => ({
  _id: `dec_${n}`,
  short_id: `sd-${n}`,
  conversation_id: "conv_asker",
  session_id: "s",
  user_id: USER,
  question: "Ship it?",
  options: [{ label: "Ship it" }, { label: "Hold" }],
  status: "pending",
  created_at: 1,
  ...over,
});

/** A session bound to the task: it owns it (lib/taskOwner). */
const owner = (taskShortId: string) => ({
  _id: "conv_owner",
  short_id: "jx7own",
  user_id: USER,
  status: "active",
  active_task_id: `task_${taskShortId}`,
  updated_at: 1,
});

const row = (tables: Record<string, any[]>, shortId: string) => tables.tasks.find((t) => t.short_id === shortId);
const comments = (tables: Record<string, any[]>, shortId: string) =>
  tables.task_comments.filter((c) => c.task_id === `task_${shortId}`).map((c) => `${c.comment_type}: ${c.text}`);
const wakes = (tables: Record<string, any[]>) => tables.pending_messages.map((m) => m.content as string);
const call = (fn: any, ctx: any, args: any) => fn._handler(ctx, { api_token: TOKEN, ...args });

describe("setting a wait", () => {
  test("a PR still open waits, and the task enters by_waiting_since", async () => {
    const { ctx, tables } = await makeCtx({ tasks: [task("ct-1")], pull_requests: [pr(42)] });
    const res = await call(addWait, ctx, { short_id: "ct-1", ref: `${REPO}#42` });
    expect(res.met).toBe(false);
    expect(res.wait).toMatchObject({ kind: "pr_merged", repository: REPO, pr_number: 42, state: "waiting", created_by: USER });
    expect(row(tables, "ct-1").waiting_since).toBeNumber();
    expect(tables.task_history.map((h) => [h.field, h.old_value, h.new_value])).toEqual([["waits", "", "Waiting on PR #42"]]);
  });

  test("a PR already merged is met at once and says so", async () => {
    const { ctx, tables } = await makeCtx({ tasks: [task("ct-1")], pull_requests: [pr(42, { state: "merged" })] });
    const res = await call(addWait, ctx, { short_id: "ct-1", ref: `${REPO}#42` });
    expect(res.met).toBe(true);
    expect(res.wait).toMatchObject({ state: "met", note: "already merged" });
    expect(row(tables, "ct-1").waiting_since).toBeUndefined();
  });

  test("checks already green meet a checks wait at once", async () => {
    const { ctx } = await makeCtx({ tasks: [task("ct-1")], pull_requests: [pr(42, { checks_state: "success" })] });
    const res = await call(addWait, ctx, { short_id: "ct-1", ref: `${REPO}#42:checks` });
    expect(res.wait).toMatchObject({ kind: "pr_checks_green", state: "met", note: "checks already green" });
  });

  test("a PR codecast cannot see is refused with the reason", async () => {
    const { ctx, tables } = await makeCtx({ tasks: [task("ct-1")] });
    await expect(call(addWait, ctx, { short_id: "ct-1", ref: `${REPO}#7` })).rejects.toThrow(/cannot see PR acme\/app#7/);
    expect(row(tables, "ct-1").waits).toBeUndefined();
  });

  test("a PR closed without merging is refused: it would never clear", async () => {
    const { ctx } = await makeCtx({ tasks: [task("ct-1")], pull_requests: [pr(42, { state: "closed" })] });
    await expect(call(addWait, ctx, { short_id: "ct-1", ref: `${REPO}#42` })).rejects.toThrow(/closed without merging/);
  });

  test("a bare #42 takes its repository from the task's sessions, else the caller's", async () => {
    const { ctx, tables } = await makeCtx({
      tasks: [task("ct-1", { conversation_ids: ["conv_x"] }), task("ct-2")],
      conversations: [{ _id: "conv_x", user_id: USER, git_remote_url: "git@github.com:Acme/App.git", updated_at: 1 }],
      pull_requests: [pr(42), pr(42, { _id: "pr_other", repository: "other/repo" })],
    });
    expect((await call(addWait, ctx, { short_id: "ct-1", ref: "#42", repository: "other/repo" })).wait.repository).toBe(REPO);
    expect((await call(addWait, ctx, { short_id: "ct-2", ref: "#42", repository: "Other/Repo" })).wait.repository).toBe("other/repo");
    await expect(call(addWait, ctx, { short_id: "ct-2", ref: "#43" })).rejects.toThrow(/names no repository/);
    expect(row(tables, "ct-2").waits).toHaveLength(1);
  });

  test("a bare #42 with two candidate repositories names them", async () => {
    const { ctx } = await makeCtx({
      tasks: [task("ct-1", { conversation_ids: ["conv_x", "conv_y"] })],
      conversations: [
        { _id: "conv_x", user_id: USER, git_remote_url: "https://github.com/acme/app", updated_at: 1 },
        { _id: "conv_y", user_id: USER, git_remote_url: "https://github.com/acme/web", updated_at: 1 },
      ],
      pull_requests: [pr(42), pr(42, { _id: "pr_web", repository: "acme/web" }), pr(9, { _id: "pr_9" })],
    });
    await expect(call(addWait, ctx, { short_id: "ct-1", ref: "#42" })).rejects.toThrow("acme/app#42, acme/web#42");
    // Only one of them has #9: that one.
    expect((await call(addWait, ctx, { short_id: "ct-1", ref: "#9" })).wait.repository).toBe(REPO);
  });

  test("the same target twice returns the wait already there", async () => {
    const { ctx, tables } = await makeCtx({ tasks: [task("ct-1")], pull_requests: [pr(42)] });
    const first = await call(addWait, ctx, { short_id: "ct-1", ref: `${REPO}#42` });
    const again = await call(addWait, ctx, { short_id: "ct-1", ref: `https://github.com/${REPO}/pull/42` });
    expect(again).toMatchObject({ existing: true, wait: { id: first.wait.id } });
    expect(row(tables, "ct-1").waits).toHaveLength(1);
  });

  test("the web's own wait id is kept, and a client target is rebuilt from its known fields", async () => {
    const { ctx, tables } = await makeCtx({ tasks: [task("ct-1")], session_decisions: [decision(4)] });
    const res = await call(addWait, ctx, { short_id: "ct-1", id: "w_client1", target: { kind: "decision", decision: "SD-4", state: "met", extra: 1 } });
    expect(res.wait.id).toBe("w_client1");
    expect(row(tables, "ct-1").waits[0]).toEqual({ kind: "decision", decision: "sd-4", id: "w_client1", state: "waiting", created_at: res.wait.created_at, created_by: USER });
    // A replay of the same write (the dispatch outbox retrying) adds nothing.
    expect((await call(addWait, ctx, { short_id: "ct-1", id: "w_client1", target: { kind: "decision", decision: "sd-4" } })).existing).toBe(true);
    await expect(call(addWait, ctx, { short_id: "ct-1", id: "bad id!", ref: "2h" })).rejects.toThrow(/wait id/);
  });

  test("a task ref is refused: it is a dependency, not a wait", async () => {
    const { ctx } = await makeCtx({ tasks: [task("ct-1")] });
    await expect(call(addWait, ctx, { short_id: "ct-1", ref: "ct-5" })).rejects.toThrow(/dependency/);
  });

  test("removing a wait by ref clears waiting_since and writes history", async () => {
    const { ctx, tables } = await makeCtx({ tasks: [task("ct-1")], pull_requests: [pr(42)] });
    await call(addWait, ctx, { short_id: "ct-1", ref: `${REPO}#42` });
    const { removed } = await call(removeWait, ctx, { short_id: "ct-1", ref: "#42" });
    expect(removed).toHaveLength(1);
    expect(row(tables, "ct-1").waits).toEqual([]);
    expect(row(tables, "ct-1").waiting_since).toBeUndefined();
    expect(tables.task_history.at(-1)).toMatchObject({ field: "waits", old_value: "Waiting on PR #42", new_value: "" });
  });
});

describe("PR events", () => {
  test("a merge meets the wait, unblocks the task and wakes the session that owns it", async () => {
    const { ctx, tables } = await makeCtx({
      tasks: [task("ct-1", { status: "in_progress", conversation_ids: ["conv_owner"] })],
      conversations: [owner("ct-1")],
      pull_requests: [pr(42)],
    });
    await call(addWait, ctx, { short_id: "ct-1", ref: `${REPO}#42` });
    await firePrTrigger(ctx, "pr_merged", pr(42, { state: "merged" }) as any);

    expect(row(tables, "ct-1").waits[0]).toMatchObject({ state: "met", note: "merged" });
    expect(row(tables, "ct-1").waiting_since).toBeUndefined();
    expect(comments(tables, "ct-1")).toEqual(["note: Unblocked: PR #42 merged"]);
    expect(wakes(tables)).toHaveLength(1);
    expect(wakes(tables)[0]).toContain("ct-1 (\"Task ct-1\") is unblocked: PR #42 merged");

    // The same event again finds nothing waiting: unblock ran once.
    await firePrTrigger(ctx, "pr_merged", pr(42, { state: "merged" }) as any);
    expect(comments(tables, "ct-1")).toHaveLength(1);
    expect(wakes(tables)).toHaveLength(1);
  });

  test("a close without merging fails the wait, which keeps blocking and asks the owner to re-plan", async () => {
    const { ctx, tables } = await makeCtx({
      tasks: [task("ct-1", { conversation_ids: ["conv_owner"] })],
      conversations: [owner("ct-1")],
      pull_requests: [pr(42)],
    });
    await call(addWait, ctx, { short_id: "ct-1", ref: `${REPO}#42` });
    await firePrTrigger(ctx, "pr_closed", pr(42, { state: "closed" }) as any);

    expect(row(tables, "ct-1").waits[0]).toMatchObject({ state: "failed", note: "closed without merging" });
    expect(comments(tables, "ct-1")).toEqual(["blocker: Still blocked: PR #42 merges (failed: closed without merging). This wait can no longer clear."]);
    expect(wakes(tables)[0]).toContain("needs a new plan");
  });

  test("checks green meets a checks wait and leaves a merge wait on the same PR waiting", async () => {
    const { ctx, tables } = await makeCtx({ tasks: [task("ct-1")], pull_requests: [pr(42)] });
    await call(addWait, ctx, { short_id: "ct-1", ref: `${REPO}#42:ci` });
    await call(addWait, ctx, { short_id: "ct-1", ref: `${REPO}#42` });
    await firePrTrigger(ctx, "pr_checks_green", pr(42, { checks_state: "success" }) as any);

    const [checks, merge] = row(tables, "ct-1").waits;
    expect(checks).toMatchObject({ kind: "pr_checks_green", state: "met" });
    expect(merge).toMatchObject({ kind: "pr_merged", state: "waiting" });
    // Still blocked by the merge wait: no unblock yet.
    expect(comments(tables, "ct-1")).toEqual([]);
    expect(row(tables, "ct-1").waiting_since).toBeNumber();
  });

  test("an event on another repository's PR with the same number leaves the wait alone", async () => {
    const { ctx, tables } = await makeCtx({ tasks: [task("ct-1")], pull_requests: [pr(42)] });
    await call(addWait, ctx, { short_id: "ct-1", ref: `${REPO}#42` });
    await firePrTrigger(ctx, "pr_merged", pr(42, { repository: "other/repo", state: "merged" }) as any);
    expect(row(tables, "ct-1").waits[0].state).toBe("waiting");
  });

  test("a PR of a team the task's owner is not in does not settle it", async () => {
    const { ctx, tables } = await makeCtx({ tasks: [task("ct-1")], pull_requests: [pr(42)] });
    await call(addWait, ctx, { short_id: "ct-1", ref: `${REPO}#42` });
    await firePrTrigger(ctx, "pr_merged", pr(42, { team_id: "team_other", state: "merged" }) as any);
    expect(row(tables, "ct-1").waits[0].state).toBe("waiting");
  });

  test("with no owning session, a person assigned the task is notified", async () => {
    const { ctx, tables } = await makeCtx({ tasks: [task("ct-1", { assignee: "u_bob" })], pull_requests: [pr(42)] });
    await call(addWait, ctx, { short_id: "ct-1", ref: `${REPO}#42` });
    await firePrTrigger(ctx, "pr_merged", pr(42, { state: "merged" }) as any);
    expect(wakes(tables)).toEqual([]);
    expect(tables.notifications.map((n) => [n.type, n.recipient_user_id, n.message])).toEqual([
      ["task_unblocked", "u_bob", "ct-1 is unblocked: PR #42 merged"],
    ]);
  });
});

describe("decision waits", () => {
  test("answering meets the wait with the answer; reopening puts it back to waiting", async () => {
    const { ctx, tables } = await makeCtx({ tasks: [task("ct-1")], session_decisions: [decision(4)] });
    await call(addWait, ctx, { short_id: "ct-1", ref: "sd-4" });
    expect(tables.session_decisions[0].waiting_task_ids).toEqual(["task_ct-1"]);

    const pending = { ...tables.session_decisions[0] };
    await settleClientResolution(ctx, pending as any, { status: "answered", answer_index: 0 }, USER as any, Date.now());
    expect(row(tables, "ct-1").waits[0]).toMatchObject({ state: "met", note: "answered: Ship it" });
    expect(comments(tables, "ct-1")).toEqual(["note: Unblocked: sd-4 answered: Ship it"]);

    // Reopen applies to an answer a role gave under a grant.
    Object.assign(tables.session_decisions[0], { status: "answered", answered_by: { kind: "role", id: "r1" }, grant_id: "g1" });
    expect((await reopenCore(ctx, USER as any, "dec_4" as any)).reopened).toBe(true);
    const wait = row(tables, "ct-1").waits[0];
    expect(wait.state).toBe("waiting");
    expect("note" in wait || "settled_at" in wait).toBe(false);
    expect(row(tables, "ct-1").waiting_since).toBeNumber();
  });

  test("withdrawing fails the wait", async () => {
    const { ctx, tables } = await makeCtx({ tasks: [task("ct-1")], session_decisions: [decision(4)] });
    await call(addWait, ctx, { short_id: "ct-1", ref: "sd-4" });
    await withdrawCore(ctx, { ...tables.session_decisions[0] } as any, Date.now());
    expect(row(tables, "ct-1").waits[0]).toMatchObject({ state: "failed", note: "withdrawn" });
    expect(comments(tables, "ct-1")[0]).toStartWith("blocker: Still blocked: sd-4 answered (failed: withdrawn)");
  });

  test("an answered decision is met at once; a dismissed one is refused", async () => {
    const { ctx } = await makeCtx({
      tasks: [task("ct-1")],
      session_decisions: [decision(4, { status: "answered", answer_index: 1 }), decision(5, { status: "dismissed" })],
    });
    expect((await call(addWait, ctx, { short_id: "ct-1", ref: "sd-4" })).wait).toMatchObject({ state: "met", note: "already answered: Hold" });
    await expect(call(addWait, ctx, { short_id: "ct-1", ref: "sd-5" })).rejects.toThrow(/dismissed/);
    await expect(call(addWait, ctx, { short_id: "ct-1", ref: "sd-6" })).rejects.toThrow(/No decision sd-6/);
  });
});

describe("time waits", () => {
  test("a time wait schedules its job, which meets it; a removed wait is left alone", async () => {
    const { ctx, tables, scheduled } = await makeCtx({ tasks: [task("ct-1"), task("ct-2")] });
    const { wait } = await call(addWait, ctx, { short_id: "ct-1", ref: "2h" });
    expect(scheduled).toEqual([{ at: wait.at, args: { task_id: "task_ct-1", wait_id: wait.id, at: wait.at } }]);
    await (settleTimeWait as any)._handler(ctx, scheduled[0].args);
    expect(row(tables, "ct-1").waits[0]).toMatchObject({ state: "met", note: "passed" });
    expect(comments(tables, "ct-1")[0]).toMatch(/^note: Unblocked: .* passed$/);

    const second = await call(addWait, ctx, { short_id: "ct-2", ref: "3d" });
    await call(removeWait, ctx, { short_id: "ct-2", wait_id: second.wait.id });
    await (settleTimeWait as any)._handler(ctx, scheduled[1].args);
    expect(row(tables, "ct-2").waits).toEqual([]);
    expect(comments(tables, "ct-2")).toEqual([]);
  });

  test("a date with the person's zone lands on their wall time", async () => {
    const { ctx } = await makeCtx({ tasks: [task("ct-1")] });
    const { wait } = await call(addWait, ctx, { short_id: "ct-1", ref: "2099-01-15T09:00", time_zone: "America/New_York" });
    expect(new Date(wait.at).toISOString()).toBe("2099-01-15T14:00:00.000Z");
  });
});

describe("blocker tasks closing", () => {
  test("the last open blocker closing unblocks its dependent once; an earlier one does not", async () => {
    const { ctx, tables } = await makeCtx({
      tasks: [
        task("ct-1", { blocks: ["ct-3"] }),
        task("ct-2", { blocks: ["ct-3"] }),
        task("ct-3", { blocked_by: ["ct-1", "ct-2"], conversation_ids: ["conv_owner"] }),
      ],
      conversations: [owner("ct-3")],
    });
    await call(update, ctx, { short_id: "ct-1", status: "done" });
    expect(comments(tables, "ct-3")).toEqual([]);
    await call(update, ctx, { short_id: "ct-2", status: "dropped" });
    expect(comments(tables, "ct-3")).toEqual(["note: Unblocked: ct-2 dropped"]);
    expect(wakes(tables)).toHaveLength(1);
    // Moving it again between closed states is not a new unblock.
    await call(update, ctx, { short_id: "ct-2", status: "done" });
    expect(comments(tables, "ct-3")).toHaveLength(1);
  });

  test("a dependent that still has a wait stays blocked when its blocker task closes", async () => {
    const { ctx, tables } = await makeCtx({
      tasks: [task("ct-1", { blocks: ["ct-2"] }), task("ct-2", { blocked_by: ["ct-1"] })],
      pull_requests: [pr(42)],
    });
    await call(addWait, ctx, { short_id: "ct-2", ref: `${REPO}#42` });
    await call(update, ctx, { short_id: "ct-1", status: "done" });
    expect(comments(tables, "ct-2")).toEqual([]);
    await firePrTrigger(ctx, "pr_merged", pr(42, { state: "merged" }) as any);
    expect(comments(tables, "ct-2")).toEqual(["note: Unblocked: PR #42 merged"]);
  });
});
