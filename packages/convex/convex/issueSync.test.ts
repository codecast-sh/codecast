import { describe, expect, test } from "bun:test";
import { GITHUB_EVENT_KINDS, linearEventKind } from "./issueSync";
import { linearDeliveryId, verifyLinearSignature } from "./linearWebhooks";
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
