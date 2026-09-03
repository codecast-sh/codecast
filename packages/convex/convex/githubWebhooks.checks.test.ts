import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { processCheckRunEvent, processStatusEvent, processCheckSuiteEvent } from "./githubWebhooks";

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
