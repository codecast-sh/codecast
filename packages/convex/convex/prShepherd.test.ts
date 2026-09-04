import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import {
  buildWakePrompt,
  pickWakeReason,
  patchPullRequest,
  recomputeReviewDecision,
  refreshConversationPrStatus,
  wakeShepherd,
} from "./prShepherd";

const TEAM = "team_1" as any;
const CONV = "conv_1" as any;
const PR = "pr_1" as any;
const TASK = "agent_tasks_seed" as any;

function pullRequest(extra: Record<string, any> = {}) {
  return {
    _id: PR,
    team_id: TEAM,
    repository: "codecast-sh/codecast",
    number: 12,
    title: "Make pushes first class",
    state: "open",
    head_ref: "ct-48298-git-backend",
    base_ref: "main",
    head_sha: "abcdef1234567890abcdef1234567890abcdef12",
    author_github_username: "ashot",
    linked_session_ids: [],
    created_at: 1,
    updated_at: 2,
    shepherd_conversation_id: CONV,
    shepherd_enabled: true,
    shepherd_task_id: TASK,
    ...extra,
  };
}

function context(seed: Record<string, any[]> = {}) {
  const scheduled: Array<{ delay: number; reference: unknown; args: any }> = [];
  const db = makeFakeDb({
    conversations: [{ _id: CONV, user_id: "user_1", is_private: true, title: "Git backend" }],
    pull_requests: [pullRequest()],
    agent_tasks: [
      {
        _id: TASK,
        user_id: "user_1",
        title: "Shepherd PR #12",
        prompt: "old prompt",
        status: "scheduled",
        schedule_type: "event",
        originating_conversation_id: CONV,
        retry_count: 0,
        run_count: 0,
        created_at: 0,
        mode: "apply",
      },
    ],
    reviews: [],
    review_comments: [],
    tasks: [],
    external_events: [],
    ...seed,
  });
  return {
    db,
    scheduler: {
      async runAfter(delay: number, reference: unknown, args: any) {
        scheduled.push({ delay, reference, args });
      },
    },
    _scheduled: scheduled,
  } as any;
}

describe("buildWakePrompt", () => {
  test("names the pull request, where it stands and why the agent woke", () => {
    const prompt = buildWakePrompt({
      pr: pullRequest({ shepherd_state: "ci_red" }) as any,
      reason: "check_failed",
      detail: "test (ubuntu) failure",
    });
    expect(prompt).toContain("codecast-sh/codecast PR #12");
    expect(prompt).toContain("Make pushes first class");
    expect(prompt).toContain("https://github.com/codecast-sh/codecast/pull/12");
    expect(prompt).toContain("ct-48298-git-backend into main at abcdef1");
    expect(prompt).toContain("State: ci_red");
    expect(prompt).toContain("a check failed: test (ubuntu) failure");
  });

  test("lists the failing checks and leaves the passing ones out", () => {
    const prompt = buildWakePrompt({
      pr: pullRequest({
        checks: [
          { name: "test (ubuntu)", status: "completed", conclusion: "failure", url: "https://ci/1" },
          { name: "lint", status: "completed", conclusion: "success" },
          { name: "typecheck", status: "completed", conclusion: "skipped" },
        ],
      }) as any,
      reason: "check_failed",
    });
    expect(prompt).toContain("## Failing checks");
    expect(prompt).toContain("- test (ubuntu): failure — https://ci/1");
    expect(prompt).not.toContain("lint");
    expect(prompt).not.toContain("typecheck");
  });

  test("carries unresolved comments with their file, line and link", () => {
    const prompt = buildWakePrompt({
      pr: pullRequest() as any,
      comments: [
        { author: "samvit", file_path: "src/foo.ts", line_number: 42, content: "this leaks", url: "https://gh/c/1" },
      ],
      reason: "review_comment_created",
    });
    expect(prompt).toContain("## Unresolved review comments");
    expect(prompt).toContain("- samvit on src/foo.ts:42: this leaks — https://gh/c/1");
  });

  test("says the review verdict and who still owes one", () => {
    const prompt = buildWakePrompt({
      pr: pullRequest({ review_decision: "changes_requested", requested_reviewers: ["samvit", "ada"] }) as any,
      reviews: [{ author: "samvit", state: "changes_requested", body: "needs a test" }],
      reason: "review_submitted",
      detail: "samvit requested changes",
    });
    expect(prompt).toContain("- samvit changes_requested: needs a test");
    expect(prompt).toContain("Review decision: changes_requested.");
    expect(prompt).toContain("Requested reviewers: samvit, ada.");
  });

  test("explains a stale or conflicting branch only when it is one", () => {
    const behind = buildWakePrompt({ pr: pullRequest({ behind_by: 5 }) as any, reason: "behind" });
    expect(behind).toContain("5 commits behind main.");

    const clean = buildWakePrompt({ pr: pullRequest({ behind_by: 0 }) as any, reason: "synchronize" });
    expect(clean).not.toContain("## Merge state");
  });

  test("a merge turns the job into closing the work out", () => {
    const prompt = buildWakePrompt({ pr: pullRequest({ state: "merged" }) as any, reason: "merged" });
    expect(prompt).toContain("State: merged");
    expect(prompt).toContain("mark the linked tasks done");
    expect(prompt).toContain("cast state --status done");
    expect(prompt).not.toContain("Do not merge the pull request");
  });

  test("the standing job says what to do and what not to do", () => {
    const prompt = buildWakePrompt({ pr: pullRequest() as any, reason: "bound" });
    expect(prompt).toContain("You own this pull request until it merges.");
    expect(prompt).toContain("Do not merge the pull request unless a human asked");
    expect(prompt).toContain("push to the same");
    expect(prompt).toContain("cast state");
    expect(prompt.split("\n").length).toBeLessThan(60);
  });

  test("links the codecast work the pull request names", () => {
    const prompt = buildWakePrompt({
      pr: pullRequest() as any,
      tasks: [{ short_id: "ct-48298", title: "Schema and backend" }],
      reason: "bound",
    });
    expect(prompt).toContain("- ct-48298 Schema and backend");
  });
});

describe("wakeShepherd", () => {
  test("rebuilds the prompt and runs the trigger now", async () => {
    const ctx = context();
    const result = await wakeShepherd(ctx, PR, "check_failed", "test (ubuntu) failure");
    expect(result.woken).toBe(true);

    const task = ctx.db._tables.agent_tasks[0];
    expect(task.status).toBe("scheduled");
    expect(task.run_at).toBeGreaterThan(0);
    expect(task.prompt).toContain("a check failed: test (ubuntu) failure");

    const pr = ctx.db._tables.pull_requests[0];
    expect(pr.shepherd_last_wake_reason).toBe("check_failed");
    expect(pr.shepherd_wake_count).toBe(1);
  });

  test("waits rather than cutting a running agent short", async () => {
    const ctx = context({
      agent_tasks: [
        {
          _id: TASK,
          user_id: "user_1",
          title: "Shepherd PR #12",
          prompt: "old prompt",
          status: "running",
          schedule_type: "event",
          originating_conversation_id: CONV,
          retry_count: 0,
          run_count: 0,
          created_at: 0,
          mode: "apply",
        },
      ],
    });
    const result = await wakeShepherd(ctx, PR, "check_failed");
    expect(result.woken).toBe(false);
    expect(result.reason).toBe("retry_scheduled");
    expect(ctx._scheduled[0].args).toMatchObject({ pr_id: PR, reason: "check_failed", attempt: 1 });
    expect(ctx.db._tables.agent_tasks[0].prompt).toBe("old prompt");
  });

  test("gives up retrying instead of looping forever", async () => {
    const ctx = context({
      agent_tasks: [
        { _id: TASK, user_id: "user_1", title: "t", prompt: "p", status: "running", schedule_type: "event", retry_count: 0, run_count: 0, created_at: 0, mode: "apply" },
      ],
    });
    const result = await wakeShepherd(ctx, PR, "check_failed", undefined, 5);
    expect(result.reason).toBe("still_running");
    expect(ctx._scheduled).toHaveLength(0);
  });

  test("a shepherd that was turned off stays quiet", async () => {
    const ctx = context({ pull_requests: [pullRequest({ shepherd_enabled: false })] });
    const result = await wakeShepherd(ctx, PR, "check_failed");
    expect(result).toEqual({ woken: false, reason: "disabled" });
  });

  test("only unresolved comments a human wrote reach the prompt", async () => {
    const ctx = context({
      review_comments: [
        { _id: "rc_1", pull_request_id: PR, content: "still broken", resolved: false, created_at: 1, author_github_username: "samvit", file_path: "a.ts", line_number: 3 },
        { _id: "rc_2", pull_request_id: PR, content: "fixed already", resolved: true, created_at: 2, author_github_username: "ada" },
        { _id: "rc_3", pull_request_id: PR, content: "our own note", resolved: false, created_at: 3, codecast_origin: true },
      ],
    });
    await wakeShepherd(ctx, PR, "review_comment_created");
    const prompt = ctx.db._tables.agent_tasks[0].prompt;
    expect(prompt).toContain("still broken");
    expect(prompt).not.toContain("fixed already");
    expect(prompt).not.toContain("our own note");
  });
});

describe("recomputeReviewDecision", () => {
  test("one outstanding request for changes outranks every approval", async () => {
    const ctx = context({
      reviews: [
        { _id: "r1", pull_request_id: PR, author_github_username: "ada", state: "approved", submitted_at: 1 },
        { _id: "r2", pull_request_id: PR, author_github_username: "samvit", state: "changes_requested", submitted_at: 2 },
      ],
    });
    expect(await recomputeReviewDecision(ctx, ctx.db._tables.pull_requests[0])).toBe("changes_requested");
  });

  test("a reviewer's latest word is the one that counts", async () => {
    const ctx = context({
      reviews: [
        { _id: "r1", pull_request_id: PR, author_github_username: "samvit", state: "changes_requested", submitted_at: 1 },
        { _id: "r2", pull_request_id: PR, author_github_username: "samvit", state: "approved", submitted_at: 5 },
      ],
    });
    expect(await recomputeReviewDecision(ctx, ctx.db._tables.pull_requests[0])).toBe("approved");
  });

  test("comments say nothing about whether it may land", async () => {
    const ctx = context({
      reviews: [{ _id: "r1", pull_request_id: PR, author_github_username: "ada", state: "commented", submitted_at: 1 }],
    });
    expect(await recomputeReviewDecision(ctx, ctx.db._tables.pull_requests[0])).toBe("none");
  });

  test("an outstanding request names the state honestly", async () => {
    const ctx = context({ pull_requests: [pullRequest({ requested_reviewers: ["ada"] })] });
    expect(await recomputeReviewDecision(ctx, ctx.db._tables.pull_requests[0])).toBe("review_required");
  });
});

describe("refreshConversationPrStatus", () => {
  test("mirrors the open pull request onto the session card", async () => {
    const ctx = context();
    await patchPullRequest(ctx, PR, { checks_state: "pending" });
    const conv = ctx.db._tables.conversations[0];
    expect(conv.pr_status).toMatchObject({ pr_id: PR, number: 12, state: "ci_pending", repository: "codecast-sh/codecast" });
  });

  test("an open pull request wins over a merged one", async () => {
    const ctx = context({
      pull_requests: [
        pullRequest({ _id: "pr_merged", number: 5, state: "merged", updated_at: 99 }),
        pullRequest({ number: 12, state: "open", updated_at: 1 }),
      ],
    });
    await refreshConversationPrStatus(ctx, CONV);
    expect(ctx.db._tables.conversations[0].pr_status.number).toBe(12);
  });

  test("a session shepherding nothing carries no stale pull request", async () => {
    const ctx = context({ pull_requests: [] });
    ctx.db._tables.conversations[0].pr_status = { pr_id: PR, repository: "r", number: 1, state: "open", at: 1 };
    await refreshConversationPrStatus(ctx, CONV);
    expect(ctx.db._tables.conversations[0].pr_status).toBeUndefined();
  });
});

// ── Round three: threads, reason severity, ordering, text ──
//
// All four came out of the live shepherd run on codecast-sh/shepherd-lab PR #1,
// which took thirteen wakes to merge and misdescribed itself in most of them.

function reviewComment(over: Record<string, any> = {}) {
  return {
    _id: `rc_${over.github_comment_id ?? "x"}`,
    pull_request_id: PR,
    repository: "codecast-sh/codecast",
    content: "please rename this",
    resolved: false,
    created_at: 100,
    author_github_username: "reviewer",
    file_path: "convex/prShepherd.ts",
    line_number: 42,
    ...over,
  };
}

describe("a review thread is a conversation, not a note", () => {
  test("a reviewer comment the author already answered is not outstanding", async () => {
    const ctx = context({
      review_comments: [
        reviewComment({ github_comment_id: 1, created_at: 100 }),
        // The session replies through gh AS the PR author, which sets no flag.
        reviewComment({
          _id: "rc_2",
          github_comment_id: 2,
          github_in_reply_to_id: 1,
          created_at: 200,
          author_github_username: "ashot",
          content: "done, renamed",
        }),
      ],
    });
    await wakeShepherd(ctx, PR, "review_comment_created");
    expect(ctx.db._tables.agent_tasks[0].prompt).not.toContain("Unresolved review comments");
  });

  test("a reviewer comment nobody answered is still outstanding", async () => {
    const ctx = context({ review_comments: [reviewComment({ github_comment_id: 1 })] });
    await wakeShepherd(ctx, PR, "review_comment_created");

    const prompt = ctx.db._tables.agent_tasks[0].prompt;
    expect(prompt).toContain("Unresolved review comments");
    expect(prompt).toContain("please rename this");
  });

  test("a reviewer who comes back after the author's reply is outstanding again", async () => {
    const ctx = context({
      review_comments: [
        reviewComment({ github_comment_id: 1, created_at: 100 }),
        reviewComment({ _id: "rc_2", github_comment_id: 2, github_in_reply_to_id: 1, created_at: 200, author_github_username: "ashot", content: "done" }),
        reviewComment({ _id: "rc_3", github_comment_id: 3, github_in_reply_to_id: 1, created_at: 300, content: "still not right" }),
      ],
    });
    await wakeShepherd(ctx, PR, "review_comment_created");

    const prompt = ctx.db._tables.agent_tasks[0].prompt;
    expect(prompt).toContain("Unresolved review comments");
    // The ask is what opened the thread, not the follow-up.
    expect(prompt).toContain("please rename this");
  });

  test("a resolved thread stays quiet even with the reviewer last", async () => {
    const ctx = context({
      review_comments: [
        reviewComment({ github_comment_id: 1, resolved: true, resolved_at: 500 }),
        reviewComment({ _id: "rc_2", github_comment_id: 2, github_in_reply_to_id: 1, created_at: 300 }),
      ],
    });
    await wakeShepherd(ctx, PR, "review_comment_created");
    expect(ctx.db._tables.agent_tasks[0].prompt).not.toContain("Unresolved review comments");
  });
});

describe("pickWakeReason", () => {
  test("the most urgent reason leads, not the newest", () => {
    expect(pickWakeReason(["conflict", "checks_green"]).headline).toBe("conflict");
    expect(pickWakeReason(["checks_green", "check_failed"]).headline).toBe("check_failed");
    expect(pickWakeReason(["review_submitted", "changes_requested"]).headline).toBe("changes_requested");
  });

  test("a finished pull request outranks everything and the later one wins", () => {
    expect(pickWakeReason(["conflict", "merged"]).headline).toBe("merged");
    expect(pickWakeReason(["merged", "closed"]).headline).toBe("closed");
  });

  test("the rest are reported in the order they happened", () => {
    const { headline, others } = pickWakeReason(["checks_green", "conflict", "review_requested"]);
    expect(headline).toBe("conflict");
    expect(others).toEqual(["checks_green", "review_requested"]);
  });

  test("an unranked reason never outranks a ranked one", () => {
    expect(pickWakeReason(["synchronize", "conflict"]).headline).toBe("conflict");
    expect(pickWakeReason(["synchronize"]).headline).toBe("synchronize");
  });
});

describe("wakes that pile up while the shepherd is busy", () => {
  test("the reasons are kept and the most urgent leads when it is free", async () => {
    const ctx = context({
      agent_tasks: [
        {
          _id: TASK, user_id: "user_1", title: "Shepherd PR #12", prompt: "old prompt",
          status: "running", schedule_type: "event", originating_conversation_id: CONV,
          retry_count: 0, run_count: 0, created_at: 0, mode: "apply",
        },
      ],
    });

    // Busy: nothing is delivered, but the reasons are remembered.
    await wakeShepherd(ctx, PR, "checks_green");
    await wakeShepherd(ctx, PR, "conflict");
    expect(ctx.db._tables.agent_tasks[0].prompt).toBe("old prompt");
    expect(ctx.db._tables.pull_requests[0].shepherd_pending_reasons).toEqual(["checks_green", "conflict"]);

    // Free again. The last event was review_requested, but conflict is the one
    // that matters, and the others are named underneath.
    ctx.db._tables.agent_tasks[0].status = "scheduled";
    await wakeShepherd(ctx, PR, "review_requested");

    const prompt = ctx.db._tables.agent_tasks[0].prompt;
    expect(prompt).toContain("Woken because the branch no longer merges cleanly");
    expect(prompt).toContain("Also since the last wake:");
    expect(prompt).toContain("the checks went green");
    expect(ctx.db._tables.pull_requests[0].shepherd_last_wake_reason).toBe("conflict");
    // Handed over, so the next wake starts clean.
    expect(ctx.db._tables.pull_requests[0].shepherd_pending_reasons).toEqual([]);
  });

  test("a single reason says nothing about others", async () => {
    const ctx = context();
    await wakeShepherd(ctx, PR, "check_failed", "test (ubuntu) failure");
    const prompt = ctx.db._tables.agent_tasks[0].prompt;
    expect(prompt).toContain("Woken because a check failed: test (ubuntu) failure");
    expect(prompt).not.toContain("Also since the last wake");
  });
});

describe("the prompt describes the row as it is when it is built", () => {
  test("a head commit written before the wake is the one reported", async () => {
    const ctx = context();
    await patchPullRequest(ctx, PR, { head_sha: "9999999999999999999999999999999999999999" });
    await wakeShepherd(ctx, PR, "synchronize");

    const prompt = ctx.db._tables.agent_tasks[0].prompt;
    expect(prompt).toContain("9999999");
    expect(prompt).not.toContain("abcdef1");
  });
});
