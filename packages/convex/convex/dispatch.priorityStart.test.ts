// A session started from a milestone's Start lives in its priority's
// workspace, whatever folder or workspace the composer was in, so the link to
// the milestone holds (dispatch createSession, dispatchHelpers startWorkspace).
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
 * Ada is in Codecast and Union; her Union folder auto-shares to Union. She
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

describe("Start from a milestone outside the active workspace", () => {
  test("Start on the viewer's Codecast priority from a Union folder, Union active, makes a Codecast session linked to the milestone", async () => {
    const { t, ada, codecast, p1 } = await world();
    const conv = await start(t, ada, "stub-1", { priority: "pri-1" });
    expect(String(conv.team_id)).toBe(String(codecast));
    expect(conv.is_private).toBe(false);
    expect([String(conv.priority_id), conv.priority_step_key]).toEqual([String(p1), "s1"]);
  });

  test("Start on a teammate's Codecast priority lands in Codecast, linked", async () => {
    const { t, ada, codecast, p2 } = await world();
    const conv = await start(t, ada, "stub-2", { priority: "pri-2" });
    expect(String(conv.team_id)).toBe(String(codecast));
    expect(String(conv.priority_id)).toBe(String(p2));
  });

  test("Start on the viewer's personal priority keeps the session personal, linked", async () => {
    const { t, ada, p3 } = await world();
    const conv = await start(t, ada, "stub-3", { priority: "pri-3" });
    expect(conv.team_id).toBeUndefined();
    expect(conv.is_private).toBe(true);
    expect(String(conv.priority_id)).toBe(String(p3));
  });

  test("Hidden, or a folder locked private, is never shared to reach the milestone: the session stays private and unlinked", async () => {
    const { t, ada } = await world();
    const hidden = await start(t, ada, "stub-4", { priority: "pri-1", private: true });
    expect([hidden.is_private, hidden.team_visibility, hidden.priority_id]).toEqual([true, "private", undefined]);
    const locked = await start(t, ada, "stub-5", { priority: "pri-1", project_path: "/work/secret/x", git_root: "/work/secret/x" });
    expect([locked.is_private, locked.priority_id]).toEqual([true, undefined]);
  });

  test("an unknown priority leaves the session where its folder puts it", async () => {
    const { t, ada, union } = await world();
    const conv = await start(t, ada, "stub-6", { priority: "pri-404" });
    expect(String(conv.team_id)).toBe(String(union));
    expect(conv.priority_id).toBeUndefined();
  });
});
