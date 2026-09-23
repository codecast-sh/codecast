import { describe, expect, test } from "bun:test";
import { mappingCoversStart, resolveTeamForPath } from "./privacy";
import { backfillDirectoryTeamMappingConversations, listConversationsForPathInternal, summarizeConversationsForPath, upsertDirectoryMapping } from "./users";
import { makeFakeDb } from "./testDb";
import { repositoryKeyOfRemote } from "@codecast/shared/contracts";

// A repo share has a start. Two users shared whole repos to their team by
// clicking through a setup step that pre checked repos and shared every past
// session in them (2026-09-23). A mapping now carries `share_since`: sessions
// started before it stay private, and a share made today never exposes
// yesterday unless the member includes the past on purpose.

const OWNER = "u_owner" as any;
const TEAM = "t_team" as any;
const T = 1_000_000;
const mapping = { team_id: TEAM, path_prefix: "/repo", auto_share: true, share_since: T };

describe("mappingCoversStart", () => {
  test("no share start covers everything", () => {
    expect(mappingCoversStart({}, 1)).toBe(true);
  });
  test("a session being created now is covered", () => {
    expect(mappingCoversStart({ share_since: T }, undefined)).toBe(true);
  });
  test("a session started before the share start is not covered", () => {
    expect(mappingCoversStart({ share_since: T }, T - 1)).toBe(false);
    expect(mappingCoversStart({ share_since: T }, T)).toBe(true);
  });
});

describe("resolveTeamForPath honors the share start", () => {
  test("an older session is routed to the team but stays private", () => {
    const r = resolveTeamForPath([mapping], "/repo/sub", undefined, T - 1);
    expect(r).toEqual({ teamId: TEAM, isPrivate: true, autoShared: false });
  });
  test("a newer session is shared", () => {
    const r = resolveTeamForPath([mapping], "/repo/sub", undefined, T + 1);
    expect(r).toEqual({ teamId: TEAM, isPrivate: false, autoShared: true });
  });
  test("creation without a start time is shared", () => {
    expect(resolveTeamForPath([mapping], "/repo", undefined).isPrivate).toBe(false);
  });
});

const run = (fn: any, ctx: any, args: any) => ((fn as any)._handler ?? (fn as any).handler)(ctx, args);

function ctxWith(db: any) {
  const scheduled: any[] = [];
  return { db, scheduler: { runAfter: async (_ms: number, _fn: any, args: any) => { scheduled.push(args); } }, scheduled };
}

describe("upsertDirectoryMapping stamps the share start", () => {
  const base = () =>
    makeFakeDb({
      users: [{ _id: OWNER }],
      teams: [{ _id: TEAM }],
      team_memberships: [{ _id: "m1", user_id: OWNER, team_id: TEAM, role: "member" }],
      directory_team_mappings: [],
      conversations: [],
    });

  test("a new mapping shares everything unless the past is excluded", async () => {
    const db = base();
    const ctx = ctxWith(db);
    const all = await upsertDirectoryMapping(ctx, OWNER, { path_prefix: "/a", team_id: TEAM });
    expect(all).toMatchObject({ action: "created", share_since: null });
    const before = Date.now();
    const fwd = await upsertDirectoryMapping(ctx, OWNER, { path_prefix: "/b", team_id: TEAM, include_past: false });
    expect(fwd).toMatchObject({ action: "created" });
    expect((fwd as any).share_since).toBeGreaterThanOrEqual(before);
    const rows = db._tables.directory_team_mappings;
    expect(rows.find((r: any) => r.path_prefix === "/a").share_since).toBeUndefined();
    expect(rows.find((r: any) => r.path_prefix === "/b").share_since).toBeGreaterThanOrEqual(before);
    // Every write re-resolves the directory's sessions.
    expect(ctx.scheduled.map((s) => s.path_prefix)).toEqual(["/a", "/b"]);
  });

  test("retargeting keeps the start; including the past clears it", async () => {
    const db = base();
    const ctx = ctxWith(db);
    await upsertDirectoryMapping(ctx, OWNER, { path_prefix: "/a", team_id: TEAM, include_past: false });
    const stamped = db._tables.directory_team_mappings[0].share_since;
    await upsertDirectoryMapping(ctx, OWNER, { path_prefix: "/a", team_id: TEAM });
    expect(db._tables.directory_team_mappings[0].share_since).toBe(stamped);
    await upsertDirectoryMapping(ctx, OWNER, { path_prefix: "/a", team_id: TEAM, include_past: true });
    expect(db._tables.directory_team_mappings[0].share_since).toBeUndefined();
  });

  test("an explicit share start wins over include_past", async () => {
    const db = base();
    const ctx = ctxWith(db);
    await upsertDirectoryMapping(ctx, OWNER, { path_prefix: "/a", team_id: TEAM, include_past: true, share_since: T });
    expect(db._tables.directory_team_mappings[0].share_since).toBe(T);
  });

  test("a non member cannot map", async () => {
    const db = base();
    const r = await upsertDirectoryMapping(ctxWith(db), OWNER, { path_prefix: "/a", team_id: "t_other" as any });
    expect(r).toEqual({ error: "Not a member of this team" });
  });
});

describe("the backfill leaves sessions before the share start private", () => {
  test("only sessions started at or after the start become shared", async () => {
    const db = makeFakeDb({
      users: [{ _id: OWNER }],
      teams: [{ _id: TEAM }],
      team_memberships: [{ _id: "m1", user_id: OWNER, team_id: TEAM, role: "member", visibility: "full" }],
      directory_team_mappings: [{ _id: "dm1", user_id: OWNER, ...mapping }],
      conversations: [
        { _id: "c_old", user_id: OWNER, git_root: "/repo", started_at: T - 10, is_private: true },
        { _id: "c_new", user_id: OWNER, git_root: "/repo", started_at: T + 10, is_private: true },
        // The owner hid this one by hand: a share start never re-opens it.
        { _id: "c_locked", user_id: OWNER, git_root: "/repo", started_at: T + 10, is_private: true, team_visibility: "private" },
        // The owner shared this old one by hand: the start never closes it.
        { _id: "c_manual", user_id: OWNER, git_root: "/repo", started_at: T - 10, is_private: false, team_id: TEAM },
      ],
      tasks: [], docs: [], plans: [], projects: [],
    });
    const ctx = ctxWith(db);
    await run(backfillDirectoryTeamMappingConversations, ctx, { user_id: OWNER, path_prefix: "/repo", source: "git_root" });
    const row = (id: string) => db._tables.conversations.find((c: any) => c._id === id);
    expect(row("c_old")).toMatchObject({ is_private: true, team_id: TEAM });
    expect(row("c_old").auto_shared).toBeFalsy();
    expect(row("c_new")).toMatchObject({ is_private: false, auto_shared: true, team_id: TEAM });
    expect(row("c_locked")).toMatchObject({ is_private: true, team_visibility: "private" });
    expect(row("c_manual")).toMatchObject({ is_private: false, team_id: TEAM });
  });
});


// The scan behind every preview: counts, the span, and what a share start or
// the owner's own choices keep private. The path scan test harness is the
// hand rolled fake in users.pathScan.test.ts; makeFakeDb ignores range ops,
// which for one owner and one root is the same set of rows.
describe("summarizeConversationsForPath and listConversationsForPath", () => {
  const db = () =>
    makeFakeDb({
      users: [{ _id: OWNER }],
      conversations: [
        { _id: "c1", user_id: OWNER, git_root: "/repo", started_at: T - 10, updated_at: T - 5, title: "old", is_private: true, message_count: 3 },
        { _id: "c2", user_id: OWNER, git_root: "/repo", started_at: T + 10, updated_at: T + 20, title: "new", is_private: true },
        { _id: "c3", user_id: OWNER, git_root: "/repo", started_at: T + 30, updated_at: T + 30, title: "hid", is_private: true, team_visibility: "private" },
        { _id: "c4", user_id: OWNER, git_root: "/repo", started_at: T - 20, updated_at: T, title: "manual", is_private: false, team_id: TEAM },
        { _id: "c5", user_id: OWNER, git_root: "/repo", started_at: NaN, updated_at: T, title: "nan", is_private: true },
      ],
    });

  test("the summary counts older, hidden and manual rows and ignores a NaN stamp", async () => {
    const s = await summarizeConversationsForPath({ db: db() }, OWNER, "/repo", T);
    expect(s).toMatchObject({ count: 5, first_started_at: T - 20, last_started_at: T + 30, older: 2, hidden: 1, manually_shared: 1, truncated: false });
    const all = await summarizeConversationsForPath({ db: db() }, OWNER, "/repo");
    expect(all.older).toBe(0);
  });

  test("the list is newest first, capped, with the fields the review needs", async () => {
    const r = await listConversationsForPathInternal({ db: db() }, OWNER, "/repo", 3);
    expect(r.total).toBe(5);
    expect(r.rows.map((x) => x._id)).toEqual(["c3", "c2", "c1"]);
    expect(r.rows[0]).toMatchObject({ title: "hid", is_private: true, team_visibility: "private", auto_shared: false });
    expect(r.rows[2]).toMatchObject({ title: "old", is_private: true, message_count: 3 });
  });
});


// One rule per repository. A share addresses the repository the checkout is
// a clone of, so a write lands on whichever checkout already carries the rule
// and a removal takes every rule of that repository with it. Two rules for
// one repository was the state that let a team switch leave the old team
// sharing through the other checkout.
describe("upsertDirectoryMapping addresses the repository, not the checkout", () => {
  const REMOTE = "git@github.com:acme/app.git";
  const KEY = repositoryKeyOfRemote(REMOTE)!;
  const TEAM_B = "t_b" as any;
  const base = () =>
    makeFakeDb({
      users: [{ _id: OWNER }],
      teams: [{ _id: TEAM }, { _id: TEAM_B }],
      team_memberships: [
        { _id: "m1", user_id: OWNER, team_id: TEAM, role: "member" },
        { _id: "m2", user_id: OWNER, team_id: TEAM_B, role: "member" },
      ],
      directory_team_mappings: [
        { _id: "dm_a", user_id: OWNER, path_prefix: "/a", team_id: TEAM, auto_share: true, repository: KEY, share_since: T },
        { _id: "dm_c", user_id: OWNER, path_prefix: "/c", team_id: TEAM, auto_share: true, repository: KEY },
      ],
      conversations: [
        { _id: "c_b1", user_id: OWNER, git_root: "/b", git_remote_url: REMOTE, started_at: T, is_private: true },
        { _id: "c_keep", user_id: OWNER, git_root: "/b", git_remote_url: REMOTE, started_at: T + 5, is_private: true },
      ],
      tasks: [], docs: [], plans: [], projects: [],
    });

  test("a switch from another checkout patches the repository's rule and drops duplicates", async () => {
    const db = base();
    const ctx = ctxWith(db);
    const r = await upsertDirectoryMapping(ctx, OWNER, { path_prefix: "/b", team_id: TEAM_B });
    expect(r).toMatchObject({ action: "updated" });
    const rules = db._tables.directory_team_mappings;
    expect(rules.map((m: any) => m.path_prefix)).toEqual(["/a"]);
    expect(rules[0]).toMatchObject({ team_id: TEAM_B, share_since: T, repository: KEY });
    // The duplicate's sessions and the rule's own re-resolve.
    expect(ctx.scheduled.map((s) => s.path_prefix).sort()).toEqual(["/a", "/c"]);
  });

  test("removal from any checkout takes every rule of the repository", async () => {
    const db = base();
    const ctx = ctxWith(db);
    await upsertDirectoryMapping(ctx, OWNER, { path_prefix: "/b" });
    expect(db._tables.directory_team_mappings).toEqual([]);
    expect(ctx.scheduled.map((s) => s.path_prefix).sort()).toEqual(["/a", "/c"]);
  });

  test("kept sessions lock before the backfill is queued", async () => {
    const db = base();
    const ctx = ctxWith(db);
    await upsertDirectoryMapping(ctx, OWNER, { path_prefix: "/b", team_id: TEAM, lock_private: ["c_keep" as any] });
    const kept = db._tables.conversations.find((c: any) => c._id === "c_keep");
    expect(kept).toMatchObject({ is_private: true, team_visibility: "private" });
    const other = db._tables.conversations.find((c: any) => c._id === "c_b1");
    expect(other.team_visibility).toBeUndefined();
  });
});
