import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { processCheckRunEvent, processStatusEvent, processCheckSuiteEvent, processReviewThreadEvent } from "./githubWebhooks";

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

function context(eventPayload: any, action: string, eventType: string, seed: Record<string, any[]> = {}) {
  const scheduled: Array<{ delay: number; reference: any; args: any }> = [];
  const db = makeFakeDb({
    github_webhook_events: [
      {
        _id: "event_1",
        delivery_id: "d1",
        event_type: eventType,
        action,
        payload: JSON.stringify(eventPayload),
        processed: false,
        created_at: 0,
      },
    ],
    pull_requests: [pullRequest()],
    conversations: [{ _id: CONV, user_id: "user_1", is_private: true, title: "Git backend" }],
    agent_tasks: [
      {
        _id: TASK,
        user_id: "user_1",
        title: "Shepherd PR #12",
        prompt: "old",
        status: "scheduled",
        schedule_type: "event",
        originating_conversation_id: CONV,
        retry_count: 0,
        run_count: 0,
        created_at: 0,
        mode: "apply",
      },
    ],
    external_events: [],
    reviews: [],
    review_comments: [],
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

const checkRunPayload = (over: Record<string, any> = {}) => ({
  repository: { full_name: "codecast-sh/codecast" },
  sender: { login: "github-actions", avatar_url: "https://a/1" },
  check_run: {
    id: 991,
    name: "test (ubuntu)",
    status: "completed",
    conclusion: "failure",
    html_url: "https://github.com/ci/991",
    head_sha: HEAD,
    pull_requests: [{ number: 12 }],
    ...over,
  },
});

describe("check_run", () => {
  test("a failure lands on the PR row, is recorded, and wakes the shepherd", async () => {
    const ctx = context(checkRunPayload(), "completed", "check_run");
    const result = await (processCheckRunEvent as any)._handler(ctx, { event_id: "event_1" });
    expect(result.prs).toBe(1);

    const pr = ctx.db._tables.pull_requests[0];
    expect(pr.checks).toHaveLength(1);
    expect(pr.checks[0]).toMatchObject({ name: "test (ubuntu)", conclusion: "failure", external_id: "991" });
    expect(pr.checks_state).toBe("failure");
    expect(pr.shepherd_state).toBe("ci_red");

    const event = ctx.db._tables.external_events[0];
    expect(event.source).toBe("github");
    expect(event.kind).toBe("pr_check");
    expect(event.title).toBe("CI failed: test (ubuntu)");
    expect(event.conversation_id).toBe(CONV);
    expect(event.pr_id).toBe(PR);

    const task = ctx.db._tables.agent_tasks[0];
    expect(task.prompt).toContain("a check failed: test (ubuntu) failure");
    expect(task.run_at).toBeGreaterThan(0);

    const trigger = ctx._scheduled.find((s: any) => s.args?.event_type === "pr_check_failed");
    expect(trigger.args).toMatchObject({ repository: "codecast-sh/codecast", pr_number: 12 });

    expect(ctx.db._tables.github_webhook_events[0].processed).toBe(true);
  });

  test("green only speaks up on the way back from red", async () => {
    const ctx = context(
      checkRunPayload({ conclusion: "success" }),
      "completed",
      "check_run",
      {
        pull_requests: [
          pullRequest({
            checks_state: "failure",
            checks: [
              { name: "test (ubuntu)", status: "completed", conclusion: "failure", updated_at: 1, external_id: "991" },
            ],
          }),
        ],
      },
    );
    await (processCheckRunEvent as any)._handler(ctx, { event_id: "event_1" });

    expect(ctx.db._tables.pull_requests[0].checks_state).toBe("success");
    expect(ctx.db._tables.external_events[0].title).toBe("CI passed on PR #12");
    expect(ctx._scheduled.some((s: any) => s.args?.event_type === "pr_checks_green")).toBe(true);
    expect(ctx.db._tables.agent_tasks[0].prompt).toContain("the checks went green");
  });

  test("an already green PR going green again wakes nobody", async () => {
    const ctx = context(
      checkRunPayload({ conclusion: "success", id: 992, name: "lint" }),
      "completed",
      "check_run",
      {
        pull_requests: [
          pullRequest({
            checks_state: "success",
            checks: [{ name: "test (ubuntu)", status: "completed", conclusion: "success", updated_at: 1, external_id: "991" }],
          }),
        ],
      },
    );
    await (processCheckRunEvent as any)._handler(ctx, { event_id: "event_1" });
    expect(ctx.db._tables.external_events).toHaveLength(0);
    expect(ctx.db._tables.agent_tasks[0].prompt).toBe("old");
  });

  test("with no pull request named, the head sha finds it", async () => {
    const ctx = context(checkRunPayload({ pull_requests: [] }), "completed", "check_run");
    const result = await (processCheckRunEvent as any)._handler(ctx, { event_id: "event_1" });
    expect(result.prs).toBe(1);
    expect(ctx.db._tables.pull_requests[0].checks_state).toBe("failure");
  });

  test("a sha belonging to no open pull request is left alone", async () => {
    const ctx = context(
      checkRunPayload({ pull_requests: [], head_sha: "0000000000000000000000000000000000000000" }),
      "completed",
      "check_run",
    );
    const result = await (processCheckRunEvent as any)._handler(ctx, { event_id: "event_1" });
    expect(result.prs).toBe(0);
    expect(ctx.db._tables.external_events).toHaveLength(0);
    expect(ctx.db._tables.github_webhook_events[0].processed).toBe(true);
  });

  test("a run still going is pending, not a failure", async () => {
    const ctx = context(
      checkRunPayload({ status: "in_progress", conclusion: null }),
      "created",
      "check_run",
    );
    await (processCheckRunEvent as any)._handler(ctx, { event_id: "event_1" });
    expect(ctx.db._tables.pull_requests[0].checks_state).toBe("pending");
    expect(ctx.db._tables.pull_requests[0].shepherd_state).toBe("ci_pending");
    expect(ctx.db._tables.external_events).toHaveLength(0);
  });
});

describe("status", () => {
  test("a failed commit status is a failed check on the pull request at that sha", async () => {
    const ctx = context(
      {
        repository: { full_name: "codecast-sh/codecast" },
        sender: { login: "buildkite" },
        sha: HEAD,
        state: "failure",
        context: "buildkite/build",
        target_url: "https://buildkite/1",
      },
      undefined as any,
      "status",
    );
    await (processStatusEvent as any)._handler(ctx, { event_id: "event_1" });

    const pr = ctx.db._tables.pull_requests[0];
    expect(pr.checks[0]).toMatchObject({ name: "buildkite/build", conclusion: "failure", external_id: "status:buildkite/build" });
    expect(pr.checks_state).toBe("failure");
    expect(ctx.db._tables.external_events[0].title).toBe("CI failed: buildkite/build");
  });

  test("a pending status waits rather than passing or failing", async () => {
    const ctx = context(
      {
        repository: { full_name: "codecast-sh/codecast" },
        sha: HEAD,
        state: "pending",
        context: "buildkite/build",
      },
      undefined as any,
      "status",
    );
    await (processStatusEvent as any)._handler(ctx, { event_id: "event_1" });
    expect(ctx.db._tables.pull_requests[0].checks_state).toBe("pending");
  });
});

describe("check_suite", () => {
  test("stands aside when individual check runs already said it", async () => {
    const ctx = context(
      {
        repository: { full_name: "codecast-sh/codecast" },
        check_suite: { id: 5, status: "completed", conclusion: "failure", head_sha: HEAD, pull_requests: [{ number: 12 }] },
      },
      "completed",
      "check_suite",
      {
        pull_requests: [
          pullRequest({ checks: [{ name: "test", status: "completed", conclusion: "success", updated_at: 1 }] }),
        ],
      },
    );
    const result = await (processCheckSuiteEvent as any)._handler(ctx, { event_id: "event_1" });
    expect(result.prs).toBe(0);
  });

  test("speaks for the whole suite when no individual run reached us", async () => {
    const ctx = context(
      {
        repository: { full_name: "codecast-sh/codecast" },
        check_suite: { id: 5, status: "completed", conclusion: "failure", head_sha: HEAD, pull_requests: [{ number: 12 }], app: { name: "GitHub Actions" } },
      },
      "completed",
      "check_suite",
    );
    const result = await (processCheckSuiteEvent as any)._handler(ctx, { event_id: "event_1" });
    expect(result.prs).toBe(1);
    expect(ctx.db._tables.pull_requests[0].checks_state).toBe("failure");
    expect(ctx.db._tables.external_events[0].title).toBe("CI failed: GitHub Actions checks");
  });
});

// ── Re-runs and check suites ──
//
// Two ordering defects a reviewer confirmed. Both left a PR stuck red forever,
// which also makes the checks_green wake unreachable, so the shepherd is never
// told the thing it was waiting for.

const checkSuitePayload = (over: Record<string, any> = {}) => ({
  repository: { full_name: "codecast-sh/codecast" },
  sender: { login: "github-actions", avatar_url: "https://a/1" },
  check_suite: {
    id: 555,
    status: "completed",
    conclusion: "success",
    head_sha: HEAD,
    pull_requests: [{ number: 12 }],
    app: { name: "GitHub Actions" },
    ...over,
  },
});

describe("a check that re-runs", () => {
  test("replaces its earlier failure instead of standing beside it", async () => {
    // GitHub issues a NEW check_run id for a re-run. Keying on that id filed the
    // re-run as a second check and left the failure standing, so checks_state
    // read failure forever.
    const ctx = context(
      checkRunPayload({ id: 1002, conclusion: "success" }),
      "completed",
      "check_run",
      {
        pull_requests: [
          pullRequest({
            checks_state: "failure",
            shepherd_state: "ci_red",
            checks: [
              { name: "test (ubuntu)", status: "completed", conclusion: "failure", updated_at: 1, external_id: "991" },
            ],
          }),
        ],
      },
    );
    await (processCheckRunEvent as any)._handler(ctx, { event_id: "event_1" });

    const pr = ctx.db._tables.pull_requests[0];
    expect(pr.checks).toHaveLength(1);
    expect(pr.checks[0]).toMatchObject({ name: "test (ubuntu)", conclusion: "success", external_id: "1002" });
    expect(pr.checks_state).toBe("success");
    expect(ctx._scheduled.some((s: any) => s.args?.event_type === "pr_checks_green")).toBe(true);
    expect(ctx.db._tables.agent_tasks[0].prompt).toContain("the checks went green");
  });

  test("a matrix leg with a different name is still its own check", async () => {
    const ctx = context(
      checkRunPayload({ id: 1003, name: "test (macos)", conclusion: "success" }),
      "completed",
      "check_run",
      {
        pull_requests: [
          pullRequest({
            checks_state: "failure",
            checks: [
              { name: "test (ubuntu)", status: "completed", conclusion: "failure", updated_at: 1, external_id: "991" },
            ],
          }),
        ],
      },
    );
    await (processCheckRunEvent as any)._handler(ctx, { event_id: "event_1" });

    const pr = ctx.db._tables.pull_requests[0];
    expect(pr.checks).toHaveLength(2);
    expect(pr.checks_state).toBe("failure");
  });
});

describe("check_suite beside real check runs", () => {
  test("stands aside when per-run detail already arrived", async () => {
    const ctx = context(checkSuitePayload(), "completed", "check_suite", {
      pull_requests: [
        pullRequest({
          checks_state: "failure",
          checks: [
            { name: "test (ubuntu)", status: "completed", conclusion: "failure", updated_at: 1, external_id: "991" },
          ],
        }),
      ],
    });
    await (processCheckSuiteEvent as any)._handler(ctx, { event_id: "event_1" });

    const pr = ctx.db._tables.pull_requests[0];
    expect(pr.checks).toHaveLength(1);
    expect(pr.checks[0].external_id).toBe("991");
  });

  test("its stand-in is evicted when real detail arrives afterwards", async () => {
    // The order webhooks actually arrive in is not guaranteed. When the suite
    // lands FIRST its stand-in used to survive beside every later real entry,
    // and a suite that concluded failure then pinned the PR red for good.
    const ctx = context(checkSuitePayload({ conclusion: "failure" }), "completed", "check_suite", {
      github_webhook_events: [
        {
          _id: "event_1",
          delivery_id: "d1",
          event_type: "check_suite",
          action: "completed",
          payload: JSON.stringify(checkSuitePayload({ conclusion: "failure" })),
          processed: false,
          created_at: 0,
        },
        {
          _id: "event_2",
          delivery_id: "d2",
          event_type: "check_run",
          action: "completed",
          payload: JSON.stringify(checkRunPayload({ id: 1002, conclusion: "success" })),
          processed: false,
          created_at: 1,
        },
      ],
    });

    await (processCheckSuiteEvent as any)._handler(ctx, { event_id: "event_1" });
    let pr = ctx.db._tables.pull_requests[0];
    expect(pr.checks).toHaveLength(1);
    expect(pr.checks[0].external_id).toBe("suite:555");
    expect(pr.checks_state).toBe("failure");

    await (processCheckRunEvent as any)._handler(ctx, { event_id: "event_2" });
    pr = ctx.db._tables.pull_requests[0];
    expect(pr.checks).toHaveLength(1);
    expect(pr.checks[0]).toMatchObject({ name: "test (ubuntu)", external_id: "1002" });
    expect(pr.checks_state).toBe("success");
  });

  test("a suite for an older head does not speak for the current one", async () => {
    const ctx = context(
      checkSuitePayload({ conclusion: "failure", head_sha: "0000000000000000000000000000000000000000" }),
      "completed",
      "check_suite",
    );
    await (processCheckSuiteEvent as any)._handler(ctx, { event_id: "event_1" });

    expect(ctx.db._tables.pull_requests[0].checks ?? []).toHaveLength(0);
  });
});

describe("a settled check asks whether the branch still merges", () => {
  test("a completed check schedules a merge state refresh", async () => {
    const ctx = context(checkRunPayload({ conclusion: "success" }), "completed", "check_run");
    await (processCheckRunEvent as any)._handler(ctx, { event_id: "event_1" });

    const refresh = ctx._scheduled.filter((s: any) => s.args?.pr_id === PR && s.args?.attempt === 0);
    expect(refresh).toHaveLength(1);
    expect(refresh[0].delay).toBe(10 * 1000);
  });

  test("a check still running asks nothing", async () => {
    const ctx = context(
      checkRunPayload({ status: "in_progress", conclusion: null }),
      "created",
      "check_run",
    );
    await (processCheckRunEvent as any)._handler(ctx, { event_id: "event_1" });
    expect(ctx._scheduled.filter((s: any) => s.args?.attempt === 0)).toHaveLength(0);
  });

  test("one leg of a matrix finishing while others run does not ask yet", async () => {
    // Twenty legs would otherwise queue twenty refreshes for the same answer.
    const ctx = context(checkRunPayload({ id: 1002, name: "test (macos)", conclusion: "success" }), "completed", "check_run", {
      pull_requests: [
        pullRequest({
          checks: [{ name: "test (ubuntu)", status: "in_progress", updated_at: 1, external_id: "991" }],
        }),
      ],
    });
    await (processCheckRunEvent as any)._handler(ctx, { event_id: "event_1" });
    expect(ctx.db._tables.pull_requests[0].checks_state).toBe("pending");
    expect(ctx._scheduled.filter((s: any) => s.args?.attempt === 0)).toHaveLength(0);
  });
});

describe("pull_request_review_thread", () => {
  const threadPayload = (action: string) => ({
    action,
    repository: { full_name: "codecast-sh/codecast" },
    sender: { login: "reviewer" },
    thread: { comments: [{ id: 1 }, { id: 2 }] },
  });

  function threadContext(action: string, comments: any[]) {
    return context(threadPayload(action), action, "pull_request_review_thread", {
      review_comments: comments,
    });
  }

  test("resolving a thread marks every comment in it", async () => {
    const ctx = threadContext("resolved", [
      { _id: "rc_1", github_comment_id: 1, pull_request_id: PR, resolved: false, created_at: 1 },
      { _id: "rc_2", github_comment_id: 2, pull_request_id: PR, resolved: false, created_at: 2 },
      { _id: "rc_3", github_comment_id: 3, pull_request_id: PR, resolved: false, created_at: 3 },
    ]);
    const out = await (processReviewThreadEvent as any)._handler(ctx, { event_id: "event_1" });
    expect(out.marked).toBe(2);

    const rows = ctx.db._tables.review_comments;
    expect(rows[0].resolved).toBe(true);
    expect(rows[0].resolved_at).toBeGreaterThan(0);
    expect(rows[1].resolved).toBe(true);
    // A comment outside the thread is untouched.
    expect(rows[2].resolved).toBe(false);
  });

  test("unresolving a thread puts it back", async () => {
    const ctx = threadContext("unresolved", [
      { _id: "rc_1", github_comment_id: 1, pull_request_id: PR, resolved: true, resolved_at: 500, created_at: 1 },
    ]);
    await (processReviewThreadEvent as any)._handler(ctx, { event_id: "event_1" });

    const row = ctx.db._tables.review_comments[0];
    expect(row.resolved).toBe(false);
    expect(row.resolved_at).toBeUndefined();
  });

  test("any other action is recorded and ignored", async () => {
    const ctx = threadContext("edited", [
      { _id: "rc_1", github_comment_id: 1, pull_request_id: PR, resolved: false, created_at: 1 },
    ]);
    const out = await (processReviewThreadEvent as any)._handler(ctx, { event_id: "event_1" });
    expect(out.skipped).toBe(true);
    expect(ctx.db._tables.review_comments[0].resolved).toBe(false);
    expect(ctx.db._tables.github_webhook_events[0].processed).toBe(true);
  });
});

// ── One job, two triggers ──
//
// A workflow with `on: [push, pull_request]` runs the same job twice on one
// commit, once per check suite, and GitHub lists both. Keyed by name alone the
// two collapsed into one row that showed whichever reported last.

import { processWorkflowRunEvent } from "./githubWebhooks";

const workflowRunPayload = (over: Record<string, any> = {}) => ({
  repository: { full_name: "codecast-sh/codecast" },
  sender: { login: "github-actions" },
  workflow_run: {
    id: 700,
    name: "CI",
    event: "push",
    check_suite_id: 9001,
    head_sha: HEAD,
    status: "queued",
    conclusion: null,
    pull_requests: [{ number: 12 }],
    ...over,
  },
});

/** A check_run belonging to a suite, as GitHub Actions reports it. */
const suiteRun = (suiteId: number, over: Record<string, any> = {}) =>
  checkRunPayload({ check_suite: { id: suiteId, head_branch: "ct-48298-git-backend" }, ...over });

/** Seed the suite → event mapping the workflow_run deliveries write. */
const suites = (rows: Array<{ suite_id: string; event: string }>) => ({
  github_check_suites: rows.map((r, i) => ({ _id: `suite_${i}`, repository: "codecast-sh/codecast", updated_at: 1, ...r })),
});

describe("a job that runs on both push and pull_request", () => {
  test("workflow_run remembers which event triggered its suite", async () => {
    const ctx = context(workflowRunPayload(), "requested", "workflow_run", { github_check_suites: [] });
    const out = await (processWorkflowRunEvent as any)._handler(ctx, { event_id: "event_1" });
    expect(out).toMatchObject({ suite_id: "9001", event: "push" });
    expect(ctx.db._tables.github_check_suites).toHaveLength(1);
    expect(ctx.db._tables.github_check_suites[0]).toMatchObject({
      repository: "codecast-sh/codecast",
      suite_id: "9001",
      event: "push",
      workflow_run_id: "700",
      head_sha: HEAD,
    });
    expect(ctx.db._tables.github_webhook_events[0].processed).toBe(true);
  });

  test("a later delivery for the same suite updates the row rather than adding one", async () => {
    const ctx = context(workflowRunPayload({ status: "completed", conclusion: "success" }), "completed", "workflow_run", {
      ...suites([{ suite_id: "9001", event: "push" }]),
    });
    await (processWorkflowRunEvent as any)._handler(ctx, { event_id: "event_1" });
    expect(ctx.db._tables.github_check_suites).toHaveLength(1);
  });

  test("the push run and the pull_request run of one job coexist", async () => {
    const ctx = context(suiteRun(9002, { id: 1002, conclusion: "success" }), "completed", "check_run", {
      ...suites([{ suite_id: "9001", event: "push" }, { suite_id: "9002", event: "pull_request" }]),
      pull_requests: [
        pullRequest({
          checks_state: "failure",
          checks: [
            { name: "test (ubuntu)", status: "completed", conclusion: "failure", updated_at: 1, external_id: "991", suite_id: "9001", event: "push" },
          ],
        }),
      ],
    });
    await (processCheckRunEvent as any)._handler(ctx, { event_id: "event_1" });

    const pr = ctx.db._tables.pull_requests[0];
    expect(pr.checks).toHaveLength(2);
    expect(pr.checks.map((c: any) => [c.event, c.conclusion])).toEqual([
      ["push", "failure"],
      ["pull_request", "success"],
    ]);
    // The push run is still red, so the PR is still red: the green wake must not fire.
    expect(pr.checks_state).toBe("failure");
    expect(ctx._scheduled.some((s: any) => s.args?.event_type === "pr_checks_green")).toBe(false);
  });

  test("a re-run of the push job replaces only the push entry", async () => {
    const ctx = context(suiteRun(9001, { id: 1003, conclusion: "success" }), "completed", "check_run", {
      ...suites([{ suite_id: "9001", event: "push" }, { suite_id: "9002", event: "pull_request" }]),
      pull_requests: [
        pullRequest({
          checks_state: "failure",
          shepherd_state: "ci_red",
          checks: [
            { name: "test (ubuntu)", status: "completed", conclusion: "failure", updated_at: 1, external_id: "991", suite_id: "9001", event: "push" },
            { name: "test (ubuntu)", status: "completed", conclusion: "success", updated_at: 2, external_id: "992", suite_id: "9002", event: "pull_request" },
          ],
        }),
      ],
    });
    await (processCheckRunEvent as any)._handler(ctx, { event_id: "event_1" });

    const pr = ctx.db._tables.pull_requests[0];
    expect(pr.checks).toHaveLength(2);
    expect(pr.checks.find((c: any) => c.event === "pull_request").external_id).toBe("992");
    expect(pr.checks.find((c: any) => c.event === "push")).toMatchObject({ external_id: "1003", conclusion: "success" });
    expect(pr.checks_state).toBe("success");
    expect(ctx._scheduled.some((s: any) => s.args?.event_type === "pr_checks_green")).toBe(true);
  });

  test("a re-run of the pull_request job replaces only the pull_request entry", async () => {
    const ctx = context(suiteRun(9002, { id: 1004, conclusion: "failure" }), "completed", "check_run", {
      ...suites([{ suite_id: "9001", event: "push" }, { suite_id: "9002", event: "pull_request" }]),
      pull_requests: [
        pullRequest({
          checks_state: "success",
          checks: [
            { name: "test (ubuntu)", status: "completed", conclusion: "success", updated_at: 1, external_id: "991", suite_id: "9001", event: "push" },
            { name: "test (ubuntu)", status: "completed", conclusion: "success", updated_at: 2, external_id: "992", suite_id: "9002", event: "pull_request" },
          ],
        }),
      ],
    });
    await (processCheckRunEvent as any)._handler(ctx, { event_id: "event_1" });

    const pr = ctx.db._tables.pull_requests[0];
    expect(pr.checks).toHaveLength(2);
    expect(pr.checks.find((c: any) => c.event === "push").external_id).toBe("991");
    expect(pr.checks.find((c: any) => c.event === "pull_request")).toMatchObject({ external_id: "1004", conclusion: "failure" });
    expect(pr.checks_state).toBe("failure");
    // The failure names the run that failed, so the shepherd knows which of the two to look at.
    expect(ctx.db._tables.external_events[0].title).toBe("CI failed: test (ubuntu) (pull_request)");
    expect(ctx.db._tables.agent_tasks[0].prompt).toContain("test (ubuntu) (pull_request) failure");
  });

  test("a run whose workflow_run has not arrived is still its own suite's check", async () => {
    // Deliveries are not ordered. The pull_request suite's check_run can land
    // before its workflow_run: it must not replace the push entry, and the
    // later delivery for the same suite (event now known) replaces it by suite.
    const ctx = context(suiteRun(9002, { id: 1005, status: "in_progress", conclusion: null }), "created", "check_run", {
      ...suites([{ suite_id: "9001", event: "push" }]),
      github_webhook_events: [
        {
          _id: "event_1", delivery_id: "d1", event_type: "check_run", action: "created", processed: false, created_at: 0,
          payload: JSON.stringify(suiteRun(9002, { id: 1005, status: "in_progress", conclusion: null })),
        },
        {
          _id: "event_2", delivery_id: "d2", event_type: "workflow_run", action: "requested", processed: false, created_at: 1,
          payload: JSON.stringify(workflowRunPayload({ id: 701, event: "pull_request", check_suite_id: 9002 })),
        },
        {
          _id: "event_3", delivery_id: "d3", event_type: "check_run", action: "completed", processed: false, created_at: 2,
          payload: JSON.stringify(suiteRun(9002, { id: 1005, conclusion: "success" })),
        },
      ],
      pull_requests: [
        pullRequest({
          checks_state: "failure",
          checks: [
            { name: "test (ubuntu)", status: "completed", conclusion: "failure", updated_at: 1, external_id: "991", suite_id: "9001", event: "push" },
          ],
        }),
      ],
    });

    await (processCheckRunEvent as any)._handler(ctx, { event_id: "event_1" });
    let pr = ctx.db._tables.pull_requests[0];
    expect(pr.checks).toHaveLength(2);
    expect(pr.checks[1]).toMatchObject({ external_id: "1005", suite_id: "9002" });
    expect(pr.checks[1].event).toBeUndefined();

    await (processWorkflowRunEvent as any)._handler(ctx, { event_id: "event_2" });
    await (processCheckRunEvent as any)._handler(ctx, { event_id: "event_3" });
    pr = ctx.db._tables.pull_requests[0];
    expect(pr.checks).toHaveLength(2);
    expect(pr.checks.map((c: any) => [c.event, c.external_id, c.conclusion])).toEqual([
      ["push", "991", "failure"],
      ["pull_request", "1005", "success"],
    ]);
    expect(pr.checks_state).toBe("failure");
  });

  test("a check that is not GitHub Actions keeps the by name behaviour", async () => {
    // Another app's check_run carries a suite but never a workflow_run, so no
    // event is ever learned: a re-run replaces by name even across suites.
    const ctx = context(suiteRun(7777, { id: 2002, name: "buildkite/build", conclusion: "success" }), "completed", "check_run", {
      github_check_suites: [],
      pull_requests: [
        pullRequest({
          checks_state: "failure",
          checks: [
            { name: "buildkite/build", status: "completed", conclusion: "failure", updated_at: 1, external_id: "2001", suite_id: "7776" },
          ],
        }),
      ],
    });
    await (processCheckRunEvent as any)._handler(ctx, { event_id: "event_1" });

    const pr = ctx.db._tables.pull_requests[0];
    expect(pr.checks).toHaveLength(1);
    expect(pr.checks[0]).toMatchObject({ name: "buildkite/build", external_id: "2002", conclusion: "success" });
    expect(pr.checks[0].event).toBeUndefined();
    expect(pr.checks_state).toBe("success");
  });

  test("a commit status with the same name as an Actions job with no known event replaces it by name", async () => {
    const ctx = context(
      { repository: { full_name: "codecast-sh/codecast" }, sha: HEAD, state: "success", context: "build" },
      undefined as any,
      "status",
      {
        pull_requests: [
          pullRequest({ checks: [{ name: "build", status: "completed", conclusion: "failure", updated_at: 1, external_id: "3001" }] }),
        ],
      },
    );
    await (processStatusEvent as any)._handler(ctx, { event_id: "event_1" });
    expect(ctx.db._tables.pull_requests[0].checks).toHaveLength(1);
    expect(ctx.db._tables.pull_requests[0].checks_state).toBe("success");
  });
});
