import { describe, expect, test } from "bun:test";
import { backfillDirectoryTeamMappingConversations, repositoryOfCheckout, upsertDirectoryMapping } from "./users";
import { makeFakeDb } from "./testDb";

// A mapping written on one checkout learns which repository that checkout is
// a clone of, from the sessions recorded there, and the retroactive resolve
// visits the owner's sessions in that repository after the two path passes.
const OWNER = "u_owner" as any;
const TEAM = "t_team" as any;
const ROOT = "/Users/d/Desktop/LB-codex/littlebird";
const CLONE2 = "/Users/d/Desktop/LB1/littlebird";
const REPO = "littlebirdai/littlebird";

const run = (fn: any, ctx: any, args: any) => ((fn as any)._handler ?? (fn as any).handler)(ctx, args);
function ctxWith(db: any) {
  const scheduled: any[] = [];
  return { db, scheduler: { runAfter: async (_ms: number, _fn: any, args: any) => { scheduled.push(args); } }, scheduled };
}
const base = (conversations: any[]) =>
  makeFakeDb({
    users: [{ _id: OWNER }],
    teams: [{ _id: TEAM }],
    team_memberships: [{ _id: "m1", user_id: OWNER, team_id: TEAM, role: "member" }],
    directory_team_mappings: [],
    conversations,
  });
const inRoot = { _id: "c_root", user_id: OWNER, project_path: ROOT, git_root: ROOT, git_remote_url: "https://github.com/littlebirdai/littlebird.git", is_private: true, updated_at: 5 };
const inClone2 = { _id: "c_clone2", user_id: OWNER, project_path: CLONE2, git_root: CLONE2, git_remote_url: "git@github.com:littlebirdai/littlebird.git", is_private: true, updated_at: 4 };
const elsewhere = { _id: "c_other", user_id: OWNER, project_path: "/Users/d/src/other", git_root: "/Users/d/src/other", git_remote_url: "https://github.com/o/other.git", is_private: true, updated_at: 3 };

describe("repositoryOfCheckout", () => {
  test("reads the repository off a session recorded under the root", async () => {
    const db = base([inRoot, inClone2]);
    expect(await repositoryOfCheckout({ db }, OWNER, ROOT)).toBe(REPO);
  });
  test("a root with no synced session, or none with a remote, has no repository yet", async () => {
    const db = base([{ ...inRoot, git_remote_url: undefined }]);
    expect(await repositoryOfCheckout({ db }, OWNER, ROOT)).toBeUndefined();
    expect(await repositoryOfCheckout({ db }, OWNER, "/nowhere")).toBeUndefined();
  });
});

describe("upsertDirectoryMapping stamps the repository", () => {
  test("a new mapping carries the checkout's repository and queues the resolve with it", async () => {
    const ctx = ctxWith(base([inRoot, inClone2]));
    const r = await upsertDirectoryMapping(ctx, OWNER, { path_prefix: ROOT, team_id: TEAM });
    expect(r).toMatchObject({ success: true, action: "created" });
    expect(ctx.db._inserted[0].doc.repository).toBe(REPO);
    expect(ctx.scheduled[0]).toMatchObject({ user_id: OWNER, path_prefix: ROOT, repository: REPO, source: "git_root" });
  });

  test("removing a mapping still names the repository so the other clones re-resolve", async () => {
    const db = base([inRoot, inClone2]);
    db._tables.directory_team_mappings.push({ _id: "dm1", user_id: OWNER, path_prefix: ROOT, team_id: TEAM, auto_share: true, repository: REPO, created_at: 1 });
    const ctx = ctxWith(db);
    await upsertDirectoryMapping(ctx, OWNER, { path_prefix: ROOT });
    expect(ctx.db._deleted).toEqual(["dm1"]);
    expect(ctx.scheduled[0]).toMatchObject({ path_prefix: ROOT, repository: REPO });
  });
});

describe("backfill reaches the other clone through the repository pass", () => {
  const mapping = { _id: "dm1", user_id: OWNER, path_prefix: ROOT, team_id: TEAM, auto_share: true, repository: REPO, created_at: 1 };

  test("the path passes hand off to a repository pass, which shares the other clone only", async () => {
    const db = base([inRoot, inClone2, elsewhere]);
    db._tables.directory_team_mappings.push(mapping);
    const ctx = ctxWith(db);
    const afterPath = await run(backfillDirectoryTeamMappingConversations, ctx, { user_id: OWNER, path_prefix: ROOT, repository: REPO, source: "project_path" });
    expect(afterPath.isDone).toBe(false);
    expect(ctx.scheduled.at(-1)).toMatchObject({ source: "repository", repository: REPO });

    const repoPass = await run(backfillDirectoryTeamMappingConversations, ctx, { user_id: OWNER, path_prefix: ROOT, repository: REPO, source: "repository" });
    expect(repoPass.isDone).toBe(true);
    const patched = Object.fromEntries(ctx.db._patched.map((p: any) => [String(p._id), p.patch]));
    expect(patched.c_clone2).toMatchObject({ team_id: TEAM, is_private: false, auto_shared: true });
    expect(patched.c_other).toBeUndefined();
  });

  test("without a repository the path passes finish as before", async () => {
    const db = base([inRoot, inClone2]);
    db._tables.directory_team_mappings.push({ ...mapping, repository: undefined });
    const ctx = ctxWith(db);
    const r = await run(backfillDirectoryTeamMappingConversations, ctx, { user_id: OWNER, path_prefix: ROOT, source: "project_path" });
    expect(r.isDone).toBe(true);
    expect(ctx.scheduled).toHaveLength(0);
  });
});
