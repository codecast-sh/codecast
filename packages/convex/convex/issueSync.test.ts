import { describe, expect, test } from "bun:test";
import { GITHUB_EVENT_KINDS, linearEventKind } from "./issueSync";
import { linearDeliveryId, verifyLinearSignature } from "./linearWebhooks";
import { markSourceSynced } from "./issueSync";
import { makeFakeDb } from "./testDb";
import {
  normalizeGithubComment,
  normalizeGithubIssue,
  normalizeLinearComment,
  normalizeLinearIssue,
} from "./lib/issueMapping";

// Whole webhook payloads, trimmed to the fields the handlers read, so the
// classification and the ingest guards are pinned against the real shapes
// rather than against what we remember them to be.

/* ---------------- Linear ---------------- */

const LINEAR_ISSUE_CREATE = {
  action: "create",
  type: "Issue",
  webhookId: "wh_01",
  webhookTimestamp: 1_760_000_000_000,
  actor: { id: "user_1", name: "Ada Lovelace" },
  data: {
    id: "issue_uuid_1",
    identifier: "LIN-482",
    number: 482,
    url: "https://linear.app/acme/issue/LIN-482/fix-the-sync",
    title: "Fix the sync",
    description: "It drops events under load.",
    priority: 2,
    state: { id: "s_todo", name: "Todo", type: "unstarted" },
    team: { id: "team_abc", key: "LIN" },
    project: { id: "project_xyz" },
    labels: [{ id: "l1", name: "bug" }],
    createdAt: "2026-09-01T10:00:00.000Z",
    updatedAt: "2026-09-01T10:00:00.000Z",
  },
};

// An update carries `updatedFrom` with ONLY the fields that moved — that is
// the whole classification, so each of these produces a different feed kind.
const LINEAR_ISSUE_UPDATE = {
  action: "update",
  type: "Issue",
  webhookId: "wh_02",
  webhookTimestamp: 1_760_000_060_000,
  data: { ...LINEAR_ISSUE_CREATE.data, state: { id: "s_doing", name: "In Progress", type: "started" } },
  updatedFrom: { stateId: "s_todo", updatedAt: "2026-09-01T10:00:00.000Z" },
};

const LINEAR_COMMENT_CREATE = {
  action: "create",
  type: "Comment",
  webhookId: "wh_03",
  webhookTimestamp: 1_760_000_120_000,
  data: {
    id: "comment_uuid_1",
    body: "Looking at it now.",
    url: "https://linear.app/acme/issue/LIN-482#comment-1",
    user: { id: "user_1", name: "Ada Lovelace", email: "ada@acme.dev" },
    issue: { id: "issue_uuid_1", identifier: "LIN-482", team: { id: "team_abc", key: "LIN" } },
    createdAt: "2026-09-01T10:02:00.000Z",
  },
};

describe("linear webhook payloads", () => {
  test("a create webhook normalizes into a task-shaped issue", () => {
    const issue = normalizeLinearIssue(LINEAR_ISSUE_CREATE.data, {
      actor: LINEAR_ISSUE_CREATE.actor.name,
    });
    expect(issue).toMatchObject({
      provider: "linear",
      identifier: "LIN-482",
      status: "open",
      priority: "high",
      team_id: "team_abc",
      project_id: "project_xyz",
      labels: ["bug"],
      actor: "Ada Lovelace",
    });
    expect(linearEventKind("create", LINEAR_ISSUE_CREATE, issue)).toBe("issue_opened");
  });

  test("updatedFrom decides the kind, field by field", () => {
    const moved = normalizeLinearIssue(LINEAR_ISSUE_UPDATE.data);
    expect(moved.status).toBe("in_progress");
    expect(linearEventKind("update", LINEAR_ISSUE_UPDATE, moved)).toBe("issue_status");

    const closed = normalizeLinearIssue({
      ...LINEAR_ISSUE_UPDATE.data,
      state: { id: "s_done", name: "Done", type: "completed" },
    });
    expect(linearEventKind("update", { updatedFrom: { stateId: "s_doing" } }, closed)).toBe("issue_closed");

    expect(linearEventKind("update", { updatedFrom: { assigneeId: null } }, moved)).toBe("issue_assigned");
    expect(linearEventKind("update", { updatedFrom: { labelIds: [] } }, moved)).toBe("issue_labeled");
    expect(linearEventKind("update", { updatedFrom: { title: "old" } }, moved)).toBe("issue_edited");
    expect(linearEventKind("remove", {}, moved)).toBe("issue_closed");
  });

  test("a comment webhook names its parent issue", () => {
    const comment = normalizeLinearComment(LINEAR_COMMENT_CREATE.data);
    expect(comment).toMatchObject({
      provider: "linear",
      id: "comment_uuid_1",
      issue_id: "issue_uuid_1",
      body: "Looking at it now.",
      author: "Ada Lovelace",
    });
  });
});

describe("linear delivery id (S1.4)", () => {
  test("webhook id plus attempt timestamp identifies one delivery", () => {
    expect(linearDeliveryId(LINEAR_ISSUE_CREATE)).toBe("wh_01:1760000000000");
    // Two attempts of the SAME event carry the same webhookId but different
    // timestamps, so a retry after our failure is not swallowed as a duplicate.
    expect(linearDeliveryId(LINEAR_ISSUE_UPDATE)).not.toBe(linearDeliveryId(LINEAR_ISSUE_CREATE));
  });

  test("a payload without webhookId falls back to type and subject", () => {
    expect(linearDeliveryId({ type: "Issue", data: { id: "abc" }, webhookTimestamp: 5 }))
      .toBe("Issue:abc:5");
  });
});

describe("verifyLinearSignature (S6)", () => {
  const secret = "lin_wh_secret";
  const body = JSON.stringify(LINEAR_ISSUE_CREATE);

  async function sign(payload: string, key: string): Promise<string> {
    const cryptoKey = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(key),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const sig = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(payload));
    return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  test("accepts the digest of the exact bytes received", async () => {
    expect(await verifyLinearSignature(body, await sign(body, secret), secret)).toBe(true);
  });

  test("rejects a wrong secret, a tampered body, and a missing header", async () => {
    const good = await sign(body, secret);
    expect(await verifyLinearSignature(body, await sign(body, "wrong"), secret)).toBe(false);
    expect(await verifyLinearSignature(body + " ", good, secret)).toBe(false);
    expect(await verifyLinearSignature(body, null, secret)).toBe(false);
    expect(await verifyLinearSignature(body, good, "")).toBe(false);
  });
});

/* ---------------- GitHub ---------------- */

function githubIssuesPayload(action: string, issue: Record<string, any> = {}) {
  return {
    action,
    sender: { login: "ada", type: "User" },
    repository: { full_name: "acme/widgets" },
    issue: {
      id: 2_100_400_600,
      node_id: "I_kwDOABCD1234",
      number: 91,
      html_url: "https://github.com/acme/widgets/issues/91",
      title: "Sync drops events",
      body: "Repro: hold the queue open.",
      state: "open",
      state_reason: null,
      assignees: [{ login: "ada" }],
      labels: [{ name: "bug" }],
      comments: 1,
      created_at: "2026-09-01T10:00:00.000Z",
      updated_at: "2026-09-01T10:00:00.000Z",
      ...issue,
    },
  };
}

const GITHUB_ISSUE_COMMENT = {
  action: "created",
  sender: { login: "ada", type: "User" },
  repository: { full_name: "acme/widgets" },
  issue: githubIssuesPayload("created").issue,
  comment: {
    id: 55_500,
    node_id: "IC_kwDO999",
    body: "On it.",
    html_url: "https://github.com/acme/widgets/issues/91#issuecomment-55500",
    user: { login: "ada" },
    created_at: "2026-09-01T10:02:00.000Z",
  },
};

describe("github webhook payloads", () => {
  test("opened, edited and closed each map to their feed kind", () => {
    expect(GITHUB_EVENT_KINDS.opened).toBe("issue_opened");
    expect(GITHUB_EVENT_KINDS.edited).toBe("issue_edited");
    expect(GITHUB_EVENT_KINDS.closed).toBe("issue_closed");
    expect(GITHUB_EVENT_KINDS.reopened).toBe("issue_reopened");
    // Assign and unassign are the same kind: the feed row says what the issue
    // now is, not which direction it moved.
    expect(GITHUB_EVENT_KINDS.assigned).toBe("issue_assigned");
    expect(GITHUB_EVENT_KINDS.unassigned).toBe("issue_assigned");
    expect(GITHUB_EVENT_KINDS.labeled).toBe("issue_labeled");
  });

  test("an opened payload normalizes with the repo in its identifier", () => {
    const payload = githubIssuesPayload("opened");
    const issue = normalizeGithubIssue(payload.issue, payload.repository.full_name, {
      actor: payload.sender.login,
    });
    expect(issue).toMatchObject({
      provider: "github",
      id: "I_kwDOABCD1234",
      identifier: "acme/widgets#91",
      number: 91,
      repo: "acme/widgets",
      status: "open",
      assignee_login: "ada",
      actor: "ada",
    });
  });

  test("an edited payload carries the new body", () => {
    const payload = githubIssuesPayload("edited", { body: "Rewritten repro." });
    const issue = normalizeGithubIssue(payload.issue, "acme/widgets");
    expect(issue.description).toBe("Rewritten repro.");
  });

  test("a closed payload keeps completed and not_planned apart", () => {
    const completed = githubIssuesPayload("closed", { state: "closed", state_reason: "completed" });
    const dropped = githubIssuesPayload("closed", { state: "closed", state_reason: "not_planned" });
    expect(normalizeGithubIssue(completed.issue, "acme/widgets").status).toBe("done");
    expect(normalizeGithubIssue(dropped.issue, "acme/widgets").status).toBe("dropped");
  });

  test("an issue_comment payload keys the comment to the issue's node id", () => {
    const issue = normalizeGithubIssue(GITHUB_ISSUE_COMMENT.issue, "acme/widgets");
    const comment = normalizeGithubComment(GITHUB_ISSUE_COMMENT.comment, issue.id);
    expect(comment).toMatchObject({
      provider: "github",
      id: "IC_kwDO999",
      issue_id: "I_kwDOABCD1234",
      body: "On it.",
      author_login: "ada",
    });
  });
});

describe("markSourceSynced status transitions", () => {
  const run = (status: string, args: Record<string, any>) => {
    const t = { issue_sync_sources: [{ _id: "src_1", status, updated_at: 1 }] as any[] };
    return (markSourceSynced as any)._handler({ db: makeFakeDb(t) }, { source_id: "src_1", ...args }).then(() => t.issue_sync_sources[0]);
  };
  test("a parked source heals on a clean sync; a paused one stays paused", async () => {
    expect((await run("error", {})).status).toBe("active");
    expect((await run("paused", {})).status).toBe("paused");
    expect((await run("active", {})).status).toBe("active");
  });
  test("only an auth failure parks; a transient error leaves the status alone", async () => {
    expect((await run("active", { error: "Linear API 401", auth_failed: true })).status).toBe("error");
    const transient = await run("active", { error: "Linear API 502" });
    expect(transient.status).toBe("active");
    expect(transient.last_error).toBe("Linear API 502");
    const pausedLate = await run("paused", { error: "Linear API 401", auth_failed: true });
    expect(pausedLate.status).toBe("paused");          // the user's pause outlives a late failure
    expect(pausedLate.last_error).toBe("Linear API 401");
  });
});

/* ---------------- The engine on a fake db (S3, S4, S8) ---------------- */

import { applyRemote, pushTask, stampPushed } from "./issueSync";
import { LinearGraphqlError, fetchLabels, findUserByEmail } from "./linearApi";

/** A ctx with a fake db and a scheduler that records instead of running. */
function engineCtx(tables: Record<string, any[]>) {
  const db: any = makeFakeDb(tables);
  if (!db.normalizeId) db.normalizeId = () => null;
  const scheduled: Array<{ fn: any; args: any }> = [];
  return {
    ctx: { db, scheduler: { runAfter: async (_ms: number, fn: any, args: any) => { scheduled.push({ fn, args }); } } },
    db,
    scheduled,
    tables,
  };
}

const SOURCE = {
  _id: "src_1",
  provider: "linear",
  kind: "linear_team",
  external_id: "team_abc",
  project_id: "proj_1",
  user_id: "user_owner",
  team_id: "team_cc",
  workspace: "team:team_cc",
  status: "active",
  auto_spawn: false,
  push_new_tasks: false,
};

const TASK = {
  _id: "task_1",
  short_id: "ct-1",
  title: "Fix the sync",
  description: "It drops events under load.",
  status: "open",
  priority: "high",
  assignee: "user_ada",
  labels: ["bug"],
  team_id: "team_cc",
  project_id: "proj_1",
  user_id: "user_owner",
  conversation_ids: [],
  external: {
    provider: "linear",
    id: "issue_uuid_1",
    identifier: "LIN-482",
    url: "https://linear.app/acme/issue/LIN-482/fix-the-sync",
    number: 482,
    team_id: "team_abc",
    team_key: "LIN",
    project_id: "project_xyz",
    source_id: "src_1",
    remote_updated_at: 1_000,
    synced_at: 1_000,
    assignee_label: "Ada Lovelace",
    state_name: "Todo",
  },
};

const ADA = { _id: "user_ada", email: "ada@acme.dev", name: "Ada Lovelace" };

const sameIssue = (over: Record<string, any> = {}) => normalizeLinearIssue({
  ...LINEAR_ISSUE_CREATE.data,
  state: { id: "s_todo", name: "Todo", type: "unstarted" },
  assignee: { id: "u1", name: "Ada Lovelace", email: "ada@acme.dev" },
  updatedAt: "2026-09-01T11:00:00.000Z",
  ...over,
});

const apply = (ctx: any, args: Record<string, any>) => (applyRemote as any)._handler(ctx, args);

describe("applyRemote on an existing task", () => {
  test("a pull that changes nothing writes nothing and fires nothing", async () => {
    const { ctx, db, scheduled } = engineCtx({
      tasks: [structuredClone(TASK)], issue_sync_sources: [SOURCE], users: [ADA], task_history: [], task_comments: [],
    });
    const res = await apply(ctx, { source_id: "src_1", issue: sameIssue() });
    expect(res.changed).toEqual([]);
    // No patch at all — not even the clock: a reconcile that finds the same
    // issue must not bump updated_at and push the row through the sync log.
    expect(db._patched).toEqual([]);
    expect(db._tables.task_history).toEqual([]);
    expect(scheduled).toEqual([]);
  });

  test("a real edit patches the fields, writes history, and derives its kind", async () => {
    const { ctx, db, scheduled, tables } = engineCtx({
      tasks: [structuredClone(TASK)], issue_sync_sources: [SOURCE], users: [ADA], task_history: [], task_comments: [],
    });
    const res = await apply(ctx, {
      source_id: "src_1",
      issue: sameIssue({ title: "Fix the sync for real", state: { id: "s_done", name: "Done", type: "completed" } }),
    });
    expect(res.changed.sort()).toEqual(["status", "title"]);
    const row = tables.tasks[0];
    expect(row.title).toBe("Fix the sync for real");
    expect(row.status).toBe("done");
    expect(row.closed_at).toBeGreaterThan(0);
    expect(row.external.state_name).toBe("Done");
    expect(tables.task_history.map((h: any) => h.field).sort()).toEqual(["status", "title"]);
    // No kind was passed (a pull), so the diff names it: a close.
    const feed = scheduled.find((s) => s.args?.dedupe_key);
    expect(feed?.args.kind).toBe("issue_closed");
    expect(feed?.args.task_ids).toEqual(["task_1"]);
    const trigger = scheduled.find((s) => s.args?.event_type);
    expect(trigger?.args).toMatchObject({ event_type: "issues", action: "closed", repository: "LIN", team_id: "team_cc" });
    expect(db._patched.length).toBe(1);
  });

  test("a webhook kind wins over the derived one", async () => {
    const { ctx, scheduled } = engineCtx({
      tasks: [structuredClone(TASK)], issue_sync_sources: [SOURCE], users: [ADA], task_history: [], task_comments: [],
    });
    await apply(ctx, { source_id: "src_1", issue: sameIssue({ title: "Renamed" }), event_kind: "issue_edited" });
    expect(scheduled.find((s) => s.args?.dedupe_key)?.args.kind).toBe("issue_edited");
  });

  test("the provider unassigning clears our assignee as an undefined write", async () => {
    const { ctx, db, tables } = engineCtx({
      tasks: [structuredClone(TASK)], issue_sync_sources: [SOURCE], users: [ADA], task_history: [], task_comments: [],
    });
    const res = await apply(ctx, { source_id: "src_1", issue: sameIssue({ assignee: null }) });
    expect(res.changed).toEqual(["assignee"]);
    expect(db._patched[0].patch.assignee).toBeUndefined();
    expect("assignee" in db._patched[0].patch).toBe(true);
    expect(tables.tasks[0].external.assignee_label).toBeUndefined();
    expect(tables.task_history[0]).toMatchObject({ field: "assignee", old_value: "user_ada", new_value: "" });
  });

  test("a category change drops the custom status refinement", async () => {
    const { ctx, db } = engineCtx({
      tasks: [{ ...structuredClone(TASK), status_id: "st_custom" }], issue_sync_sources: [SOURCE], users: [ADA], task_history: [], task_comments: [],
    });
    await apply(ctx, { source_id: "src_1", issue: sameIssue({ state: { id: "s_doing", name: "In Progress", type: "started" } }) });
    expect(db._patched[0].patch).toMatchObject({ status: "in_progress" });
    expect("status_id" in db._patched[0].patch).toBe(true);
    expect(db._patched[0].patch.status_id).toBeUndefined();
  });

  test("a comment we already hold by provider id lands nothing and is not an event", async () => {
    const { ctx, db, scheduled } = engineCtx({
      tasks: [structuredClone(TASK)],
      issue_sync_sources: [SOURCE],
      users: [ADA],
      task_history: [],
      task_comments: [{ _id: "c1", task_id: "task_1", text: "Looking at it now.", created_at: 1, external: { provider: "linear", id: "comment_uuid_1" } }],
    });
    const res = await apply(ctx, {
      source_id: "src_1",
      issue: sameIssue(),
      comments: [normalizeLinearComment(LINEAR_COMMENT_CREATE.data)],
      comment_only: true,
    });
    expect(res.comments).toBe(0);
    expect(db._inserted).toEqual([]);
    expect(scheduled).toEqual([]);
  });

  test("a deletion drops the task once and is inert after", async () => {
    const { ctx, db, tables } = engineCtx({
      tasks: [structuredClone(TASK)], issue_sync_sources: [SOURCE], users: [ADA], task_history: [], task_comments: [],
    });
    await apply(ctx, { source_id: "src_1", issue: { ...sameIssue(), deleted: true }, event_kind: "issue_closed" });
    expect(tables.tasks[0].status).toBe("dropped");
    const writes = db._patched.length;
    await apply(ctx, { source_id: "src_1", issue: { ...sameIssue(), deleted: true }, event_kind: "issue_closed" });
    expect(db._patched.length).toBe(writes);
  });
});

/* ---------------- Outbound label push against a mocked Linear (S5) ---------------- */

describe("pushTask labels", () => {
  const realFetch = globalThis.fetch;
  const graphql = (handler: (query: string, variables: any) => any) => {
    globalThis.fetch = (async (_url: any, init: any) => {
      const { query, variables } = JSON.parse(init.body);
      const out = handler(query, variables);
      return { ok: true, status: 200, json: async () => out, text: async () => JSON.stringify(out) } as any;
    }) as any;
  };
  const restore = () => { globalThis.fetch = realFetch; };

  const pushCtx = (info: any) => {
    const mutations: any[] = [];
    return {
      mutations,
      ctx: {
        runQuery: async () => info,
        runAction: async () => ({ ok: true, token: "tok" }),
        runMutation: async (_fn: any, args: any) => { mutations.push(args); },
      },
    };
  };

  const info = {
    external: { provider: "linear", id: "issue_uuid_1", identifier: "LIN-482", team_id: "team_abc" },
    title: "Fix",
    description: "",
    status: "open",
    priority: "high",
    labels: ["Bug", "needs-repro"],
    assignee_cleared: false,
    assignee_emails: [],
    user_id: "user_owner",
    team_id: "team_cc",
  };

  test("a label the app may not create is kept off the push, the rest lands, the task says why", async () => {
    const calls: string[] = [];
    graphql((query, variables) => {
      if (query.includes("query Labels")) {
        // "Bug" is a WORKSPACE label (team null) — it must be found, not re-created.
        return { data: { issueLabels: { nodes: [{ id: "l_bug", name: "Bug", isGroup: false }, { id: "l_grp", name: "Area", isGroup: true }] } } };
      }
      if (query.includes("mutation CreateLabel")) {
        calls.push(`create:${variables.input.name}`);
        return { errors: [{ message: "not allowed to take action", extensions: { type: "forbidden", code: "FORBIDDEN", statusCode: 403, userPresentableMessage: "You are not allowed to create labels in this team." } }] };
      }
      if (query.includes("mutation UpdateIssue")) {
        calls.push(`update:${JSON.stringify(variables.input)}`);
        return { data: { issueUpdate: { success: true, issue: {} } } };
      }
      throw new Error(`unexpected query ${query.slice(0, 40)}`);
    });
    try {
      const { ctx, mutations } = pushCtx(info);
      const res = await (pushTask as any)._handler(ctx, { task_id: "task_1", fields: ["title", "labels"] });
      expect(res.pushed).toEqual(["title", "labels"]);
      expect(calls).toEqual(["create:needs-repro", 'update:{"title":"Fix","labelIds":["l_bug"]}']);
      // The fields are stamped as pushed (the echo guard needs them) AND the
      // refusal is on the task, in Linear's own words.
      expect(mutations[0]).toMatchObject({ task_id: "task_1", fields: ["title", "labels"] });
      expect(mutations[0].error).toContain("needs-repro");
    } finally {
      restore();
    }
  });

  test("any other failure still parks the push with Linear's readable message", async () => {
    graphql((query) => {
      if (query.includes("query Labels")) return { data: { issueLabels: { nodes: [] } } };
      if (query.includes("mutation CreateLabel")) return { data: { issueLabelCreate: { success: true, issueLabel: { id: "l_new", name: "needs-repro" } } } };
      if (query.includes("mutation UpdateIssue")) {
        return { errors: [{ message: "Entity not found", extensions: { type: "invalid input", userPresentableMessage: "This issue was archived." } }] };
      }
      throw new Error("unexpected");
    });
    try {
      const { ctx, mutations } = pushCtx(info);
      const res = await (pushTask as any)._handler(ctx, { task_id: "task_1", fields: ["labels"] });
      expect(res.error).toBe("Linear GraphQL: This issue was archived.");
      expect(mutations[0]).toMatchObject({ fields: [], error: "Linear GraphQL: This issue was archived." });
    } finally {
      restore();
    }
  });

  test("clearing our assignee unassigns the issue; an agent seat pushes nothing", async () => {
    const inputs: any[] = [];
    graphql((query, variables) => {
      if (query.includes("mutation UpdateIssue")) { inputs.push(variables.input); return { data: { issueUpdate: { success: true, issue: {} } } }; }
      throw new Error("unexpected");
    });
    try {
      await (pushTask as any)._handler(pushCtx({ ...info, assignee_cleared: true }).ctx, { task_id: "t", fields: ["assignee"] });
      const agent = await (pushTask as any)._handler(pushCtx({ ...info, assignee_cleared: false, assignee_emails: [] }).ctx, { task_id: "t", fields: ["assignee"] });
      expect(inputs).toEqual([{ assigneeId: null }]);
      expect(agent.skipped).toBe("nothing_to_push");
    } finally {
      restore();
    }
  });

  test("the assignee is looked up by every address we know for them", async () => {
    const seen: any[] = [];
    graphql((query, variables) => {
      if (query.includes("query UserByEmail")) { seen.push(variables.emails); return { data: { users: { nodes: [{ id: "lu_1", email: "ada@alt.dev" }] } } }; }
      if (query.includes("mutation UpdateIssue")) { seen.push(variables.input); return { data: { issueUpdate: { success: true, issue: {} } } }; }
      throw new Error("unexpected");
    });
    try {
      await (pushTask as any)._handler(pushCtx({ ...info, assignee_emails: ["ada@acme.dev", "ada@alt.dev"] }).ctx, { task_id: "t", fields: ["assignee"] });
      expect(seen).toEqual([["ada@acme.dev", "ada@alt.dev"], { assigneeId: "lu_1" }]);
      expect(await findUserByEmail("tok", [])).toBeNull();
    } finally {
      restore();
    }
  });

  test("fetchLabels drops label groups", async () => {
    graphql(() => ({ data: { issueLabels: { nodes: [{ id: "a", name: "Bug", isGroup: false }, { id: "g", name: "Area", isGroup: true }] } } }));
    try {
      expect(await fetchLabels("tok", "team_abc")).toEqual([{ id: "a", name: "Bug" }]);
    } finally {
      restore();
    }
  });
});

describe("LinearGraphqlError", () => {
  test("prefers the sentence a person can act on and flags a forbidden refusal", () => {
    const e = new LinearGraphqlError([
      { message: "not allowed to take action", extensions: { type: "forbidden", userPresentableMessage: "You are not allowed to create labels in this team." } },
    ]);
    expect(e.message).toBe("Linear GraphQL: You are not allowed to create labels in this team.");
    expect(e.forbidden).toBe(true);
    expect(new LinearGraphqlError([{ message: "boom" }]).forbidden).toBe(false);
  });
});

describe("push errors survive inbound", () => {
  test("a pull that finds the same issue keeps the last push's error and still writes nothing", async () => {
    const parked = structuredClone(TASK);
    parked.external.last_error = "Linear kept these labels off LIN-482: personal";
    const { ctx, db, tables } = engineCtx({
      tasks: [parked], issue_sync_sources: [SOURCE], users: [ADA], task_history: [], task_comments: [],
    });
    await apply(ctx, { source_id: "src_1", issue: sameIssue() });
    expect(db._patched).toEqual([]);
    expect(tables.tasks[0].external.last_error).toBe("Linear kept these labels off LIN-482: personal");
  });

  test("stampPushed records refused labels in the task's history", async () => {
    const { ctx, tables } = engineCtx({ tasks: [structuredClone(TASK)], task_history: [] });
    await (stampPushed as any)._handler(ctx, { task_id: "task_1", fields: ["labels"], error: "kept off", refused_labels: ["personal", "ops"] });
    expect(tables.tasks[0].external.field_ts.labels).toBeGreaterThan(0);
    expect(tables.tasks[0].external.last_error).toBe("kept off");
    expect(tables.task_history[0]).toMatchObject({ actor_type: "system", action: "sync_refused", field: "labels", new_value: "personal, ops" });
    await (stampPushed as any)._handler(ctx, { task_id: "task_1", fields: ["title"] });
    expect(tables.tasks[0].external.last_error).toBeUndefined();
    expect(tables.task_history.length).toBe(1);
  });
});
