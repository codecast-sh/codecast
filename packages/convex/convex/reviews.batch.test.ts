// A review is a batch. Notes wait as pending rows the author alone can see,
// then leave as ONE GitHub review, and the webhook echo of those notes is
// adopted rather than ingested twice.
import { describe, expect, test } from "bun:test";
import { getFunctionName } from "convex/server";
import { makeFakeDb } from "./testDb";
import { create, listForPR, pendingReview, discardPendingReview, recordSubmittedReview } from "./codeComments";
import { submitPending, getCommentsForPR, deliverSubmittedReview } from "./reviews";
import { threads, findComment } from "./prCli";

const USER = "user_1" as any;
const OTHER = "user_2" as any;
const TEAM = "team_1" as any;
const PR = "pr_1" as any;
const HEAD = "abcdef1234567890abcdef1234567890abcdef12";

function context(user: string | null, seed: Record<string, any[]> = {}) {
  const scheduled: any[] = [];
  const db = makeFakeDb({
    users: [{ _id: USER, name: "Ashot", github_username: "ashot" }, { _id: OTHER, name: "Sam" }],
    team_memberships: [
      { _id: "m1", user_id: USER, team_id: TEAM },
      { _id: "m2", user_id: OTHER, team_id: TEAM },
    ],
    github_app_installations: [
      { _id: "inst_1", team_id: TEAM, installation_id: 7, account_login: "codecast-sh", repository_selection: "all" },
    ],
    conversations: [],
    pull_requests: [{
      _id: PR, team_id: TEAM, repository: "codecast-sh/codecast", number: 12, title: "PR", state: "open",
      head_sha: HEAD, head_ref: "b", author_github_username: "sam", linked_session_ids: [], created_at: 1, updated_at: 2,
      files: [{ filename: "src/foo.ts", status: "modified", additions: 1, deletions: 0, changes: 1 }],
    }],
    review_comments: [],
    reviews: [],
    external_events: [],
    tasks: [],
    managed_sessions: [],
    ...seed,
  });
  return {
    db,
    auth: { async getUserIdentity() { return user ? { subject: `${user}|session` } : null; } },
    scheduler: { async runAfter(delay: number, reference: any, args: any) { scheduled.push({ delay, reference, args }); } },
    _scheduled: scheduled,
  } as any;
}

describe("a pending note", () => {
  test("is stored for its author, announced nowhere, mirrored nowhere", async () => {
    const ctx = context(USER);
    await (create as any)._handler(ctx, {
      repository: "codecast-sh/codecast", ref: HEAD, pull_request_id: PR,
      file_path: "src/foo.ts", line_number: 4, content: "rename this", pending: true,
    });
    const row = ctx.db._tables.review_comments[0];
    expect(row.pending_review).toBe(true);
    expect(ctx._scheduled).toEqual([]);
    expect(ctx.db._tables.external_events).toEqual([]);
  });

  test("is invisible to a teammate until submitted", async () => {
    const mine = context(USER);
    await (create as any)._handler(mine, {
      repository: "codecast-sh/codecast", ref: HEAD, pull_request_id: PR,
      file_path: "src/foo.ts", line_number: 4, content: "rename this", pending: true,
    });
    const rows = mine.db._tables.review_comments;
    const theirs = context(OTHER, { review_comments: rows });
    expect(await (listForPR as any)._handler(theirs, { pull_request_id: PR })).toEqual([]);
    expect(await (pendingReview as any)._handler(theirs, { pull_request_id: PR })).toEqual([]);
    expect((await (pendingReview as any)._handler(mine, { pull_request_id: PR })).length).toBe(1);
  });

  test("needs a pull request to hang on", async () => {
    const ctx = context(USER);
    await expect((create as any)._handler(ctx, {
      repository: "codecast-sh/codecast", ref: HEAD, file_path: "src/foo.ts", line_number: 4, content: "x", pending: true,
    })).rejects.toThrow(/needs a pull request/);
  });

  test("discard throws the caller's notes away and nobody else's", async () => {
    const ctx = context(USER, { review_comments: [
      { _id: "a", pull_request_id: PR, author_user_id: USER, pending_review: true, content: "1", created_at: 1, resolved: false },
      { _id: "b", pull_request_id: PR, author_user_id: OTHER, pending_review: true, content: "2", created_at: 2, resolved: false },
    ] });
    expect(await (discardPendingReview as any)._handler(ctx, { pull_request_id: PR })).toEqual({ discarded: 1 });
    expect(ctx.db._deleted).toEqual(["a"]);
  });
});

describe("recording a submitted review", () => {
  test("stamps each note with GitHub's id by path, lines and words, and records the verdict", async () => {
    const ctx = context(USER, { review_comments: [
      { _id: "n1", pull_request_id: PR, author_user_id: USER, pending_review: true, file_path: "src/foo.ts", line_number: 4, content: "rename", created_at: 1, resolved: false },
      { _id: "n2", pull_request_id: PR, author_user_id: USER, pending_review: true, file_path: "src/foo.ts", line_number: 10, line_end: 12, content: "extract", created_at: 2, resolved: false },
    ] });
    const out = await (recordSubmittedReview as any)._handler(ctx, {
      user_id: USER, pull_request_id: PR, github_review_id: 900, review_url: "https://github.com/r/900",
      state: "changes_requested", body: "Two things", commit_sha: HEAD,
      comments: [
        { id: 71, path: "src/foo.ts", line: 12, start_line: 10, body: "extract", html_url: "https://github.com/c/71" },
        { id: 70, path: "src/foo.ts", line: 4, body: "rename", html_url: "https://github.com/c/70" },
      ],
    });
    expect(out).toEqual({ stamped: 2, unmatched: 0 });
    const byId = Object.fromEntries(ctx.db._patched.map((p: any) => [p._id, p.patch]));
    expect(byId.n1).toMatchObject({ github_comment_id: 70, github_review_id: 900, pending_review: undefined });
    expect(byId.n2).toMatchObject({ github_comment_id: 71 });
    const review = ctx.db._inserted.find((i: any) => i.table === "reviews")!.doc;
    expect(review).toMatchObject({ state: "changes_requested", github_review_id: 900, reviewer_user_id: USER, author_github_username: "ashot" });
  });
});

describe("submitting the batch", () => {
  function harness(reviewer: any, notes: any[]) {
    const calls: Array<{ name: string; args: any }> = [];
    const ctx = {
      async runQuery(ref: any, args: any) {
        const name = getFunctionName(ref);
        if (name.includes("callerId")) return USER;
        if (name.includes("reviewerFor")) return reviewer;
        if (name.includes("pendingRowsInternal")) return notes;
        throw new Error("unexpected query " + name);
      },
      async runAction(ref: any, args: any) {
        const name = getFunctionName(ref);
        calls.push({ name, args });
        if (name.includes("submitPRReview")) return { review_id: 900, review_url: "https://github.com/r/900", state: "CHANGES_REQUESTED" };
        if (name.includes("listReviewComments")) return [{ id: 70, path: "src/foo.ts", line: 4, body: "rename" }];
        throw new Error("unexpected action " + name);
      },
      async runMutation(ref: any, args: any) { calls.push({ name: getFunctionName(ref), args }); return { stamped: 1, unmatched: 0 }; },
    } as any;
    return { ctx, calls };
  }
  const reviewer = { github_token: "user_tok", github_username: "ashot", pr: { repository: "codecast-sh/codecast", number: 12, head_sha: HEAD, state: "open" } };
  const note = { _id: "n1", file_path: "src/foo.ts", line_number: 4, content: "rename", side: "RIGHT" };

  test("sends every note inside one review, then stamps the rows", async () => {
    const { ctx, calls } = harness(reviewer, [note]);
    const out = await (submitPending as any)._handler(ctx, { pull_request_id: PR, event: "REQUEST_CHANGES", body: "Two things" });
    expect(out).toMatchObject({ state: "changes_requested", notes: 1, as: "ashot", url: "https://github.com/r/900" });
    const submit = calls.find((c) => c.name.includes("submitPRReview"))!;
    expect(submit.args).toMatchObject({
      event: "REQUEST_CHANGES", body: "Two things", commit_id: HEAD, github_access_token: "user_tok",
      comments: [{ path: "src/foo.ts", body: "rename", line: 4, side: "RIGHT" }],
    });
    expect(calls.map((c) => c.name.split(":").pop())).toEqual(["submitPRReview", "listReviewComments", "recordSubmittedReview"]);
  });

  test("a bare comment with nothing to say is refused before GitHub hears of it", async () => {
    const { ctx, calls } = harness(reviewer, []);
    const out = await (submitPending as any)._handler(ctx, { pull_request_id: PR, event: "COMMENT" });
    expect(out.error).toMatch(/Nothing to submit/);
    expect(calls).toEqual([]);
  });

  test("an approval with no notes skips the comment listing", async () => {
    const { ctx, calls } = harness(reviewer, []);
    const out = await (submitPending as any)._handler(ctx, { pull_request_id: PR, event: "APPROVE" });
    expect(out.state).toBe("approved");
    expect(calls.map((c) => c.name.split(":").pop())).toEqual(["submitPRReview", "recordSubmittedReview"]);
  });

  test("without the reviewer's own token nothing goes out", async () => {
    const { ctx, calls } = harness({ ...reviewer, github_token: null }, [note]);
    const out = await (submitPending as any)._handler(ctx, { pull_request_id: PR, event: "APPROVE" });
    expect(out.error).toMatch(/own GitHub account/);
    expect(calls).toEqual([]);
  });

  test("a pull request with an owning session hears the review once GitHub has it", async () => {
    const { ctx, calls } = harness({ ...reviewer, pr: { ...reviewer.pr, owner_conversation_id: "conv_9" } }, [note]);
    const out = await (submitPending as any)._handler(ctx, { pull_request_id: PR, event: "REQUEST_CHANGES", body: "Two things" });
    expect(calls.map((c) => c.name.split(":").pop())).toEqual([
      "submitPRReview", "listReviewComments", "recordSubmittedReview", "deliverSubmittedReview",
    ]);
    const deliver = calls.find((c) => c.name.includes("deliverSubmittedReview"))!;
    expect(deliver.args).toMatchObject({
      conversation_ref: "conv_9", state: "changes_requested", body: "Two things", note_ids: ["n1"],
      review_url: "https://github.com/r/900",
    });
    expect(out.delivered_to).toBeDefined();
  });

  test("a pull request nobody owns is reviewed on GitHub alone", async () => {
    const { ctx, calls } = harness(reviewer, []);
    const out = await (submitPending as any)._handler(ctx, { pull_request_id: PR, event: "APPROVE" });
    expect(calls.some((c) => c.name.includes("deliverSubmittedReview"))).toBe(false);
    expect(out.delivered_to).toBeNull();
  });
});

describe("delivering a submitted review to the owning session", () => {
  const CONV = "conv_1" as any;
  function seeded(over: Record<string, any[]> = {}) {
    return context(USER, {
      conversations: [{ _id: CONV, user_id: USER, is_private: true, session_id: "sess-1", short_id: "jx7abcd", title: "Shepherd" }],
      pending_messages: [],
      review_comments: [{
        _id: "n1", pull_request_id: PR, repository: "codecast-sh/codecast", file_path: "src/foo.ts", line_number: 4,
        content: "rename this", author_user_id: USER, created_at: 1, github_review_id: 900,
      }],
      ...over,
    });
  }

  test("the verdict, the summary and the notes arrive as one message, and the notes are stamped sent", async () => {
    const ctx = seeded();
    const out = await (deliverSubmittedReview as any)._handler(ctx, {
      user_id: USER, pull_request_id: PR, conversation_ref: CONV, note_ids: ["n1"],
      state: "changes_requested", body: "Two things before this lands", review_url: "https://github.com/r/900",
    });
    expect(out).toMatchObject({ conversation_id: CONV, short_id: "jx7abcd", notes: 1 });
    const queued = ctx.db._tables.pending_messages;
    expect(queued.length).toBe(1);
    expect(queued[0].content).toContain("Ashot requested changes on codecast-sh/codecast#12@abcdef1 with 1 review note.");
    expect(queued[0].content).toContain("Two things before this lands");
    expect(queued[0].content).toContain("File: src/foo.ts");
    expect(queued[0].content).toContain("rename this");
    expect(queued[0].content).toContain("https://github.com/r/900");
    expect(ctx.db._tables.review_comments[0].sent_at).toBeDefined();
  });

  test("the review row is stamped, so the webhook's delayed wake stands down", async () => {
    const ctx = seeded({ reviews: [{ _id: "rev_1", pull_request_id: PR, github_review_id: 900, state: "commented", submitted_at: 1 }] });
    await (deliverSubmittedReview as any)._handler(ctx, {
      user_id: USER, pull_request_id: PR, conversation_ref: CONV, note_ids: ["n1"], github_review_id: 900, state: "commented", body: "hi",
    });
    expect(ctx.db._tables.reviews[0].session_delivered_at).toBeDefined();
  });

  test("an approval with no notes is still a message", async () => {
    const ctx = seeded();
    await (deliverSubmittedReview as any)._handler(ctx, {
      user_id: USER, pull_request_id: PR, conversation_ref: CONV, note_ids: [], state: "approved",
    });
    const queued = ctx.db._tables.pending_messages;
    expect(queued.length).toBe(1);
    expect(queued[0].content).toContain("Ashot approved codecast-sh/codecast#12@abcdef1.");
    expect(queued[0].content).toContain("approves the change");
  });

  test("a session the reviewer cannot send to is reported, not thrown", async () => {
    const ctx = seeded({ conversations: [{ _id: CONV, user_id: OTHER, is_private: true, session_id: "sess-1", title: "Theirs" }] });
    const out = await (deliverSubmittedReview as any)._handler(ctx, {
      user_id: USER, pull_request_id: PR, conversation_ref: CONV, note_ids: ["n1"], state: "commented", body: "hi",
    });
    expect(out.error).toMatch(/No session matches|cannot send/);
    expect(ctx.db._tables.pending_messages.length).toBe(0);
  });
});


describe("nobody else reads a pending note", () => {
  // The CLI verbs take a signed in session too, so the reader is the session here.
  const withToken = (user: string, seed: Record<string, any[]>) => context(user, seed);
  const TOKEN = undefined;
  const rows = [
    { _id: "mine", pull_request_id: PR, repository: "codecast-sh/codecast", author_user_id: USER, pending_review: true, file_path: "src/foo.ts", line_number: 4, content: "secret", created_at: 1, resolved: false },
    { _id: "said", pull_request_id: PR, repository: "codecast-sh/codecast", author_user_id: USER, file_path: "src/foo.ts", line_number: 9, content: "public", created_at: 2, resolved: false },
  ];

  test("the CLI thread list and the selector skip it", async () => {
    const ctx = withToken(OTHER, { review_comments: rows });
    const listed = await (threads as any)._handler(ctx, { api_token: TOKEN, repository: "codecast-sh/codecast", number: 12, all: true });
    expect(listed.threads.map((t: any) => t.content ?? t.preview ?? t.id)).toHaveLength(1);
    const found = await (findComment as any)._handler(ctx, { api_token: TOKEN, repository: "codecast-sh/codecast", number: 12, selector: "src/foo.ts:4" });
    expect(found.comment_id).toBeNull();
  });

  test("the review module's pull request read skips it", async () => {
    const ctx = context(OTHER, { review_comments: rows });
    const out = await (getCommentsForPR as any)._handler(ctx, { pull_request_id: PR });
    expect(out.map((c: any) => c._id)).toEqual(["said"]);
  });
});
