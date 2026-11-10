import { describe, expect, spyOn, test } from "bun:test";
import { canBrowse, getBranches, ingestLocal, listRepositories } from "./repos";
import { makeFakeDb } from "./testDb";

// A teammate's checkout, published by their daemon, is the second way into a
// repository: it grants reading the cache to that team and nothing else. These
// tests pin the access rule and the ingest rule (the directory team mapping
// decides who may read, exactly as it decides who sees the sessions).

const sha = "c".repeat(40);

function context(user: string | null, overrides: Record<string, any[]> = {}) {
  return {
    auth: { getUserIdentity: async () => (user ? { subject: `${user}|sess`, tokenIdentifier: "test" } : null) },
    db: makeFakeDb({
      users: [{ _id: "publisher", active_team_id: "team" }, { _id: "reader", active_team_id: "team" }, { _id: "outsider" }],
      team_memberships: [
        { _id: "m1", user_id: "publisher", team_id: "team" },
        { _id: "m2", user_id: "reader", team_id: "team" },
        { _id: "m3", user_id: "outsider", team_id: "other-team" },
      ],
      github_app_installations: [],
      directory_team_mappings: [{ _id: "map", user_id: "publisher", path_prefix: "/home/p/src", team_id: "team", auto_share: true, created_at: 1 }],
      repo_sources: [],
      repo_cache: [],
      commits: [],
      ...overrides,
    }),
  };
}

const rows = [{ kind: "branches", ref: "-", path: "", content: JSON.stringify({ default_branch: "main", truncated: false, branches: [{ name: "main", sha, protected: false }] }) }];

describe("repos.ingestLocal", () => {
  test("identical recent cache payloads do not contend across checkouts", async () => {
    const ctx = context("publisher");
    const args = { root: "/home/p/src/demo", repository: "acme/demo", rows };
    await (ingestLocal as any)._handler(ctx, args);
    const cached = ctx.db._tables.repo_cache[0];
    const patch = spyOn(ctx.db, "patch");
    for (let i = 0; i < 10; i++) await (ingestLocal as any)._handler(ctx, { ...args, root: `/home/p/src/checkout-${i}` });
    expect(patch.mock.calls.filter(([id]) => id === cached._id)).toHaveLength(0);
    patch.mockRestore();
  });

  test("changed cache payloads publish immediately and old identical rows refresh", async () => {
    const ctx = context("publisher");
    const args = { root: "/home/p/src/demo", repository: "acme/demo", rows };
    await (ingestLocal as any)._handler(ctx, args);
    const cached = ctx.db._tables.repo_cache[0];
    const changed = [{ ...rows[0], content: "{}", sha, size: 2, truncated: true }];
    await (ingestLocal as any)._handler(ctx, { ...args, rows: changed });
    expect(await ctx.db.get(cached._id)).toMatchObject(changed[0]);
    await ctx.db.patch(cached._id, { fetched_at: Date.now() - 120_000 });
    await (ingestLocal as any)._handler(ctx, { ...args, rows: changed });
    expect((await ctx.db.get(cached._id)).fetched_at).toBeGreaterThan(Date.now() - 1_000);
  });

  test("a checkout under a shared directory publishes to that team", async () => {
    const ctx = context("publisher");
    const result = await (ingestLocal as any)._handler(ctx, {
      root: "/home/p/src/demo", repository: "Acme/Demo", remote_url: "git@github.com:Acme/Demo.git",
      default_branch: "main", head_sha: sha, rows,
      commits: [{ sha, message: "first", author_name: "P", author_email: "p@x", timestamp: 1, files_changed: 1, insertions: 1, deletions: 0, branch: "main" }],
    });
    expect(result).toMatchObject({ published: true, rows: 1, commits_created: 1 });
    expect(ctx.db._tables.repo_sources[0]).toMatchObject({ user_id: "publisher", team_id: "team", repository: "acme/demo", root: "/home/p/src/demo", enabled: true });
    expect(ctx.db._tables.repo_cache[0]).toMatchObject({ team_id: "team", repository: "acme/demo", kind: "branches", ref: "-", path: "" });
    expect(ctx.db._tables.commits[0]).toMatchObject({ sha, repository: "acme/demo", team_id: "team", branch: "main" });

    // Pushing again refreshes the source row and never duplicates a commit.
    const again = await (ingestLocal as any)._handler(ctx, { root: "/home/p/src/demo", repository: "acme/demo", rows, commits: [{ sha, message: "first", author_name: "P", author_email: "p@x", timestamp: 1, files_changed: 1, insertions: 1, deletions: 0 }] });
    expect(again).toMatchObject({ published: true, commits_created: 0 });
    expect(ctx.db._tables.repo_sources).toHaveLength(1);
    expect(ctx.db._tables.commits).toHaveLength(1);
  });

  test("a mirror commit never links a session, even the publisher's own", async () => {
    // A pull brings teammates' commits into the checkout; an older daemon
    // named its one live session for all of them. A webhook row that found no
    // session must stay unlinked, and a new row must not take the claim.
    const pushed = "d".repeat(40);
    const ctx = context("publisher", {
      conversations: [{ _id: "own-session", user_id: "publisher", team_id: "team" }],
      commits: [{ _id: "webhook-row", sha: pushed, message: "teammate", author_name: "T", author_email: "t@x", timestamp: 2, files_changed: 1, insertions: 1, deletions: 0, repository: "acme/demo", team_id: "team", branch: "main" }],
    });
    const commit = { message: "m", author_name: "T", author_email: "t@x", timestamp: 2, files_changed: 1, insertions: 1, deletions: 0, branch: "main", conversation_id: "own-session" };
    await (ingestLocal as any)._handler(ctx, {
      root: "/home/p/src/demo", repository: "acme/demo", rows,
      commits: [{ ...commit, sha: pushed }, { ...commit, sha }],
    });
    expect(ctx.db._tables.commits.map((c: any) => c.conversation_id)).toEqual([undefined, undefined]);
  });

  test("a checkout outside every shared directory publishes nothing", async () => {
    const ctx = context("publisher");
    const result = await (ingestLocal as any)._handler(ctx, { root: "/home/p/private/demo", repository: "acme/demo", rows });
    expect(result).toEqual({ published: false, reason: "private" });
    expect(ctx.db._tables.repo_sources).toHaveLength(0);
    expect(ctx.db._tables.repo_cache).toHaveLength(0);
  });

  test("a source the person turned off keeps its row and writes nothing", async () => {
    const ctx = context("publisher", { repo_sources: [{ _id: "s", user_id: "publisher", team_id: "team", repository: "acme/demo", root: "/home/p/src/demo", enabled: false, last_synced_at: 1, created_at: 1, updated_at: 1 }] });
    const result = await (ingestLocal as any)._handler(ctx, { root: "/home/p/src/demo", repository: "acme/demo", rows });
    expect(result).toEqual({ published: false, reason: "disabled" });
    expect(ctx.db._tables.repo_cache).toHaveLength(0);
  });

  test("a kind the daemon cannot honestly produce is dropped", async () => {
    const ctx = context("publisher");
    await (ingestLocal as any)._handler(ctx, { root: "/home/p/src/demo", repository: "acme/demo", rows: [{ kind: "pulls", ref: "open", path: "#1", content: "{}" }] });
    expect(ctx.db._tables.repo_cache).toHaveLength(0);
  });

  test("no viewer is refused", async () => {
    await expect((ingestLocal as any)._handler(context(null), { root: "/home/p/src/demo", repository: "acme/demo", rows })).rejects.toThrow("Not authenticated");
  });
});

describe("browsing through a published checkout", () => {
  const published = {
    repo_sources: [{ _id: "s", user_id: "publisher", team_id: "team", repository: "acme/demo", root: "/home/p/src/demo", enabled: true, last_synced_at: 1, created_at: 1, updated_at: 1 }],
    repo_cache: [{ _id: "b", team_id: "team", repository: "acme/demo", kind: "branches", ref: "-", path: "", content: rows[0].content, fetched_at: Date.now(), local_workspace: "team:team" }],
  };

  test("a teammate may browse and reads the pushed rows with no installation at all", async () => {
    const ctx = context("reader", published);
    expect(await (canBrowse as any)._handler(ctx, { repository: "acme/demo" })).toBe(true);
    const branches = await (getBranches as any)._handler(ctx, { repository: "acme/demo" });
    expect(branches.branches[0].name).toBe("main");
    expect((await (listRepositories as any)._handler(ctx, {})).map((r: any) => r.repository)).toEqual(["acme/demo"]);
  });

  test("someone outside the team may not, and a disabled source grants nothing", async () => {
    expect(await (canBrowse as any)._handler(context("outsider", published), { repository: "acme/demo" })).toBe(false);
    expect(await (getBranches as any)._handler(context("outsider", published), { repository: "acme/demo" })).toBeNull();
    const off = { ...published, repo_sources: [{ ...published.repo_sources[0], enabled: false }] };
    expect(await (canBrowse as any)._handler(context("reader", off), { repository: "acme/demo" })).toBe(false);
    expect(await (listRepositories as any)._handler(context("reader", off), {})).toEqual([]);
  });
});

// The repository name on a checkout's rows is the publisher's own claim, so a
// row is read and replaced only inside the workspace it was published to.
describe("a checkout's rows stay in the workspace that published them", () => {
  const theirs = JSON.stringify({ default_branch: "main", truncated: false, branches: [{ name: "secret-branch", sha, protected: false }] });
  const victim = {
    repo_sources: [{ _id: "s", user_id: "publisher", team_id: "team", repository: "acme/demo", root: "/home/p/src/demo", enabled: true, last_synced_at: 1, created_at: 1, updated_at: 1 }],
    repo_cache: [{ _id: "b", team_id: "team", repository: "acme/demo", kind: "branches", ref: "-", path: "", content: theirs, fetched_at: Date.now(), local_workspace: "team:team" }],
    directory_team_mappings: [
      { _id: "map", user_id: "publisher", path_prefix: "/home/p/src", team_id: "team", auto_share: true, created_at: 1 },
      { _id: "map2", user_id: "outsider", path_prefix: "/home/o", team_id: "other-team", auto_share: true, created_at: 1 },
    ],
  };

  test("naming another team's repository from your own checkout neither reads nor overwrites their rows", async () => {
    const ctx = context("outsider", victim);
    const out = await (ingestLocal as any)._handler(ctx, { root: "/home/o/fake", repository: "acme/demo", rows });
    expect(out).toMatchObject({ published: true });
    // The other team's row is untouched; the outsider's publish is a second row in its own workspace.
    expect((await ctx.db.get("b")).content).toBe(theirs);
    const mine = ctx.db._tables.repo_cache.filter((r: any) => r.local_workspace === "team:other-team");
    expect(mine).toHaveLength(1);
    // The outsider now reads what the outsider published, never the other team's row.
    const branches = await (getBranches as any)._handler(ctx, { repository: "acme/demo" });
    expect(branches.branches.map((b: any) => b.name)).toEqual(["main"]);
    // And the publishing team still reads its own.
    const reader = { ...context("reader"), db: ctx.db };
    expect((await (getBranches as any)._handler(reader, { repository: "acme/demo" })).branches[0].name).toBe("secret-branch");
  });

  test("a row from before the stamp, or one GitHub fetched, is not readable through a checkout alone", async () => {
    const legacy = { ...victim, repo_cache: [{ ...victim.repo_cache[0], local_workspace: undefined }] };
    expect(await (getBranches as any)._handler(context("reader", legacy), { repository: "acme/demo" })).toBeNull();
    // With the team's installation covering the repository it is.
    const installed = { ...legacy, github_app_installations: [{ _id: "i", team_id: "team", installation_id: 1, account_login: "acme", account_type: "Organization", repository_selection: "all" }] };
    expect((await (getBranches as any)._handler(context("reader", installed), { repository: "acme/demo" })).branches[0].name).toBe("secret-branch");
  });

  test("a commit of the same sha in another repository is not patched by a checkout's publish", async () => {
    const ctx = context("publisher", { commits: [{ _id: "c_other", sha, repository: "elsewhere/fork", team_id: "other-team", message: "m", author_name: "a", author_email: "e", timestamp: 1, files_changed: 0, insertions: 0, deletions: 0 }] });
    const out = await (ingestLocal as any)._handler(ctx, {
      root: "/home/p/src/demo", repository: "acme/demo", rows: [],
      commits: [{ sha, message: "first", author_name: "P", author_email: "p@x", timestamp: 1, files_changed: 1, insertions: 1, deletions: 0, branch: "main", files: [{ filename: "a.ts", additions: 1, deletions: 0 }] }],
    });
    expect(out.commits_created).toBe(1);
    expect((await ctx.db.get("c_other")).files).toBeUndefined();
    expect(ctx.db._tables.commits.find((c: any) => c.repository === "acme/demo")).toMatchObject({ team_id: "team" });
  });
});
