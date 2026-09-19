import { describe, expect, test } from "bun:test";
import { getFunctionName } from "convex/server";
import { hashToken } from "./apiTokens";
import { cancelTask, completeTaskRun, insertTask, matchTaskTriggers, renewLease } from "./agentTasks";
import { matchPRToConversation, processCheckRunEvent, processPRClosedEvent, processReviewEvent, processReviewCommentEvent } from "./githubWebhooks";
import { shepherd, watchPRs } from "./prCli";
import { applyMergeState, bindPRToConversation, retire, wakeShepherd } from "./prShepherd";
import { syncPRFromGitHub, updatePRState, linkPRToSession, updatePRFiles } from "./pull_requests";
import { makeFakeDb } from "./testDb";

const USER = "user_1";
const TEAM = "team_1";
const CONV = "conv_1";
const TOKEN = "shepherd-test-token";
const REPO = "codecast-sh/codecast";
const call = (fn: any, ctx: any, args: any) => fn._handler(ctx, args);
const discovery = {
  event_id: "event_open", repository: REPO, pr_number: 12, github_pr_id: 555,
  head_ref: "fix-test", base_ref: "main", head_sha: "abc123", title: "Fix test", body: "",
  author_username: "ashot", created_at: 1, updated_at: 2,
};

async function fixture() {
  const scheduled: Array<{ name: string; args: any }> = [];
  const db = makeFakeDb({
    users: [{ _id: USER, name: "Ashot", github_username: "ashot" }],
    api_tokens: [{ _id: "token_1", user_id: USER, token_hash: await hashToken(TOKEN) }],
    team_memberships: [{ _id: "membership_1", user_id: USER, team_id: TEAM, role: "member" }],
    github_app_installations: [{ _id: "install_1", team_id: TEAM, installation_id: 7, account_login: "codecast-sh", repository_selection: "all" }],
    conversations: [{ _id: CONV, user_id: USER, short_id: "jx7test", title: "Fix test", is_private: true, git_branch: "fix-test", git_remote_url: `git@github.com:${REPO}.git` }],
    github_webhook_events: [{ _id: "event_open", processed: false }],
    pull_requests: [], agent_tasks: [], reviews: [], review_comments: [], tasks: [],
  });
  const ctx = { db, scheduler: { runAfter: async (_delay: number, fn: any, args: any) => {
    scheduled.push({ name: getFunctionName(fn), args });
  } } } as any;
  const result = await call(matchPRToConversation, ctx, discovery);
  const pr = () => db._tables.pull_requests.find((row: any) => row._id === result.pr_id);
  const toggle = (action: "on" | "off") => call(shepherd, ctx, {
    api_token: TOKEN, repository: REPO, number: 12, action,
    ...(action === "on" ? { bind_session: "jx7test" } : {}),
  });
  const deliver = async (fn: any, eventType: string, action: string, payload: any) => {
    const id = await db.insert("github_webhook_events", {
      event_type: eventType, action, payload: JSON.stringify(payload), processed: false,
      delivery_id: `delivery-${db._tables.github_webhook_events.length}`,
    });
    return call(fn, ctx, { event_id: id });
  };
  const check = (conclusion: string) => deliver(processCheckRunEvent, "check_run", "completed", {
    repository: { full_name: REPO }, sender: { login: "github-actions[bot]", type: "Bot" },
    check_run: { id: 991, name: "test", status: "completed", conclusion, head_sha: "abc123",
      pull_requests: [{ number: 12 }], completed_at: "2026-09-14T10:00:00Z", html_url: "https://github.com/check/991" },
  });
  const close = (merged: boolean) => deliver(processPRClosedEvent, "pull_request", "closed", {
    repository: { full_name: REPO }, pull_request: { id: 555, number: 12, merged },
  });
  const drainWatches = async () => {
    for (const job of scheduled.splice(0)) {
      if (job.name === "agentTasks:matchTaskTriggers") await call(matchTaskTriggers, ctx, job.args);
    }
  };
  const watch = (eventType: string) => db.insert("agent_tasks", {
    user_id: USER, prompt: "Explicitly requested watch", status: "scheduled", schedule_type: "event",
    event_filter: { event_type: eventType, repository: REPO, pr_number: 12 },
  });
  return { ctx, db, pr, toggle, deliver, check, close, drainWatches, watch };
}

describe("passive discovery and explicit shepherd lifecycle", () => {
  test("discovery links the session and records failing GitHub checks without a wake", async () => {
    const f = await fixture();
    expect(f.pr().shepherd_enabled).toBe(false);
    expect(f.pr().shepherd_conversation_id).toBe(CONV);
    expect(f.pr().linked_session_ids).toContain(CONV);
    await f.check("failure");
    expect(f.db._tables.agent_tasks).toHaveLength(0);
    expect(f.pr().checks_state).toBe("failure");
    expect((await f.db.get(CONV)).pr_status.state).toBe("ci_red");
    const watched = await call(watchPRs, f.ctx, { api_token: TOKEN, repository: REPO });
    expect(watched.pull_requests[0].checks_state).toBe("failure");
    expect(watched.pull_requests[0].shepherd_enabled).toBe(false);
  });

  test("only explicit on arms a shepherd and a failing CI bot check remains actionable", async () => {
    const f = await fixture();
    await f.toggle("on");
    const task = async () => f.db.get(f.pr().shepherd_task_id);
    expect((await task()).run_at).toBeUndefined();
    await f.check("failure");
    expect((await task()).run_at).toBeGreaterThan(0);
    expect((await task()).prompt).toContain("a check failed");
    expect(f.pr().shepherd_wake_count).toBe(1);
  });

  test("explicit off survives rediscovery, implicit rebinding, commit linking and retries", async () => {
    const f = await fixture();
    await f.toggle("on");
    await f.toggle("off");
    const taskId = f.pr().shepherd_task_id;
    await call(matchPRToConversation, f.ctx, discovery);
    await call(bindPRToConversation, f.ctx, { pr_id: f.pr()._id, conversation_id: CONV });
    await f.db.insert("commits", { sha: "abc123", conversation_id: CONV });
    await call(linkPRToSession, f.ctx, { pr_id: f.pr()._id, commit_shas: ["abc123"] });
    await f.check("failure");
    expect(await wakeShepherd(f.ctx, f.pr()._id, "check_failed", undefined, 1)).toMatchObject({ woken: false });
    expect(f.pr().shepherd_enabled).toBe(false);
    expect((await f.db.get(taskId)).status).toBe("completed");
    expect(f.db._tables.agent_tasks).toHaveLength(1);
    await f.toggle("on");
    expect(f.pr().shepherd_task_id).not.toBe(taskId);
    await f.check("failure");
    expect(f.pr().shepherd_wake_count).toBe(1);
  });

  test("an implicit bind preserves an absent preference as off", async () => {
    const f = await fixture();
    await f.db.patch(f.pr()._id, { shepherd_enabled: undefined });
    await call(bindPRToConversation, f.ctx, { pr_id: f.pr()._id, conversation_id: CONV });
    await f.check("failure");
    expect(f.pr().shepherd_enabled).toBe(false);
    expect(f.db._tables.agent_tasks).toHaveLength(0);
  });

  test("behind-only and green keep explicit watches and status visibility without shepherd wakes", async () => {
    const f = await fixture();
    await f.toggle("on");
    const behindWatch = await f.watch("pr_behind");
    const greenWatch = await f.watch("pr_checks_green");
    await call(applyMergeState, f.ctx, { pr_id: f.pr()._id, mergeable: true, mergeable_state: "behind", behind_by: 3 });
    await f.check("success");
    await f.drainWatches();
    expect((await f.db.get(behindWatch)).run_at).toBeGreaterThan(0);
    expect((await f.db.get(greenWatch)).run_at).toBeGreaterThan(0);
    expect((await f.db.get(f.pr().shepherd_task_id)).run_at).toBeUndefined();
    expect(f.pr().shepherd_wake_count).toBe(0);
    expect(f.pr().behind_by).toBe(3);
    expect(f.pr().checks_state).toBe("success");
    await call(applyMergeState, f.ctx, { pr_id: f.pr()._id, mergeable: false, mergeable_state: "dirty" });
    expect(f.pr().shepherd_wake_count).toBe(1);
    expect((await f.db.get(f.pr().shepherd_task_id)).prompt).toContain("no longer merges cleanly");
  });

  test("a merge-state poll GitHub has not computed yet leaves the PR exactly where it was", async () => {
    const f = await fixture();
    await f.toggle("on");
    await call(applyMergeState, f.ctx, { pr_id: f.pr()._id, mergeable: false, mergeable_state: "dirty", behind_by: 113 });
    expect(f.pr().shepherd_state).toBe("conflicts");
    expect(f.pr().shepherd_wake_count).toBe(1);

    // A commit lands on main. GitHub answers null/"unknown" while it works out
    // whether the PR still merges. That is not news, and taking it as one used
    // to fold the row down to "behind" and write a timeline row for it.
    const pending = await call(applyMergeState, f.ctx, { pr_id: f.pr()._id, mergeable: null, mergeable_state: "unknown", behind_by: 114 });
    expect(pending.retry).toBe(true);
    expect(f.pr().shepherd_state).toBe("conflicts");
    expect(f.pr().mergeable_state).toBe("dirty");
    expect(f.pr().behind_by).toBe(114);
    expect(f.pr().shepherd_wake_count).toBe(1);

    // The computed answer arrives and says the same thing, so it stays quiet.
    await call(applyMergeState, f.ctx, { pr_id: f.pr()._id, mergeable: false, mergeable_state: "dirty", behind_by: 114 });
    expect(f.pr().shepherd_state).toBe("conflicts");
    expect(f.pr().shepherd_wake_count).toBe(1);
  });

  test("a failure queued during an active run is dropped if checks are green before the retry", async () => {
    const f = await fixture();
    await f.toggle("on");
    const task = await f.db.get(f.pr().shepherd_task_id);
    await f.db.patch(task._id, { status: "running" });
    await f.check("failure");
    expect(f.pr().shepherd_pending_reasons).toEqual(["check_failed"]);
    await f.check("success");
    await f.db.patch(task._id, { status: "scheduled" });
    expect(await wakeShepherd(f.ctx, f.pr()._id, "check_failed", undefined, 1)).toMatchObject({ woken: false });
    expect(task.run_at).toBeUndefined();
    expect(f.pr().shepherd_pending_reasons).toEqual([]);
    expect(f.pr().shepherd_wake_count).toBe(0);
  });

  test.each([true, false])("terminal webhook (merged=%s) saves a receipt and retires only its shepherd", async (merged) => {
    const f = await fixture();
    await f.toggle("on");
    const taskId = f.pr().shepherd_task_id;
    const watchId = await f.watch(merged ? "pr_merged" : "pr_closed");
    await f.db.patch(taskId, { status: "running", lease_holder: "daemon-test", lease_expires_at: Date.now() + 60_000 });
    await f.db.insert("tasks", { _id: "unrelated", status: "in_progress" });
    await f.close(merged);
    await f.drainWatches();
    const task = await f.db.get(taskId);
    expect(task.status).toBe("completed");
    expect(task.run_at).toBeUndefined();
    expect(task.lease_holder).toBeUndefined();
    expect(task.lease_expires_at).toBeUndefined();
    expect(task.run_count).toBe(0);
    expect(task.last_run_at).toBeUndefined();
    expect(task.last_run_summary).toContain(`https://github.com/${REPO}/pull/12 ${merged ? "merged" : "closed"}`);
    expect(task.last_run_summary).toContain("does not verify completion of an in-flight run or linked tasks");
    expect((await f.db.get(CONV)).armed_trigger_kind).toBe("none");
    expect(f.pr().shepherd_enabled).toBe(false);
    expect(f.pr().shepherd_wake_count).toBe(0);
    expect((await f.db.get(watchId)).run_at).toBeGreaterThan(0);
    expect((await f.db.get("unrelated")).status).toBe("in_progress");
    for (const daemon_id of ["daemon-test", undefined]) {
      expect(await call(completeTaskRun, f.ctx, { api_token: TOKEN, task_id: task._id, daemon_id, summary: "Late agent output" })).toBe(false);
    }
    expect(await call(renewLease, f.ctx, { api_token: TOKEN, task_id: task._id, daemon_id: "daemon-test" })).toBe(false);
    await wakeShepherd(f.ctx, f.pr()._id, "check_failed", undefined, 1);
    await f.toggle("on");
    expect(f.db._tables.agent_tasks).toHaveLength(2);
    expect(f.pr().shepherd_enabled).toBe(false);
  });

  test.each(["list", "status", "files"])("terminal %s sync retires without waiting for a webhook", async (route) => {
    const f = await fixture();
    await f.toggle("on");
    const prId = f.pr()._id;
    if (route === "list") await call(syncPRFromGitHub, f.ctx, {
      team_id: TEAM, github_pr_id: 555, repository: REPO, number: 12, title: "Fix test", body: "",
      state: "merged", author_github_username: "ashot", created_at: 1, updated_at: Date.now() + 1000,
    });
    if (route === "status") await call(updatePRState, f.ctx, { github_pr_id: 555, state: "closed" });
    if (route === "files") await call(updatePRFiles, f.ctx, {
      pr_id: prId, state: "merged", files: [], additions: 0, deletions: 0, changed_files: 0, commits_count: 1,
    });
    expect((await f.db.get(f.pr().shepherd_task_id)).status).toBe("completed");
    expect(f.pr().shepherd_enabled).toBe(false);
  });

  test("cancelling a shepherd trigger prevents implicit reactivation; explicit on can restart it", async () => {
    const f = await fixture();
    await f.toggle("on");
    await f.db.patch(f.pr().shepherd_task_id, { status: "cancelled" });
    await f.check("failure");
    await call(matchPRToConversation, f.ctx, discovery);
    await call(bindPRToConversation, f.ctx, { pr_id: f.pr()._id, conversation_id: CONV });
    expect(f.pr().shepherd_wake_count).toBe(0);
    expect(f.db._tables.agent_tasks).toHaveLength(1);
    await f.toggle("on");
    const taskId = f.pr().shepherd_task_id;
    await call(retire, f.ctx, { pr_id: f.pr()._id });
    expect((await f.db.get(taskId)).status).toBe("scheduled");
    await f.check("failure");
    expect(f.pr().shepherd_wake_count).toBe(1);
  });

  test.each(["once", "event", "recurring"])("inline %s completion saves the outcome before cancellation and cannot rearm afterwards", async (schedule_type) => {
    const f = await fixture();
    const { id } = await insertTask(f.ctx, USER as any, {
      title: "Bounded verification", prompt: "Verify the terminal condition", schedule_type: schedule_type as any,
      interval_ms: schedule_type === "recurring" ? 60_000 : undefined,
      event_filter: schedule_type === "event" ? { event_type: "pr_merged", repository: REPO } : undefined,
      originating_conversation_id: CONV,
    });
    await f.db.patch(id, { status: "running", lease_holder: "daemon-test", lease_expires_at: Date.now() + 60_000 });
    expect(await call(completeTaskRun, f.ctx, { api_token: TOKEN, task_id: id, daemon_id: "daemon-test", conversation_id: CONV })).toBe(true);
    expect(await call(completeTaskRun, f.ctx, { api_token: TOKEN, task_id: id, summary: "Terminal condition verified: receipt saved" })).toBe(true);
    expect(await call(cancelTask, f.ctx, { api_token: TOKEN, task_id: id })).toBe(true);
    expect(await call(completeTaskRun, f.ctx, { api_token: TOKEN, task_id: id, summary: "Late duplicate" })).toBe(false);
    await call(matchTaskTriggers, f.ctx, { event_type: "pr_merged", repository: REPO, team_id: TEAM });
    const task = await f.db.get(id);
    expect(task.status).toBe("completed");
    expect(task.last_run_summary).toBe("Terminal condition verified: receipt saved");
    expect(task.lease_holder).toBeUndefined();
    expect(task.lease_expires_at).toBeUndefined();
    expect((await f.db.get(CONV)).armed_trigger_kind).toBe("none");
  });

  test.each([
    ["review-bot[bot]", "User", "changes_requested", "Review update"],
    ["review-service", "Bot", "commented", "Review update"],
    ["review-bot[bot]", "User", "approved", "Please add a regression test"],
    ["samvit", "User", "approved", ""],
    ["samvit", "User", "approved", " \n\t"],
    ["ashot", "User", "commented", "Review update"],
    ["ashot", "User", "approved", "Please add a regression test"],
  ])("%s %s %s body=%j remains visible without an implicit wake", async (login, type, state, body) => {
    const f = await fixture();
    await f.toggle("on");
    const watchId = await f.watch("pr_review");
    await f.deliver(processReviewEvent, "pull_request_review", "submitted", {
      repository: { full_name: REPO }, pull_request: { id: 555, number: 12 },
      review: { id: 77, state, body, user: { login, type } },
    });
    await f.drainWatches();
    expect(f.db._tables.reviews).toHaveLength(1);
    expect((await f.db.get(watchId)).run_at).toBeGreaterThan(0);
    expect(f.pr().shepherd_wake_count).toBe(0);
  });

  test.each(["approved", "commented"])("a substantive human %s review wakes once while explicit watches remain independent", async (state) => {
    const f = await fixture();
    await f.toggle("on");
    const watchId = await f.watch("pr_review");
    const payload = {
      repository: { full_name: REPO }, pull_request: { id: 555, number: 12 },
      review: { id: 77, state, body: "Please add a regression test for the null response before landing.",
        user: { login: "samvit", type: "User" } },
    };
    await f.deliver(processReviewEvent, "pull_request_review", "submitted", payload);
    await f.drainWatches();
    expect(f.pr().shepherd_wake_count).toBe(1);
    expect(f.pr().shepherd_last_wake_reason).toBe("review_submitted");
    expect((await f.db.get(watchId)).run_at).toBeGreaterThan(0);
    await f.deliver(processReviewEvent, "pull_request_review", "submitted", payload);
    expect(f.db._tables.reviews).toHaveLength(1);
    expect(f.db._tables.reviews[0].body).toBe(payload.review.body);
    expect(f.pr().shepherd_wake_count).toBe(1);
    await f.deliver(processReviewEvent, "pull_request_review", "dismissed", {
      ...payload, review: { ...payload.review, state: "dismissed", body: "This review is no longer relevant" },
    });
    expect(f.pr().shepherd_wake_count).toBe(1);
  });

  test.each(["samvit", "review-bot[bot]", "ashot"])("review comment from %s wakes only for a human reviewer", async (login) => {
    const f = await fixture();
    await f.toggle("on");
    await f.deliver(processReviewCommentEvent, "pull_request_review_comment", "created", {
      repository: { full_name: REPO }, pull_request: { id: 555, number: 12 },
      comment: { id: 88, body: "Please handle this case", path: "src/app.ts", line: 4,
        created_at: "2026-09-14T10:00:00Z", updated_at: "2026-09-14T10:00:00Z", user: { login } },
    });
    expect(f.db._tables.review_comments).toHaveLength(1);
    expect(f.pr().shepherd_wake_count).toBe(login === "samvit" ? 1 : 0);
  });
});
