import { describe, expect, test } from "bun:test";
import { answerLocalRead, pendingLocalReads, readRequestStatus, repoAccess, requestLocalRead } from "./repos";
import { makeFakeDb } from "./testDb";

// A read no installation can serve is a request row until a publishing
// checkout answers it. These pin: one row per key, a recent failure reported
// back instead of re-asked, only publishers see and answer requests, and an
// answer lands under the request's own key.

const sha = "d".repeat(40);

function context(user: string | null, overrides: Record<string, any[]> = {}) {
  const scheduled: { ms: number; args: any }[] = [];
  return {
    auth: { getUserIdentity: async () => (user ? { subject: `${user}|sess`, tokenIdentifier: "test" } : null) },
    scheduler: { runAfter: async (ms: number, _fn: unknown, args: any) => { scheduled.push({ ms, args }); } },
    scheduled,
    db: makeFakeDb({
      users: [{ _id: "publisher" }, { _id: "reader" }, { _id: "outsider" }],
      team_memberships: [
        { _id: "m1", user_id: "publisher", team_id: "team" },
        { _id: "m2", user_id: "reader", team_id: "team" },
        { _id: "m3", user_id: "outsider", team_id: "other-team" },
      ],
      repo_sources: [
        { _id: "s", user_id: "publisher", team_id: "team", repository: "acme/demo", root: "/home/p/src/demo", enabled: true, last_synced_at: 1, created_at: 1, updated_at: 1 },
        { _id: "s2", user_id: "outsider", team_id: "other-team", repository: "acme/demo", root: "/home/o/demo", enabled: true, last_synced_at: 1, created_at: 1, updated_at: 1 },
      ],
      repo_read_requests: [],
      repo_cache: [],
      commits: [{ _id: "c1", sha, repository: "acme/demo", team_id: "team", message: "m", author_name: "a", author_email: "e", timestamp: 1, files_changed: 0, insertions: 0, deletions: 0 }],
      ...overrides,
    }),
  };
}

const request = (ctx: any, args: any) => (requestLocalRead as any)._handler(ctx, { team_id: "team", repository: "acme/demo", kind: "blob", ref: "main", path: "src/x.ts", params: { ref: "main", path: "src/x.ts" }, requested_by: "reader", ...args });
const pending = (ctx: any) => (pendingLocalReads as any)._handler(ctx, {});
const answer = (ctx: any, args: any) => (answerLocalRead as any)._handler(ctx, args);
const status = (ctx: any) => (readRequestStatus as any)._handler(ctx, { repository: "acme/demo", kind: "blob", ref: "main", path: "src/x.ts" });
const access = (ctx: any, user: string) => (repoAccess as any)._handler(ctx, { repository: "acme/demo", user_id: user });

describe("requestLocalRead", () => {
  test("opens one row per key, however many pages ask", async () => {
    const ctx = context("reader");
    expect(await request(ctx, {})).toMatchObject({ failed: false });
    expect(await request(ctx, {})).toMatchObject({ failed: false });
    expect(ctx.db._tables.repo_read_requests).toHaveLength(1);
    expect(ctx.db._tables.repo_read_requests[0]).toMatchObject({ status: "pending", repository: "acme/demo", kind: "blob", ref: "main", path: "src/x.ts" });
  });
  test("a recent failure is reported back; an old one is asked again", async () => {
    const ctx = context("reader", { repo_read_requests: [{ _id: "r", team_id: "team", repository: "acme/demo", kind: "blob", ref: "main", path: "src/x.ts", requested_by: "reader", status: "failed", error: "no such path", created_at: 1, updated_at: Date.now() }] });
    expect(await request(ctx, {})).toEqual({ failed: true, error: "no such path" });
    ctx.db._tables.repo_read_requests[0].updated_at = Date.now() - 5 * 60_000;
    expect(await request(ctx, {})).toEqual({ failed: false, request_id: "r" });
    expect(ctx.db._tables.repo_read_requests[0].status).toBe("pending");
  });
  test("the fallback installation rides on the row, and a re-ask forgets earlier declines", async () => {
    const ctx = context("reader");
    const opened = await request(ctx, { fallback_installation_id: 7, fallback_team_id: "team" });
    expect(opened).toEqual({ failed: false, request_id: ctx.db._tables.repo_read_requests[0]._id });
    expect(ctx.db._tables.repo_read_requests[0]).toMatchObject({ fallback_installation_id: 7, fallback_team_id: "team" });
    ctx.db._tables.repo_read_requests[0].declined_by = ["publisher"];
    expect(await request(ctx, {})).toEqual({ failed: false, request_id: opened.request_id });
    expect(ctx.db._tables.repo_read_requests[0].declined_by).toBeUndefined();
  });
});

describe("browse access", () => {
  test("a member of the publishing team reads the checkout first; the installation is the fallback", async () => {
    const ctx = context("reader", {
      github_app_installations: [{ _id: "install", account_login: "acme", team_id: "team", installation_id: 7, repository_selection: "selected", repositories: [{ full_name: "acme/demo" }] }],
    });
    expect(await access(ctx, "reader")).toEqual({ team_id: "team", installation_id: 7, source: "installation", local_team_id: "team" });
    // Without the installation the checkout alone admits the reader.
    expect(await access(context("reader"), "reader")).toEqual({ team_id: "team", source: "local", local_team_id: "team" });
    // A stranger to every publishing team and every installation has no way in.
    expect(await access(context("reader", { team_memberships: [] }), "reader")).toBeNull();
  });
});

describe("pendingLocalReads and answerLocalRead", () => {
  test("only the publisher of the request's team sees it, with the checkout root", async () => {
    const ctx = context("publisher");
    await request(ctx, {});
    const mine = await pending(ctx);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ repository: "acme/demo", root: "/home/p/src/demo", kind: "blob", ref: "main", path: "src/x.ts", params: { ref: "main", path: "src/x.ts" } });
    // The other team's publisher of the same repository does not see a request for this team.
    expect(await pending(context("outsider", { repo_read_requests: ctx.db._tables.repo_read_requests }))).toEqual([]);
    expect(await pending(context(null))).toEqual([]);
  });

  test("an answer lands under the request's key and closes it", async () => {
    const ctx = context("publisher");
    await request(ctx, {});
    const id = ctx.db._tables.repo_read_requests[0]._id;
    const result = await answer(ctx, { request_id: id, row: { kind: "blob", ref: "ignored", path: "ignored", sha: "abc", content: JSON.stringify({ content: "x", size: 1, truncated: false, sha: "abc" }), size: 1 } });
    expect(result).toEqual({ ok: true });
    expect(ctx.db._tables.repo_cache[0]).toMatchObject({ team_id: "team", repository: "acme/demo", kind: "blob", ref: "main", path: "src/x.ts", sha: "abc" });
    expect(ctx.db._tables.repo_read_requests.find((r: any) => r._id === id && r.status !== undefined && !r._deleted)).toBeUndefined();
  });

  test("a failure is recorded with its reason; a stranger may not answer", async () => {
    const ctx = context("publisher");
    await request(ctx, {});
    const id = ctx.db._tables.repo_read_requests[0]._id;
    await answer(ctx, { request_id: id, error: "path does not exist at main" });
    expect(ctx.db._tables.repo_read_requests[0]).toMatchObject({ status: "failed", error: "path does not exist at main", declined_by: ["publisher"] });
    expect(await status(context("reader", { repo_read_requests: ctx.db._tables.repo_read_requests }))).toEqual({ status: "failed", error: "path does not exist at main" });
    // No installation to fall back to: nothing is scheduled.
    expect(ctx.scheduled).toEqual([]);
    await expect(answer(context("outsider", { repo_read_requests: ctx.db._tables.repo_read_requests }), { request_id: id, error: "x" })).rejects.toThrow("Forbidden");
  });

  test("one publisher declining keeps the request open for the others; the last one hands it to GitHub", async () => {
    const second = { _id: "s3", user_id: "reader", team_id: "team", repository: "acme/demo", root: "/home/r/demo", enabled: true, last_synced_at: 1, created_at: 1, updated_at: 1 };
    const ctx = context("publisher", { repo_sources: [
      { _id: "s", user_id: "publisher", team_id: "team", repository: "acme/demo", root: "/home/p/src/demo", enabled: true, last_synced_at: 1, created_at: 1, updated_at: 1 },
      second,
    ] });
    await request(ctx, { fallback_installation_id: 7, fallback_team_id: "team" });
    const id = ctx.db._tables.repo_read_requests[0]._id;
    expect(await answer(ctx, { request_id: id, error: "not in this checkout" })).toEqual({ ok: true, reason: "declined" });
    expect(ctx.db._tables.repo_read_requests[0]).toMatchObject({ status: "pending", declined_by: ["publisher"], error: "not in this checkout" });
    expect(await status(context("reader", { repo_read_requests: ctx.db._tables.repo_read_requests }))).toEqual({ status: "pending", error: "not in this checkout" });
    // The decliner no longer sees it; the other publisher still does.
    expect(await pending(ctx)).toEqual([]);
    const other = context("reader", { repo_sources: ctx.db._tables.repo_sources, repo_read_requests: ctx.db._tables.repo_read_requests });
    expect(await pending(other)).toHaveLength(1);
    expect(await answer(other, { request_id: id, error: "not here either" })).toEqual({ ok: true });
    expect(other.db._tables.repo_read_requests[0]).toMatchObject({ status: "failed", declined_by: ["publisher", "reader"] });
    expect(other.scheduled).toEqual([{ ms: 0, args: { request_id: id } }]);
  });

  test("a commit request writes the diff onto the commit row", async () => {
    const ctx = context("publisher");
    await request(ctx, { kind: "commit", ref: sha, path: "", params: {} });
    const id = ctx.db._tables.repo_read_requests[0]._id;
    const files = [{ filename: "a.ts", status: "modified", additions: 2, deletions: 1, changes: 3, patch: "@@" }];
    expect(await answer(ctx, { request_id: id, commit: { files, additions: 2, deletions: 1 } })).toEqual({ ok: true, reason: undefined });
    expect(ctx.db._tables.commits[0]).toMatchObject({ files, files_changed: 1, insertions: 2, deletions: 1 });
  });
});
