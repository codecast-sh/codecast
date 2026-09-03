import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { create, listForFile, resolve, update } from "./codeComments";

const USER = "user_1" as any;
const OTHER = "user_2" as any;
const TEAM = "team_1" as any;
const CONV = "conv_1" as any;
const PR = "pr_1" as any;
const HEAD = "abcdef1234567890abcdef1234567890abcdef12";

function context(user: string | null, seed: Record<string, any[]> = {}) {
  const scheduled: Array<{ delay: number; reference: any; args: any }> = [];
  const db = makeFakeDb({
    users: [{ _id: USER, name: "Ashot" }, { _id: OTHER, name: "Sam" }],
    team_memberships: [
      { _id: "m1", user_id: USER, team_id: TEAM },
      { _id: "m2", user_id: OTHER, team_id: TEAM },
    ],
    github_app_installations: [
      { _id: "inst_1", team_id: TEAM, installation_id: 7, account_login: "codecast-sh", repository_selection: "all" },
    ],
    conversations: [{ _id: CONV, user_id: USER, is_private: true, session_id: "sess-1", title: "Git backend" }],
    pull_requests: [
      {
        _id: PR, team_id: TEAM, repository: "codecast-sh/codecast", number: 12, title: "PR", state: "open",
        head_sha: HEAD, head_ref: "b", author_github_username: "ashot", linked_session_ids: [],
        created_at: 1, updated_at: 2,
        files: [{ filename: "src/foo.ts", status: "modified", additions: 1, deletions: 0, changes: 1 }],
      },
    ],
    review_comments: [],
    external_events: [],
    tasks: [],
    managed_sessions: [],
    ...seed,
  });
  return {
    db,
    auth: { async getUserIdentity() { return user ? { subject: `${user}|session` } : null; } },
    scheduler: {
      async runAfter(delay: number, reference: any, args: any) { scheduled.push({ delay, reference, args }); },
    },
    _scheduled: scheduled,
  } as any;
}

describe("codeComments.create", () => {
  test("writes a codecast comment, records the event and queues the mirror", async () => {
    const ctx = context(USER);
    const result = await (create as any)._handler(ctx, {
      repository: "codecast-sh/codecast",
      ref: HEAD,
      file_path: "src/foo.ts",
      line_number: 42,
      content: "this leaks on the error path",
      conversation_ref: "sess-1",
    });

    const comment = ctx.db._tables.review_comments[0];
    expect(comment).toMatchObject({
      repository: "codecast-sh/codecast",
      ref: HEAD,
      file_path: "src/foo.ts",
      line_number: 42,
      author_user_id: USER,
      author_kind: "user",
      codecast_origin: true,
      conversation_id: CONV,
      resolved: false,
    });
    expect(result.comment_id).toBe(comment._id);

    const event = ctx.db._tables.external_events[0];
    expect(event).toMatchObject({
      kind: "code_comment",
      source: "codecast",
      team_id: TEAM,
      title: "Comment on src/foo.ts:42",
      summary: "this leaks on the error path",
      conversation_id: CONV,
      comment_id: comment._id,
    });

    // The file sits in an open pull request, so the comment is mirrored there.
    expect(comment.pull_request_id).toBe(PR);
    const mirror = ctx._scheduled.find((s: any) => s.args?.comment_id === comment._id);
    expect(mirror.args).toMatchObject({ comment_id: comment._id, pr_id: PR });
  });

  test("an agent's comment says so", async () => {
    const ctx = context(USER);
    await (create as any)._handler(ctx, {
      repository: "codecast-sh/codecast",
      file_path: "src/foo.ts",
      content: "fixed in the next push",
      author_kind: "agent",
    });
    expect(ctx.db._tables.review_comments[0].author_kind).toBe("agent");
  });

  test("mirror false keeps the comment inside codecast", async () => {
    const ctx = context(USER);
    await (create as any)._handler(ctx, {
      repository: "codecast-sh/codecast",
      file_path: "src/foo.ts",
      content: "note to self",
      mirror: false,
    });
    expect(ctx._scheduled).toHaveLength(0);
    expect(ctx.db._tables.review_comments[0].pull_request_id).toBeUndefined();
  });

  test("a file no open pull request touches is not mirrored", async () => {
    const ctx = context(USER);
    await (create as any)._handler(ctx, {
      repository: "codecast-sh/codecast",
      file_path: "docs/unrelated.md",
      content: "typo here",
    });
    expect(ctx._scheduled).toHaveLength(0);
  });

  test("a repository nobody installed the app on is refused", async () => {
    const ctx = context(USER, { github_app_installations: [] });
    await expect(
      (create as any)._handler(ctx, { repository: "someone/else", file_path: "a.ts", content: "hi" }),
    ).rejects.toThrow("No GitHub App installation covers someone/else");
  });

  test("a stranger to the team is refused", async () => {
    const ctx = context("user_3", { team_memberships: [{ _id: "m1", user_id: USER, team_id: TEAM }] });
    await expect(
      (create as any)._handler(ctx, { repository: "codecast-sh/codecast", file_path: "a.ts", content: "hi" }),
    ).rejects.toThrow("Forbidden");
  });

  test("a reply inherits its parent's pull request and ref", async () => {
    const ctx = context(USER, {
      review_comments: [
        {
          _id: "rc_parent", pull_request_id: PR, repository: "codecast-sh/codecast", ref: HEAD,
          file_path: "src/foo.ts", line_number: 42, content: "this leaks", resolved: false,
          created_at: 1, author_github_username: "samvit", author_kind: "github",
        },
      ],
    });
    await (create as any)._handler(ctx, {
      repository: "codecast-sh/codecast",
      file_path: "src/foo.ts",
      line_number: 42,
      content: "fixed, thanks",
      parent_id: "rc_parent",
      mirror: false,
    });
    const reply = ctx.db._tables.review_comments[1];
    expect(reply).toMatchObject({ parent_id: "rc_parent", pull_request_id: PR, ref: HEAD });
  });
});

describe("codeComments reads and writes", () => {
  const seeded = () => ({
    review_comments: [
      {
        _id: "rc_1", repository: "codecast-sh/codecast", file_path: "src/foo.ts", ref: HEAD,
        content: "mine", resolved: false, created_at: 1, author_user_id: USER, author_kind: "user",
      },
      {
        _id: "rc_2", repository: "codecast-sh/codecast", file_path: "src/foo.ts", ref: "other-sha",
        content: "on another commit", resolved: false, created_at: 2, author_user_id: USER, author_kind: "user",
      },
      {
        _id: "rc_3", repository: "codecast-sh/codecast", file_path: "src/foo.ts", ref: HEAD,
        content: "from github", resolved: false, created_at: 3, author_github_username: "samvit", author_kind: "github",
      },
    ],
  });

  test("listForFile answers for a file, and narrows to one ref when asked", async () => {
    const ctx = context(USER, seeded());
    const all = await (listForFile as any)._handler(ctx, {
      repository: "codecast-sh/codecast",
      file_path: "src/foo.ts",
    });
    expect(all.map((c: any) => c._id)).toEqual(["rc_1", "rc_2", "rc_3"]);

    const atHead = await (listForFile as any)._handler(ctx, {
      repository: "codecast-sh/codecast",
      file_path: "src/foo.ts",
      ref: HEAD,
    });
    expect(atHead.map((c: any) => c._id)).toEqual(["rc_1", "rc_3"]);
  });

  test("a comment from GitHub is edited on GitHub, not here", async () => {
    const ctx = context(USER, seeded());
    await expect(
      (update as any)._handler(ctx, { comment_id: "rc_3", content: "no" }),
    ).rejects.toThrow("edit this comment on GitHub");
  });

  test("only the author may edit their own comment", async () => {
    const ctx = context(OTHER, seeded());
    await expect(
      (update as any)._handler(ctx, { comment_id: "rc_1", content: "no" }),
    ).rejects.toThrow("only the author");
  });

  test("anyone with access may mark a thread settled, and it says who", async () => {
    const ctx = context(OTHER, seeded());
    await (resolve as any)._handler(ctx, { comment_id: "rc_3" });
    const comment = ctx.db._tables.review_comments[2];
    expect(comment.resolved).toBe(true);
    expect(comment.resolved_by).toBe(OTHER);
    expect(comment.resolved_at).toBeGreaterThan(0);
  });
});
