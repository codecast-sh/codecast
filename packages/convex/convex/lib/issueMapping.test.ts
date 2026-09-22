import { describe, expect, test } from "bun:test";
import {
  type NormalizedIssue,
  diffAgainstTask,
  githubStateFor,
  githubStatusFor,
  kindFromDiff,
  linearPriorityFor,
  linearStateFor,
  linearStatusFor,
  normalizeGithubComment,
  normalizeGithubIssue,
  normalizeLinearComment,
  normalizeLinearIssue,
} from "./issueMapping";

// The mapping layer is where the echo loop is stopped (S3, S4.2): an inbound
// event whose mapped values already equal the task's produces an EMPTY diff,
// so there is no patch, no history row and nothing to push back. These pin
// that rule and the clock rule that protects a local write in flight.

const T0 = 1_760_000_000_000; // fixed clock; every fixture is relative to it

/* ---------------- fixtures ---------------- */

// A Linear "Issue / update" webhook `data` object, trimmed to the fields we read.
function linearIssue(overrides: Record<string, any> = {}) {
  return {
    id: "ffe1f0aa-3a10-4c19-8e13-7a5f3d0e5cd0",
    identifier: "LIN-482",
    number: 482,
    url: "https://linear.app/acme/issue/LIN-482/fix-the-sync",
    title: "Fix the sync",
    description: "It drops events under load.",
    priority: 2,
    state: { id: "state_started", name: "In Progress", type: "started" },
    team: { id: "team_abc", key: "LIN" },
    project: { id: "project_xyz" },
    assignee: { id: "user_1", name: "Ada Lovelace", email: "ada@acme.dev" },
    labels: [{ id: "l1", name: "bug" }, { id: "l2", name: "agent" }],
    createdAt: new Date(T0 - 86_400_000).toISOString(),
    updatedAt: new Date(T0).toISOString(),
    ...overrides,
  };
}

// A GraphQL issue node returns labels as a connection instead of an array.
function linearIssueNode(overrides: Record<string, any> = {}) {
  const { labels, ...rest } = linearIssue(overrides);
  return { ...rest, labels: { nodes: labels } };
}

function githubIssue(overrides: Record<string, any> = {}) {
  return {
    id: 2_100_400_600,
    node_id: "I_kwDOABCD1234",
    number: 91,
    html_url: "https://github.com/acme/widgets/issues/91",
    title: "Sync drops events",
    body: "Repro: hold the queue open.",
    state: "open",
    state_reason: null,
    assignees: [{ login: "ada", id: 7 }],
    labels: [{ id: 1, name: "bug" }, { id: 2, name: "agent" }],
    created_at: new Date(T0 - 86_400_000).toISOString(),
    updated_at: new Date(T0).toISOString(),
    ...overrides,
  };
}

/* ---------------- status + priority maps (S2) ---------------- */

describe("linearStatusFor", () => {
  test("state types map onto our six categories", () => {
    expect(linearStatusFor("triage", "Triage")).toBe("backlog");
    expect(linearStatusFor("backlog", "Backlog")).toBe("backlog");
    expect(linearStatusFor("unstarted", "Todo")).toBe("open");
    expect(linearStatusFor("started", "In Progress")).toBe("in_progress");
    expect(linearStatusFor("completed", "Done")).toBe("done");
    expect(linearStatusFor("canceled", "Canceled")).toBe("dropped");
    expect(linearStatusFor(undefined, undefined)).toBe("open");
  });

  test("a started state named like review is in_review, not in_progress", () => {
    expect(linearStatusFor("started", "In Review")).toBe("in_review");
    expect(linearStatusFor("started", "Code review")).toBe("in_review");
    expect(linearStatusFor("started", "REVIEWING")).toBe("in_review");
  });
});

describe("priority", () => {
  test("linear 0..4 maps to our words and back", () => {
    for (const [n, word] of [[0, "none"], [1, "urgent"], [2, "high"], [3, "medium"], [4, "low"]] as const) {
      expect(normalizeLinearIssue(linearIssue({ priority: n })).priority).toBe(word);
      expect(linearPriorityFor(word)).toBe(n);
    }
  });

  test("an unknown word pushes as none rather than throwing", () => {
    expect(linearPriorityFor("whenever")).toBe(0);
    expect(linearPriorityFor(undefined)).toBe(0);
  });
});

describe("githubStatusFor / githubStateFor", () => {
  test("closed + not_planned is dropped, closed + completed is done", () => {
    expect(githubStatusFor("open", null)).toBe("open");
    expect(githubStatusFor("closed", "completed")).toBe("done");
    expect(githubStatusFor("closed", "not_planned")).toBe("dropped");
    expect(githubStatusFor("closed", null)).toBe("done");
  });

  test("the reverse write carries the reason that survives a round trip", () => {
    expect(githubStateFor("done")).toEqual({ state: "closed", state_reason: "completed" });
    expect(githubStateFor("dropped")).toEqual({ state: "closed", state_reason: "not_planned" });
    expect(githubStateFor("in_progress").state).toBe("open");
    for (const category of ["open", "in_progress", "in_review", "done", "dropped"]) {
      const write = githubStateFor(category);
      expect(githubStatusFor(write.state, write.state_reason ?? null)).toBe(
        category === "done" || category === "dropped" ? category : "open",
      );
    }
  });
});

/* ---------------- normalizers ---------------- */

describe("normalizeLinearIssue", () => {
  test("a webhook data object maps onto our vocabulary", () => {
    const issue = normalizeLinearIssue(linearIssue(), { now: T0 });
    expect(issue).toMatchObject({
      provider: "linear",
      id: "ffe1f0aa-3a10-4c19-8e13-7a5f3d0e5cd0",
      identifier: "LIN-482",
      number: 482,
      team_key: "LIN",
      team_id: "team_abc",
      project_id: "project_xyz",
      title: "Fix the sync",
      status: "in_progress",
      state_name: "In Progress",
      priority: "high",
      assignee_email: "ada@acme.dev",
      assignee_label: "Ada Lovelace",
      labels: ["bug", "agent"],
      remote_updated_at: T0,
    });
  });

  test("a GraphQL node with a labels connection maps identically", () => {
    const fromWebhook = normalizeLinearIssue(linearIssue(), { now: T0 });
    const fromQuery = normalizeLinearIssue(linearIssueNode(), { now: T0 });
    expect(fromQuery).toEqual(fromWebhook);
  });

  test("identifier falls back to team key and number when absent", () => {
    const issue = normalizeLinearIssue(linearIssue({ identifier: undefined }), { now: T0 });
    expect(issue.identifier).toBe("LIN-482");
  });

  test("a cleared description is an empty string, not undefined", () => {
    expect(normalizeLinearIssue(linearIssue({ description: null }), { now: T0 }).description).toBe("");
  });
});

describe("normalizeGithubIssue", () => {
  test("identifier is owner/repo#N and the id is the node id", () => {
    const issue = normalizeGithubIssue(githubIssue(), "acme/widgets", { now: T0 });
    expect(issue).toMatchObject({
      provider: "github",
      id: "I_kwDOABCD1234",
      identifier: "acme/widgets#91",
      number: 91,
      repo: "acme/widgets",
      status: "open",
      assignee_login: "ada",
      labels: ["bug", "agent"],
      remote_updated_at: T0,
    });
    expect(issue.priority).toBeUndefined();
  });

  test("closed as not_planned is dropped", () => {
    const issue = normalizeGithubIssue(
      githubIssue({ state: "closed", state_reason: "not_planned" }),
      "acme/widgets",
      { now: T0 },
    );
    expect(issue.status).toBe("dropped");
  });
});

describe("comments", () => {
  test("linear comment carries its issue and author", () => {
    const c = normalizeLinearComment(
      {
        id: "comment_1",
        body: "Looking at it now.",
        url: "https://linear.app/acme/issue/LIN-482#comment-1",
        user: { name: "Ada Lovelace", email: "ada@acme.dev" },
        issue: { id: "ffe1f0aa-3a10-4c19-8e13-7a5f3d0e5cd0" },
        createdAt: new Date(T0).toISOString(),
      },
      { now: T0 },
    );
    expect(c).toMatchObject({
      provider: "linear",
      id: "comment_1",
      issue_id: "ffe1f0aa-3a10-4c19-8e13-7a5f3d0e5cd0",
      author: "Ada Lovelace",
      author_email: "ada@acme.dev",
      created_at: T0,
    });
  });

  test("github comment takes the issue id from the caller", () => {
    const c = normalizeGithubComment(
      {
        node_id: "IC_kwDO999",
        body: "On it.",
        html_url: "https://github.com/acme/widgets/issues/91#issuecomment-1",
        user: { login: "ada" },
        created_at: new Date(T0).toISOString(),
      },
      "I_kwDOABCD1234",
      { now: T0 },
    );
    expect(c).toMatchObject({
      provider: "github",
      id: "IC_kwDO999",
      issue_id: "I_kwDOABCD1234",
      author_login: "ada",
      created_at: T0,
    });
  });
});

/* ---------------- the diff: echo guard + clock rule (S3) ---------------- */

describe("diffAgainstTask", () => {
  const task = {
    title: "Fix the sync",
    description: "It drops events under load.",
    status: "in_progress",
    priority: "high",
    assignee: "users_ada",
    labels: ["agent", "bug"],
  };

  test("an echo is a no-op: mapped values equal the task, empty diff", () => {
    const issue = normalizeLinearIssue(linearIssue(), { now: T0 });
    expect(diffAgainstTask(task, issue, { assignee: "users_ada" })).toEqual({});
  });

  test("labels compare as sets, so order and duplicates are not changes", () => {
    const issue = normalizeLinearIssue(
      linearIssue({ labels: [{ name: "agent" }, { name: "bug" }, { name: "bug" }] }),
      { now: T0 },
    );
    expect(diffAgainstTask(task, issue, { assignee: "users_ada" })).toEqual({});
  });

  test("a real label change lands as the provider's full set", () => {
    const issue = normalizeLinearIssue(linearIssue({ labels: [{ name: "bug" }] }), { now: T0 });
    expect(diffAgainstTask(task, issue, { assignee: "users_ada" })).toEqual({ labels: ["bug"] });
  });

  test("only the fields that actually moved are in the diff", () => {
    const issue = normalizeLinearIssue(
      linearIssue({ title: "Fix the sync properly", state: { name: "Done", type: "completed" } }),
      { now: T0 },
    );
    expect(diffAgainstTask(task, issue, { assignee: "users_ada" })).toEqual({
      title: "Fix the sync properly",
      status: "done",
    });
  });

  test("a stale event loses to a newer local push of that field, field by field", () => {
    const issue = normalizeLinearIssue(
      linearIssue({ title: "Stale title", state: { name: "Done", type: "completed" } }),
      { now: T0 },
    );
    // We pushed the title AFTER this event was minted, but not the status.
    const pushed = { ...task, external: { field_ts: { title: T0 + 5_000 } } };
    expect(diffAgainstTask(pushed, issue, { assignee: "users_ada" })).toEqual({ status: "done" });
  });

  test("a tie goes to the provider: its value is what everyone else sees", () => {
    const issue = normalizeLinearIssue(linearIssue({ title: "Their title" }), { now: T0 });
    const pushed = { ...task, external: { field_ts: { title: T0 } } };
    expect(diffAgainstTask(pushed, issue, { assignee: "users_ada" })).toEqual({ title: "Their title" });
  });

  test("an unmapped provider assignee never clears ours", () => {
    const issue = normalizeLinearIssue(
      linearIssue({ assignee: { id: "user_9", name: "Someone Else", email: "nobody@elsewhere.dev" } }),
      { now: T0 },
    );
    expect(diffAgainstTask(task, issue, {})).toEqual({});
    expect(issue.assignee_label).toBe("Someone Else");
  });

  test("github never touches priority, having none", () => {
    const issue = normalizeGithubIssue(githubIssue({ title: "Fix the sync" }), "acme/widgets", { now: T0 });
    const ghTask = { ...task, description: "Repro: hold the queue open.", status: "open" };
    expect(diffAgainstTask(ghTask, issue, { assignee: "users_ada" })).toEqual({});
  });

  test("a cleared body syncs as an empty description", () => {
    const issue = normalizeGithubIssue(githubIssue({ body: null }), "acme/widgets", { now: T0 });
    const ghTask = { ...task, description: "Repro: hold the queue open.", status: "open", title: "Sync drops events" };
    expect(diffAgainstTask(ghTask, issue, { assignee: "users_ada" })).toEqual({ description: "" });
  });
});

/* ---------------- reverse map (S5) ---------------- */

describe("linearStateFor", () => {
  const states = [
    { id: "s_triage", name: "Triage", type: "triage" },
    { id: "s_backlog", name: "Backlog", type: "backlog" },
    { id: "s_todo", name: "Todo", type: "unstarted" },
    { id: "s_doing", name: "In Progress", type: "started" },
    { id: "s_review", name: "In Review", type: "started" },
    { id: "s_done", name: "Done", type: "completed" },
    { id: "s_cancel", name: "Canceled", type: "canceled" },
  ];

  test("each category picks the state the forward map would map back", () => {
    expect(linearStateFor("backlog", states)?.id).toBe("s_triage");
    expect(linearStateFor("open", states)?.id).toBe("s_todo");
    expect(linearStateFor("in_progress", states)?.id).toBe("s_doing");
    expect(linearStateFor("in_review", states)?.id).toBe("s_review");
    expect(linearStateFor("done", states)?.id).toBe("s_done");
    expect(linearStateFor("dropped", states)?.id).toBe("s_cancel");
  });

  test("a team custom status name wins over position", () => {
    expect(linearStateFor("in_progress", states, "In Review")?.id).toBe("s_review");
  });

  test("in_review falls back to any started state when the team has no review column", () => {
    const lean = states.filter((s) => s.id !== "s_review");
    expect(linearStateFor("in_review", lean)?.id).toBe("s_doing");
  });

  test("no plausible state is undefined, not a wrong guess", () => {
    expect(linearStateFor("done", [{ id: "s", name: "Todo", type: "unstarted" }])).toBeUndefined();
  });
});

describe("linearStatusFor: closed-without-done states", () => {
  test("a Duplicate column is dropped, not open", () => {
    // Linear reports a team's Duplicate state with its own type; it is closed
    // without being done, so it must not land as an open task.
    expect(linearStatusFor("duplicate", "Duplicate")).toBe("dropped");
    expect(linearStatusFor("cancelled", "Won't do")).toBe("dropped");
  });
});

describe("diffAgainstTask: unassign (S2)", () => {
  const issue = (over: Partial<NormalizedIssue> = {}): NormalizedIssue => ({
    provider: "linear",
    id: "i1",
    identifier: "LIN-1",
    url: "",
    title: "Fix",
    description: "",
    status: "open",
    labels: [],
    remote_updated_at: 2_000,
    ...over,
  });

  test("the provider going from someone to nobody clears ours", () => {
    const task = { title: "Fix", status: "open", assignee: "user_ada", external: { assignee_label: "Ada" } };
    expect(diffAgainstTask(task, issue())).toEqual({ assignee: null });
  });

  test("nobody on the provider and nobody recorded before is not an unassign", () => {
    // A codecast-only assignment (a user with no Linear account, an assignee
    // set locally) must survive every provider event that shows no assignee.
    const task = { title: "Fix", status: "open", assignee: "user_ada", external: {} };
    expect(diffAgainstTask(task, issue())).toEqual({});
  });

  test("an agent seat is never cleared by the provider", () => {
    const task = { title: "Fix", status: "open", assignee: "agent:claude", external: { assignee_label: "Ada" } };
    expect(diffAgainstTask(task, issue())).toEqual({});
  });

  test("an unmapped provider assignee still leaves ours alone", () => {
    const task = { title: "Fix", status: "open", assignee: "user_ada", external: { assignee_label: "Ada" } };
    expect(diffAgainstTask(task, issue({ assignee_email: "bob@x.dev", assignee_label: "Bob" }))).toEqual({});
  });

  test("a local reassignment newer than the event wins", () => {
    const task = {
      title: "Fix",
      status: "open",
      assignee: "user_ada",
      external: { assignee_label: "Ada", field_ts: { assignee: 5_000 } },
    };
    expect(diffAgainstTask(task, issue())).toEqual({});
  });
});

describe("kindFromDiff (S8 for pulls)", () => {
  test("a created task is opened; an empty diff is no event at all", () => {
    expect(kindFromDiff({}, true, "open")).toBe("issue_opened");
    expect(kindFromDiff({}, false, "open")).toBeUndefined();
  });

  test("status leads, then assignee, then labels, else edited", () => {
    expect(kindFromDiff({ status: "done", title: "x" }, false, "done")).toBe("issue_closed");
    expect(kindFromDiff({ status: "in_progress" }, false, "in_progress")).toBe("issue_status");
    expect(kindFromDiff({ assignee: null }, false, "open")).toBe("issue_assigned");
    expect(kindFromDiff({ labels: ["bug"] }, false, "open")).toBe("issue_labeled");
    expect(kindFromDiff({ title: "x", description: "y" }, false, "open")).toBe("issue_edited");
  });
});
