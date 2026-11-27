import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { REPO_ICON_RETRY_MS, forWorkspace, performRequestRepoIcon, repoIconBrief, saveRepoIcon } from "./repoIcons";
import { ROLE_ICON_EXAMPLES } from "@codecast/shared/contracts/roleIconExamples";
import { pickRoleIconAccent } from "@codecast/shared/contracts/roleIcon";

// A repository's drawn face (repoIcons.ts): asked for by a face that paints
// without one, drawn once per workspace and repository. Synthetic data only.

const wrench = ROLE_ICON_EXAMPLES.find((e) => e.icon.concept === "wrench")!.icon;
const ME = "users_me" as any;
const TEAM = "teams_t";

function setup(repo_icons: any[] = []) {
  const db = makeFakeDb({
    users: [{ _id: ME, name: "Ana" }, { _id: "users_x", name: "Xu" }],
    team_memberships: [{ _id: "m1", user_id: ME, team_id: TEAM, role: "member" }],
    teams: [{ _id: TEAM, name: "Acme" }],
    // What each workspace works on: a checkout, a deploy, a run on a pull request.
    checkouts: [{ _id: "checkouts_1", workspace: `user:${ME}`, repository: "acme/app" }],
    deploys: [{ _id: "deploys_1", workspace: `team:${TEAM}`, repository: "acme/app", created_at: 1 }, { _id: "deploys_2", workspace: "team:teams_other", repository: "acme/theirs", created_at: 1 }],
    workflow_runs: [{ _id: "workflow_runs_1", workspace: `user:${ME}`, pr: { repository: "acme/pr-only", number: 7, first_head_sha: "a", head_sha: "a", at: 1 } }],
    repo_icons,
  });
  const scheduled: any[] = [];
  const ctx = { db, scheduler: { runAfter: async (_ms: number, _fn: any, args: any) => { scheduled.push(args); } } } as any;
  return { db, scheduled, ctx };
}

describe("performRequestRepoIcon", () => {
  test("creates the row under its lowercased name, schedules one drawing, then holds off until the retry window passes", async () => {
    const { db, scheduled, ctx } = setup();
    expect(await performRequestRepoIcon(ctx, ME, `user:${ME}`, "Acme/App", 1_000)).toBe(true);
    const rows = await db.query("repo_icons").collect();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ workspace: `user:${ME}`, repository: "acme/app", requested_at: 1_000 });
    expect(scheduled).toEqual([{ id: rows[0]._id }]);
    expect(await performRequestRepoIcon(ctx, ME, `user:${ME}`, "acme/app", 2_000)).toBe(false);
    expect(await performRequestRepoIcon(ctx, ME, `user:${ME}`, "acme/app", 1_000 + REPO_ICON_RETRY_MS)).toBe(true);
    expect(await db.query("repo_icons").collect()).toHaveLength(1);
    expect((await db.get(rows[0]._id)).requested_at).toBe(1_000 + REPO_ICON_RETRY_MS);
    expect(scheduled).toHaveLength(2);
  });

  test("a team member may ask in the team's workspace", async () => {
    const { scheduled, ctx } = setup();
    expect(await performRequestRepoIcon(ctx, ME, `team:${TEAM}`, "acme/app")).toBe(true);
    expect(scheduled).toHaveLength(1);
  });

  test("refuses a workspace the caller does not hold, and writes nothing", async () => {
    const { db, scheduled, ctx } = setup();
    expect(await performRequestRepoIcon(ctx, "users_x" as any, `user:${ME}`, "acme/app")).toBe(false);
    expect(await performRequestRepoIcon(ctx, "users_x" as any, `team:${TEAM}`, "acme/app")).toBe(false);
    expect(await performRequestRepoIcon(ctx, ME, "team:teams_other", "acme/app")).toBe(false);
    expect(await db.query("repo_icons").collect()).toEqual([]);
    expect(scheduled).toEqual([]);
  });

  test("asks only for a repository the workspace already has: a checkout, a deploy, or a run on one of its pull requests", async () => {
    const { db, scheduled, ctx } = setup();
    expect(await performRequestRepoIcon(ctx, ME, `user:${ME}`, "acme/pr-only")).toBe(true);
    expect(await performRequestRepoIcon(ctx, ME, `team:${TEAM}`, "acme/app")).toBe(true);
    // Another workspace's deploy, a run in another workspace, and a name nobody works on: no row, no drawing.
    expect(await performRequestRepoIcon(ctx, ME, `user:${ME}`, "acme/theirs")).toBe(false);
    expect(await performRequestRepoIcon(ctx, ME, `team:${TEAM}`, "acme/pr-only")).toBe(false);
    expect(await performRequestRepoIcon(ctx, ME, `user:${ME}`, "someone/anything")).toBe(false);
    expect((await db.query("repo_icons").collect()).map((r: any) => `${r.workspace} ${r.repository}`).sort()).toEqual([`team:${TEAM} acme/app`, `user:${ME} acme/pr-only`]);
    expect(scheduled).toHaveLength(2);
  });

  test("settles the color at the first ask, the one the workspace's other faces use least, and keeps it on a retry", async () => {
    const taken = { ...wrench, accent: pickRoleIconAccent([], "acme/app") };
    const { db, ctx } = setup([{ _id: "repo_icons_0", workspace: `user:${ME}`, repository: "acme/pr-only", icon: taken }]);
    expect(await performRequestRepoIcon(ctx, ME, `user:${ME}`, "acme/app", 1_000)).toBe(true);
    const row = (await db.query("repo_icons").collect()).find((r: any) => r.repository === "acme/app");
    expect(row.accent).toBe(pickRoleIconAccent([taken.accent], "acme/app"));
    expect(row.accent).not.toBe(taken.accent);
    expect(await performRequestRepoIcon(ctx, ME, `user:${ME}`, "acme/app", 1_000 + REPO_ICON_RETRY_MS)).toBe(true);
    expect((await db.get(row._id)).accent).toBe(row.accent);
  });

  test("does nothing for a repository already drawn, or a name that is not owner/name", async () => {
    const { scheduled, ctx } = setup([{ _id: "repo_icons_1", workspace: `user:${ME}`, repository: "acme/app", icon: wrench }]);
    expect(await performRequestRepoIcon(ctx, ME, `user:${ME}`, "acme/app")).toBe(false);
    expect(await performRequestRepoIcon(ctx, ME, `user:${ME}`, "not a repo")).toBe(false);
    expect(scheduled).toEqual([]);
  });
});

describe("saveRepoIcon", () => {
  test("writes a valid drawing once, and never an invalid one or over an existing one", async () => {
    const { db } = setup([{ _id: "repo_icons_1", workspace: `user:${ME}`, repository: "acme/app", requested_at: 1 }]);
    const save = (icon: any) => (saveRepoIcon as any)._handler({ db }, { id: "repo_icons_1", icon });
    await save({ ...wrench, shapes: [] });
    await save({ v: 2, concept: "x" });
    expect((await db.get("repo_icons_1")).icon).toBeUndefined();
    await save(wrench);
    expect((await db.get("repo_icons_1")).icon).toEqual(wrench);
    const other = ROLE_ICON_EXAMPLES.find((e) => e.icon.concept !== "wrench")!.icon;
    await save(other);
    expect((await db.get("repo_icons_1")).icon).toEqual(wrench);
  });

  test("the drawing wears the color the row settled at its first ask", async () => {
    const accent = wrench.accent === "violet" ? "cyan" : "violet";
    const { db } = setup([{ _id: "repo_icons_1", workspace: `user:${ME}`, repository: "acme/app", accent, requested_at: 1 }]);
    await (saveRepoIcon as any)._handler({ db }, { id: "repo_icons_1", icon: wrench });
    expect((await db.get("repo_icons_1")).icon).toEqual({ ...wrench, accent });
    expect((await (repoIconBrief as any)._handler({ db }, { id: "repo_icons_1" }))).toBeNull();
  });
});

describe("repoIconBrief", () => {
  test("draws from the name after the owner, clear of the workspace's other faces, in the accent they use least", async () => {
    const { db } = setup([
      { _id: "repo_icons_1", workspace: `user:${ME}`, repository: "acme/web-app" },
      { _id: "repo_icons_2", workspace: `user:${ME}`, repository: "acme/api", icon: wrench },
      { _id: "repo_icons_3", workspace: `team:${TEAM}`, repository: "acme/other", icon: wrench },
    ]);
    const brief = await (repoIconBrief as any)._handler({ db }, { id: "repo_icons_1" });
    expect(brief).toMatchObject({ workspace: `user:${ME}`, title: "web-app", charter: "A software project named web-app." });
    expect(brief.siblings).toEqual([{ title: "api", icon: wrench }]);
    expect(brief.accent).not.toBe(wrench.accent);
    expect(await (repoIconBrief as any)._handler({ db }, { id: "repo_icons_2" })).toBeNull();
  });

  test("a row whose color is settled is drawn in that color", async () => {
    const { db } = setup([{ _id: "repo_icons_1", workspace: `user:${ME}`, repository: "acme/web-app", accent: "orange" }]);
    expect((await (repoIconBrief as any)._handler({ db }, { id: "repo_icons_1" })).accent).toBe("orange");
  });
});

describe("forWorkspace", () => {
  test("answers a workspace's faces to whoever holds it, and nothing to anyone else", async () => {
    const { db } = setup([
      { _id: "repo_icons_1", workspace: `user:${ME}`, repository: "acme/app", icon: wrench },
      { _id: "repo_icons_2", workspace: `user:${ME}`, repository: "acme/api", accent: "orange", requested_at: 1 },
    ]);
    const as = (userId: string | null) => ({ db, auth: { getUserIdentity: async () => (userId ? { subject: userId } : null) } }) as any;
    const mine = await (forWorkspace as any)._handler(as(ME), { workspace: `user:${ME}` });
    expect(mine).toEqual([
      { _id: "repo_icons_1", workspace: `user:${ME}`, repository: "acme/app", accent: wrench.accent, icon: wrench },
      { _id: "repo_icons_2", workspace: `user:${ME}`, repository: "acme/api", accent: "orange", icon: null },
    ]);
    expect(await (forWorkspace as any)._handler(as("users_x"), { workspace: `user:${ME}` })).toEqual([]);
    expect(await (forWorkspace as any)._handler(as(null), { workspace: `user:${ME}` })).toEqual([]);
  });
});
