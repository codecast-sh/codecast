import { describe, expect, test } from "bun:test";
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
    repo_cache: [{ _id: "b", team_id: "team", repository: "acme/demo", kind: "branches", ref: "-", path: "", content: rows[0].content, fetched_at: Date.now() }],
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
