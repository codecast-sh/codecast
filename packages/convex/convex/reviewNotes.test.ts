import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { add, list, send } from "./reviewNotes";
import { canAccessComment, update } from "./codeComments";

const USER = "user_1" as any;
const OTHER = "user_2" as any;
const TEAM = "team_1" as any;
const CONV = "conv_1" as any;
const ROOT = "/Users/ashot/src/demo";

function context(user: string | null, seed: Record<string, any[]> = {}) {
  const scheduled: Array<{ delay: number; reference: any; args: any }> = [];
  const db = makeFakeDb({
    users: [{ _id: USER, name: "Ashot" }, { _id: OTHER, name: "Sam" }],
    teams: [{ _id: TEAM, name: "Codecast" }],
    team_memberships: [
      { _id: "m1", user_id: USER, team_id: TEAM },
      { _id: "m2", user_id: OTHER, team_id: TEAM },
    ],
    directory_team_mappings: [],
    conversations: [
      { _id: CONV, user_id: USER, is_private: true, session_id: "sess-1", title: "Git backend" },
    ],
    review_comments: [],
    pending_messages: [],
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

async function addNote(ctx: any, over: Record<string, any> = {}) {
  return await (add as any)._handler(ctx, {
    git_root: ROOT,
    repository: "codecast-sh/codecast",
    ref: "abcdef1234567890",
    file_path: "src/api.ts",
    line_number: 42,
    content: "this leaks on the error path",
    diff_identity: "blob:aaaaaaaaaaaa",
    ...over,
  });
}

describe("reviewNotes.add", () => {
  test("writes a review_comments row stamped with the personal workspace", async () => {
    const ctx = context(USER);
    const result = await addNote(ctx);

    const row = ctx.db._tables.review_comments[0];
    expect(row.author_user_id).toBe(USER);
    expect(row.repository).toBe("codecast-sh/codecast");
    expect(row.file_path).toBe("src/api.ts");
    expect(row.line_number).toBe(42);
    expect(row.git_root).toBe(ROOT);
    expect(row.diff_identity).toBe("blob:aaaaaaaaaaaa");
    expect(row.codecast_origin).toBe(true);
    expect(row.sent_at).toBeUndefined();
    // An unmapped directory is the author's own workspace, never the team's.
    expect(row.workspace).toBe(`user:${USER}`);
    expect(result.workspace).toBe(`user:${USER}`);
  });

  test("a mapped directory makes the note the team's", async () => {
    const ctx = context(USER, {
      directory_team_mappings: [
        { _id: "map1", user_id: USER, team_id: TEAM, path_prefix: ROOT, auto_share: true, created_at: 1 },
      ],
    });
    await addNote(ctx);
    expect(ctx.db._tables.review_comments[0].workspace).toBe(`team:${TEAM}`);
  });

  test("a whole-file note carries no line", async () => {
    const ctx = context(USER);
    await addNote(ctx, { line_number: 0 });
    expect(ctx.db._tables.review_comments[0].line_number).toBeUndefined();
  });

  test("an empty note is refused", async () => {
    const ctx = context(USER);
    await expect(addNote(ctx, { content: "   " })).rejects.toThrow(/needs a body/);
  });
});

describe("access", () => {
  test("a personal note stays personal even to a teammate on the same repository", async () => {
    const ctx = context(USER);
    await addNote(ctx);
    const row = ctx.db._tables.review_comments[0];
    expect(await canAccessComment(ctx, USER, row)).toBe(true);
    expect(await canAccessComment(ctx, OTHER, row)).toBe(false);
  });

  test("a team note reaches every member", async () => {
    const ctx = context(USER, {
      directory_team_mappings: [
        { _id: "map1", user_id: USER, team_id: TEAM, path_prefix: ROOT, auto_share: true, created_at: 1 },
      ],
    });
    await addNote(ctx);
    const row = ctx.db._tables.review_comments[0];
    expect(await canAccessComment(ctx, OTHER, row)).toBe(true);
  });
});

describe("reviewNotes.list", () => {
  test("the batch is this worktree's unsent notes, oldest first", async () => {
    const ctx = context(USER);
    await addNote(ctx, { content: "first" });
    await addNote(ctx, { content: "second" });
    await addNote(ctx, { content: "elsewhere", git_root: "/other/tree" });

    const batch = await (list as any)._handler(ctx, { git_root: ROOT });
    expect(batch.map((r: any) => r.content)).toEqual(["first", "second"]);

    ctx.db._tables.review_comments[0].sent_at = 5;
    expect((await (list as any)._handler(ctx, { git_root: ROOT })).map((r: any) => r.content)).toEqual(["second"]);
    expect((await (list as any)._handler(ctx, { git_root: ROOT, include_sent: true })).length).toBe(2);
  });
});

describe("reviewNotes.send", () => {
  test("one message carries the batch, and every note is stamped sent", async () => {
    const ctx = context(USER);
    await addNote(ctx, { content: "first" });
    await addNote(ctx, { content: "second", file_path: "src/db.ts", line_number: 10, line_end: 20 });

    const stale = [ctx.db._tables.review_comments[1]._id];
    const result = await (send as any)._handler(ctx, {
      git_root: ROOT,
      conversation_ref: "sess-1",
      stale_ids: stale,
    });

    expect(result.sent).toBe(2);
    expect(result.content).toContain("Ashot left 2 review notes on codecast-sh/codecast@abcdef1");
    expect(result.content).toContain("File: src/api.ts\nLine: 42");
    expect(result.content).toContain("File: src/db.ts\nLines: 10-20");
    expect(result.content).toContain("Stale: the file changed");
    // The note reaches the agent fenced, never as the conversation's own voice.
    expect(result.content).toMatch(/<untrusted-[0-9a-f]{8} source="review note by Ashot">/);

    const queued = ctx.db._tables.pending_messages ?? [];
    expect(queued.length).toBe(1);
    expect(queued[0].content).toBe(result.content);

    for (const row of ctx.db._tables.review_comments) expect(typeof row.sent_at).toBe("number");
    expect(await (list as any)._handler(ctx, { git_root: ROOT })).toEqual([]);
  });

  test("an empty batch is an error, not an empty message", async () => {
    const ctx = context(USER);
    await expect((send as any)._handler(ctx, { git_root: ROOT, conversation_ref: "sess-1" }))
      .rejects.toThrow(/No unsent review notes/);
  });

  test("a session that does not resolve is named in the error", async () => {
    const ctx = context(USER);
    await addNote(ctx);
    await expect((send as any)._handler(ctx, { git_root: ROOT, conversation_ref: "nope" }))
      .rejects.toThrow(/nope/);
  });

  test("editing a sent note puts it back in the batch", async () => {
    const ctx = context(USER);
    await addNote(ctx);
    await (send as any)._handler(ctx, { git_root: ROOT, conversation_ref: "sess-1" });
    const id = ctx.db._tables.review_comments[0]._id;
    expect(typeof ctx.db._tables.review_comments[0].sent_at).toBe("number");

    await (update as any)._handler(ctx, { comment_id: id, content: "what I actually meant" });
    expect(ctx.db._tables.review_comments[0].sent_at).toBeUndefined();
    const batch = await (list as any)._handler(ctx, { git_root: ROOT });
    expect(batch.map((r: any) => r.content)).toEqual(["what I actually meant"]);
  });
});
