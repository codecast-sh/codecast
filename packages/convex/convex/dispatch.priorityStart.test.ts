// A session started from a milestone's Start (dispatch createSession,
// dispatchHelpers startWorkspace): a folder or project the person mapped to a
// team wins; only where nothing names a team does the priority's workspace
// route the session; and a Start never widens who reads a session. Where the
// session lands outside the priority's workspace, the link is refused.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { allModules } from "./testModules.testkit";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

setDefaultTimeout(60_000);

const NOW = Date.now();
const step = (key: string) => ({ key, title: `Milestone ${key}`, tier: "critical" as const, tier_set_by: "pass" as const, refs: [], done: false });

/**
 * Ada is in Codecast and Union; her Union folder auto-shares to Union, her
 * Codecast folder to Codecast, and /work/secret is locked private. She
 * owns pri-1 in Codecast and pri-3 in her personal workspace; Bea owns pri-2
 * in Codecast, which Ada reads through a session of it shared with the team.
 */
async function world() {
  const t = convexTest(schema, allModules);
  const ids = await t.run(async (ctx) => {
    const ada = await ctx.db.insert("users", { name: "Ada" } as any);
    const bea = await ctx.db.insert("users", { name: "Bea" } as any);
    const codecast = await ctx.db.insert("teams", { name: "Codecast", created_at: NOW, features: { priorities: true } } as any);
    const union = await ctx.db.insert("teams", { name: "Union", created_at: NOW, features: { priorities: true } } as any);
    for (const [u, team] of [[ada, codecast], [ada, union], [bea, codecast]] as const) {
      await ctx.db.insert("team_memberships", { user_id: u, team_id: team, role: "member", joined_at: 1 } as any);
    }
    await ctx.db.patch(ada, { active_team_id: union } as any);
    await ctx.db.insert("directory_team_mappings", { user_id: ada, path_prefix: "/work/union", team_id: union, auto_share: true, created_at: 1 } as any);
    await ctx.db.insert("directory_team_mappings", { user_id: ada, path_prefix: "/work/codecast", team_id: codecast, auto_share: true, created_at: 1 } as any);
    await ctx.db.insert("directory_team_mappings", { user_id: ada, path_prefix: "/work/secret", auto_share: false, private: true, created_at: 1 } as any);
    const priority = (user_id: Id<"users">, workspace: string, short_id: string) => ctx.db.insert("priorities", {
      user_id, workspace, short_id, title: short_id, summary: "", status: "active", ai_rank: 1, steps: [step("s1")],
      first_seen_at: NOW, last_active_at: NOW, pass_at: NOW, created_at: NOW, updated_at: NOW,
    } as any);
    const p1 = await priority(ada, `team:${codecast}`, "pri-1");
    const p2 = await priority(bea, `team:${codecast}`, "pri-2");
    const p3 = await priority(ada, `user:${ada}`, "pri-3");
    await ctx.db.insert("conversations", {
      user_id: bea, team_id: codecast, agent_type: "claude_code", session_id: "bea-shared", short_id: "jx7bea1", title: "Bea's",
      started_at: NOW, updated_at: NOW, message_count: 1, is_private: false, team_visibility: "full", status: "active", priority_id: p2,
    } as any);
    return { ada, codecast, union, p1, p2, p3 };
  });
  return { t, ...ids };
}

const start = async (t: any, ada: Id<"users">, session_id: string, opts: Record<string, unknown>) => {
  await t.withIdentity({ subject: `${ada}|session` }).mutation(api.dispatch.dispatch, {
    action: "createSession",
    args: [{ agent_type: "claude_code", session_id, project_path: "/work/union/app", git_root: "/work/union/app", priority_step: "s1", ...opts }],
  });
  return t.run((ctx: any) => ctx.db.query("conversations").withIndex("by_session_id", (q: any) => q.eq("session_id", session_id)).first());
};

const UNMAPPED = { project_path: "/tmp/scratch", git_root: "/tmp/scratch" };
const CODECAST_FOLDER = { project_path: "/work/codecast/app", git_root: "/work/codecast/app" };

describe("Start from a milestone outside the active workspace", () => {
  test("a folder mapped to another team wins: Union active, a Union folder's Start on a Codecast priority stays in Union, unlinked", async () => {
    const { t, ada, union } = await world();
    const conv = await start(t, ada, "stub-1", { priority: "pri-1" });
    expect(String(conv.team_id)).toBe(String(union));
    expect(conv.priority_id).toBeUndefined();
  });

  test("a folder mapped to the priority's team links, the viewer's priority or a teammate's", async () => {
    const { t, ada, codecast, p1, p2 } = await world();
    const own = await start(t, ada, "stub-2", { priority: "pri-1", ...CODECAST_FOLDER });
    expect([String(own.team_id), String(own.priority_id), own.priority_step_key]).toEqual([String(codecast), String(p1), "s1"]);
    const theirs = await start(t, ada, "stub-3", { priority: "pri-2", ...CODECAST_FOLDER });
    expect([String(theirs.team_id), String(theirs.priority_id)]).toEqual([String(codecast), String(p2)]);
  });

  test("an unmapped folder goes to the priority's team; shared at the level the person picks, it links", async () => {
    const { t, ada, codecast, p1 } = await world();
    const conv = await start(t, ada, "stub-4", { priority: "pri-1", team_visibility: "summary", ...UNMAPPED });
    expect([String(conv.team_id), conv.is_private, conv.team_visibility]).toEqual([String(codecast), false, "summary"]);
    expect(String(conv.priority_id)).toBe(String(p1));
  });

  test("a Start never widens sharing: an unmapped folder with no pick stays private, so a team priority's link is refused", async () => {
    const { t, ada, codecast } = await world();
    const conv = await start(t, ada, "stub-5", { priority: "pri-1", ...UNMAPPED });
    expect([String(conv.team_id), conv.is_private, conv.priority_id]).toEqual([String(codecast), true, undefined]);
  });

  test("Start on the viewer's personal priority from an unmapped folder keeps the session personal, linked", async () => {
    const { t, ada, p3 } = await world();
    const conv = await start(t, ada, "stub-6", { priority: "pri-3", ...UNMAPPED });
    expect(conv.team_id).toBeUndefined();
    expect(conv.is_private).toBe(true);
    expect(String(conv.priority_id)).toBe(String(p3));
  });

  test("Hidden, or a folder locked private, stays private and unlinked", async () => {
    const { t, ada } = await world();
    const hidden = await start(t, ada, "stub-7", { priority: "pri-1", private: true, ...CODECAST_FOLDER });
    expect([hidden.is_private, hidden.team_visibility, hidden.priority_id]).toEqual([true, "private", undefined]);
    const locked = await start(t, ada, "stub-8", { priority: "pri-1", project_path: "/work/secret/x", git_root: "/work/secret/x" });
    expect([locked.team_id, locked.is_private, locked.priority_id]).toEqual([undefined, true, undefined]);
  });

  test("an unknown priority leaves the session where its folder puts it", async () => {
    const { t, ada, union } = await world();
    const conv = await start(t, ada, "stub-9", { priority: "pri-404" });
    expect(String(conv.team_id)).toBe(String(union));
    expect(conv.priority_id).toBeUndefined();
  });
});

describe("the composer's preview of where a Start goes (sessionVisibilityPreview.creationTeam)", () => {
  const preview = (t: any, ada: Id<"users">, args: Record<string, unknown>) => t.withIdentity({ subject: `${ada}|session` }).query((api as any).sessionVisibilityPreview.creationTeam, args);

  test("names the priority's team for an unmapped folder, private until the person shares it; a mapped folder keeps its own team", async () => {
    const { t, ada, codecast, union } = await world();
    expect(await preview(t, ada, { path: "/tmp/scratch", priority: "pri-1" })).toMatchObject({ team_id: String(codecast), team_name: "Codecast", visibility: "private" });
    expect(await preview(t, ada, { path: "/work/union/app", priority: "pri-1" })).toMatchObject({ team_id: String(union), team_name: "Union" });
    expect(await preview(t, ada, { path: "/work/codecast/app", priority: "pri-1" })).toMatchObject({ team_id: String(codecast) });
  });

  test("a Start on the person's own priority in an unmapped folder has no team to name", async () => {
    const { t, ada } = await world();
    expect(await preview(t, ada, { path: "/tmp/scratch", priority: "pri-3" })).toBeNull();
  });
});
