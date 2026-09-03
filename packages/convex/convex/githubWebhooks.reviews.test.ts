import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { processReviewEvent, processReviewCommentEvent, processPushEvent } from "./githubWebhooks";

const TEAM = "team_1" as any;
const CONV = "conv_1" as any;
const PR = "pr_1" as any;
const TASK = "agent_tasks_seed" as any;
const HEAD = "abcdef1234567890abcdef1234567890abcdef12";

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
    head_sha: HEAD,
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

function context(payload: any, action: string | undefined, eventType: string, seed: Record<string, any[]> = {}) {
  const scheduled: Array<{ delay: number; reference: any; args: any }> = [];
  const db = makeFakeDb({
    github_webhook_events: [
      {
        _id: "event_1",
        delivery_id: "d1",
        event_type: eventType,
        action,
        payload: JSON.stringify(payload),
        processed: false,
        created_at: 0,
      },
    ],
    pull_requests: [pullRequest()],
    conversations: [{ _id: CONV, user_id: "user_1", is_private: true, title: "Git backend", git_branch: "ct-48298-git-backend" }],
    agent_tasks: [
      {
        _id: TASK, user_id: "user_1", title: "Shepherd PR #12", prompt: "old", status: "scheduled",
        schedule_type: "event", originating_conversation_id: CONV, retry_count: 0, run_count: 0, created_at: 0, mode: "apply",
      },
    ],
    github_app_installations: [
      { _id: "inst_1", team_id: TEAM, installation_id: 7, account_login: "codecast-sh", repository_selection: "all" },
    ],
    git_events: [],
    reviews: [],
    review_comments: [],
    commits: [],
    file_changes: [],
    tasks: [],
    ...seed,
  });
  return {
    db,
    scheduler: {
      async runAfter(delay: number, reference: any, args: any) {
        scheduled.push({ delay, reference, args });
      },
    },
    _scheduled: scheduled,
  } as any;
}

const reviewPayload = (state: string, body?: string) => ({
  repository: { full_name: "codecast-sh/codecast" },
  pull_request: { number: 12, id: 555 },
  review: {
    id: 77,
    state,
    body,
    commit_id: HEAD,
    html_url: "https://github.com/r/77",
    submitted_at: "2026-09-03T10:00:00Z",
    user: { login: "samvit", avatar_url: "https://a/s" },
  },
});

describe("pull_request_review", () => {
  test("a request for changes writes the review, the decision, the event and the wake", async () => {
    const ctx = context(reviewPayload("changes_requested", "needs a test"), "submitted", "pull_request_review");
    await (processReviewEvent as any)._handler(ctx, { event_id: "event_1" });

    const review = ctx.db._tables.reviews[0];
    expect(review).toMatchObject({
      pull_request_id: PR,
      author_github_username: "samvit",
      github_review_id: 77,
      state: "changes_requested",
      body: "needs a test",
      commit_sha: HEAD,
    });

    const pr = ctx.db._tables.pull_requests[0];
    expect(pr.review_decision).toBe("changes_requested");
    expect(pr.shepherd_state).toBe("changes_requested");

    const event = ctx.db._tables.git_events[0];
    expect(event.kind).toBe("pr_review");
    expect(event.title).toBe("Review: requested changes by samvit on PR #12");
    expect(event.summary).toBe("needs a test");

    expect(ctx._scheduled.some((s: any) => s.args?.event_type === "pr_review")).toBe(true);
    expect(ctx._scheduled.some((s: any) => s.args?.event_type === "pr_changes_requested")).toBe(true);
    expect(ctx.db._tables.agent_tasks[0].prompt).toContain("samvit requested changes");
  });

  test("an approval fires its own trigger and folds to approved", async () => {
    const ctx = context(reviewPayload("approved"), "submitted", "pull_request_review");
    await (processReviewEvent as any)._handler(ctx, { event_id: "event_1" });
    expect(ctx.db._tables.pull_requests[0].review_decision).toBe("approved");
    expect(ctx.db._tables.pull_requests[0].shepherd_state).toBe("approved");
    expect(ctx._scheduled.some((s: any) => s.args?.event_type === "pr_approved")).toBe(true);
  });

  test("an empty comment review is recorded and wakes nobody", async () => {
    const ctx = context(reviewPayload("commented"), "submitted", "pull_request_review");
    await (processReviewEvent as any)._handler(ctx, { event_id: "event_1" });
    expect(ctx.db._tables.reviews[0].state).toBe("commented");
    expect(ctx.db._tables.agent_tasks[0].prompt).toBe("old");
  });

  test("a redelivered review updates the row it already wrote", async () => {
    const ctx = context(reviewPayload("approved"), "submitted", "pull_request_review", {
      reviews: [
        { _id: "r1", pull_request_id: PR, github_review_id: 77, author_github_username: "samvit", state: "changes_requested", submitted_at: 1 },
      ],
    });
    await (processReviewEvent as any)._handler(ctx, { event_id: "event_1" });
    expect(ctx.db._tables.reviews).toHaveLength(1);
    expect(ctx.db._tables.reviews[0].state).toBe("approved");
  });

  test("a dismissed review stops counting", async () => {
    const ctx = context(reviewPayload("dismissed"), "dismissed", "pull_request_review", {
      reviews: [
        { _id: "r1", pull_request_id: PR, github_review_id: 77, author_github_username: "samvit", state: "changes_requested", submitted_at: 1 },
      ],
    });
    await (processReviewEvent as any)._handler(ctx, { event_id: "event_1" });
    expect(ctx.db._tables.reviews[0].state).toBe("commented");
    expect(ctx.db._tables.pull_requests[0].review_decision).toBe("none");
    expect(ctx.db._tables.agent_tasks[0].prompt).toBe("old");
  });
});

const commentPayload = (over: Record<string, any> = {}) => ({
  repository: { full_name: "codecast-sh/codecast" },
  pull_request: { number: 12 },
  comment: {
    id: 4242,
    body: "this leaks",
    path: "src/foo.ts",
    line: 42,
    side: "RIGHT",
    commit_id: HEAD,
    html_url: "https://github.com/c/4242",
    pull_request_review_id: 77,
    created_at: "2026-09-03T10:00:00Z",
    updated_at: "2026-09-03T10:00:00Z",
    user: { login: "samvit", avatar_url: "https://a/s" },
    ...over,
  },
});

describe("pull_request_review_comment", () => {
  test("an inbound comment is stored as a code comment, recorded and woken on", async () => {
    const ctx = context(commentPayload(), "created", "pull_request_review_comment");
    await (processReviewCommentEvent as any)._handler(ctx, { event_id: "event_1" });

    const comment = ctx.db._tables.review_comments[0];
    expect(comment).toMatchObject({
      pull_request_id: PR,
      repository: "codecast-sh/codecast",
      ref: HEAD,
      github_comment_id: 4242,
      file_path: "src/foo.ts",
      line_number: 42,
      side: "RIGHT",
      author_kind: "github",
      author_github_username: "samvit",
      author_avatar_url: "https://a/s",
      conversation_id: CONV,
      codecast_origin: false,
    });

    const event = ctx.db._tables.git_events[0];
    expect(event.kind).toBe("pr_review_comment");
    expect(event.title).toBe("samvit commented on src/foo.ts:42 in PR #12");
    expect(event.comment_id).toBe(comment._id);

    expect(ctx.db._tables.agent_tasks[0].prompt).toContain("samvit on src/foo.ts:42");
  });

  test("a comment codecast posted comes back and is skipped", async () => {
    const ctx = context(commentPayload(), "created", "pull_request_review_comment", {
      review_comments: [
        { _id: "rc_ours", pull_request_id: PR, github_comment_id: 4242, content: "this leaks", resolved: false, created_at: 1, codecast_origin: true },
      ],
    });
    await (processReviewCommentEvent as any)._handler(ctx, { event_id: "event_1" });
    expect(ctx.db._tables.review_comments).toHaveLength(1);
    expect(ctx.db._tables.git_events).toHaveLength(0);
    expect(ctx.db._tables.agent_tasks[0].prompt).toBe("old");
  });

  test("the delivery is marked processed either way", async () => {
    const ctx = context(commentPayload(), "created", "pull_request_review_comment");
    await (processReviewCommentEvent as any)._handler(ctx, { event_id: "event_1" });
    expect(ctx.db._tables.github_webhook_events[0].processed).toBe(true);
  });
});

const pushPayload = (over: Record<string, any> = {}) => ({
  repository: { full_name: "codecast-sh/codecast" },
  ref: "refs/heads/ct-48301-linking",
  after: "1111111111111111111111111111111111111111",
  compare: "https://github.com/compare/a...b",
  pusher: { name: "ashot" },
  sender: { login: "ashot", avatar_url: "https://a/a" },
  commits: [
    {
      id: "1111111111111111111111111111111111111111",
      message: "fix: link commits to sessions (ct-48301)",
      timestamp: "2026-09-03T10:00:00Z",
      author: { name: "Ashot", email: "a@x", username: "ashot" },
      added: ["a.ts"],
      modified: ["b.ts"],
      removed: [],
    },
  ],
  ...over,
});

describe("push", () => {
  test("stores the commit with its team, branch, task links and session", async () => {
    const ctx = context(pushPayload(), undefined, "push", {
      tasks: [{ _id: "task_a", short_id: "ct-48301", plan_id: "plan_x", project_id: "proj_x", title: "Linking" }],
      file_changes: [{ _id: "fc_1", conversation_id: CONV, commit_hash: "1111111", change_type: "commit", file_path: "a.ts", new_content: "", timestamp: 1, change_key: "k", message_id: "m", seq: 1 }],
    });
    const result = await (processPushEvent as any)._handler(ctx, { event_id: "event_1" });
    expect(result.commits_created).toBe(1);

    const commit = ctx.db._tables.commits[0];
    expect(commit).toMatchObject({
      sha: "1111111111111111111111111111111111111111",
      team_id: TEAM,
      branch: "ct-48301-linking",
      author_login: "ashot",
      conversation_id: CONV,
      repository: "codecast-sh/codecast",
    });
    expect(commit.task_ids).toEqual(["task_a"]);

    const kinds = ctx.db._tables.git_events.map((e: any) => e.kind);
    expect(kinds).toContain("commit");
    expect(kinds).toContain("push");

    const push = ctx.db._tables.git_events.find((e: any) => e.kind === "push");
    expect(push.title).toBe("Pushed 1 commit to ct-48301-linking");
    expect(push.meta.commit_count).toBe(1);
    // The branch names ct-48301 too, so the push carries the same links.
    expect(push.task_ids).toEqual(["task_a"]);
    expect(push.plan_ids).toEqual(["plan_x"]);

    const commitEvent = ctx.db._tables.git_events.find((e: any) => e.kind === "commit");
    expect(commitEvent.title).toBe("fix: link commits to sessions (ct-48301)");
    expect(commitEvent.plan_ids).toEqual(["plan_x"]);
    expect(commitEvent.project_ids).toEqual(["proj_x"]);
    expect(commitEvent.conversation_id).toBe(CONV);
  });

  test("with no edit row naming the sha, one session on the branch is enough", async () => {
    const ctx = context(pushPayload({ ref: "refs/heads/ct-48298-git-backend" }), undefined, "push");
    await (processPushEvent as any)._handler(ctx, { event_id: "event_1" });
    expect(ctx.db._tables.commits[0].conversation_id).toBe(CONV);
  });

  test("two sessions on one branch is not evidence", async () => {
    const ctx = context(pushPayload({ ref: "refs/heads/ct-48298-git-backend" }), undefined, "push", {
      conversations: [
        { _id: CONV, user_id: "user_1", is_private: true, git_branch: "ct-48298-git-backend" },
        { _id: "conv_2", user_id: "user_2", is_private: true, git_branch: "ct-48298-git-backend" },
      ],
    });
    await (processPushEvent as any)._handler(ctx, { event_id: "event_1" });
    expect(ctx.db._tables.commits[0].conversation_id).toBeUndefined();
  });

  test("a push to a base branch asks every PR aimed at it to recheck", async () => {
    const ctx = context(pushPayload({ ref: "refs/heads/main" }), undefined, "push", {
      conversations: [],
    });
    await (processPushEvent as any)._handler(ctx, { event_id: "event_1" });
    const refresh = ctx._scheduled.filter((s: any) => s.args?.pr_id === PR && s.args?.attempt === 0);
    expect(refresh).toHaveLength(1);
    expect(refresh[0].delay).toBe(15000);
  });

  test("a tag push is not a branch push", async () => {
    const ctx = context(pushPayload({ ref: "refs/tags/v1" }), undefined, "push");
    const result = await (processPushEvent as any)._handler(ctx, { event_id: "event_1" });
    expect(result.reason).toBe("Not a branch push");
    expect(ctx.db._tables.commits).toHaveLength(0);
  });

  test("a redelivered push adds no second commit and no second event", async () => {
    const ctx = context(pushPayload(), undefined, "push");
    await (processPushEvent as any)._handler(ctx, { event_id: "event_1" });
    ctx.db._tables.github_webhook_events[0].processed = false;
    const again = await (processPushEvent as any)._handler(ctx, { event_id: "event_1" });
    expect(again.commits_created).toBe(0);
    expect(ctx.db._tables.commits).toHaveLength(1);
    expect(ctx.db._tables.git_events.filter((e: any) => e.kind === "commit")).toHaveLength(1);
  });
});
