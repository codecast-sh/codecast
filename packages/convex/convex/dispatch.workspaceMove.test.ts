// A person moves their own conversation into another workspace from the app
// (ct-101478): one dispatch verb rewrites the row's team and sharing through
// patchConversationVisibility, so its linked work follows, and a team the
// person is not in, or someone else's conversation, is refused.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { allModules } from "./testModules.testkit";
import { api } from "./_generated/api";

setDefaultTimeout(60_000);

const NOW = Date.now();

async function world() {
  const t = convexTest(schema, allModules);
  const ids = await t.run(async (ctx) => {
    const ada = await ctx.db.insert("users", { name: "Ada" } as any);
    const bea = await ctx.db.insert("users", { name: "Bea" } as any);
    const teamA = await ctx.db.insert("teams", { name: "Alpha", created_at: NOW } as any);
    const teamB = await ctx.db.insert("teams", { name: "Beta", created_at: NOW } as any);
    const teamC = await ctx.db.insert("teams", { name: "Gamma", created_at: NOW } as any);
    for (const team of [teamA, teamB]) await ctx.db.insert("team_memberships", { user_id: ada, team_id: team, role: "member", joined_at: 1 } as any);
    await ctx.db.insert("team_memberships", { user_id: bea, team_id: teamA, role: "member", joined_at: 1 } as any);
    const conv = await ctx.db.insert("conversations", {
      user_id: ada, team_id: teamA, agent_type: "claude_code", session_id: "s-move", short_id: "jx7mv01", title: "move me",
      started_at: NOW, updated_at: NOW, message_count: 1, is_private: false, team_visibility: "full", status: "active",
    } as any);
    const task = await ctx.db.insert("tasks", {
      user_id: ada, team_id: teamA, workspace: `team:${teamA}`, short_id: "ct-900001", title: "linked", status: "open",
      task_type: "task", priority: "medium", created_from_conversation: conv, created_at: NOW, updated_at: NOW,
    } as any);
    return { ada, bea, teamA, teamB, teamC, conv, task };
  });
  return { t, ...ids };
}

const dispatch = (t: any, user: string, action: string, args: unknown[]) =>
  t.withIdentity({ subject: `${user}|session` }).mutation(api.dispatch.dispatch, { action, args });

const read = (t: any, id: any) => t.run(async (ctx: any) => ctx.db.get(id));

describe("move a conversation to another workspace", () => {
  test("into another team: the row and its linked task land in that team", async () => {
    const { t, ada, teamB, conv, task } = await world();
    await dispatch(t, ada, "moveSessionToWorkspace", [conv, teamB]);
    expect(await read(t, conv)).toMatchObject({ team_id: teamB, is_private: false });
    expect((await read(t, task)).workspace).toBe(`team:${teamB}`);
  });

  test("to Personal: private, no team, linked task personal", async () => {
    const { t, ada, conv, task } = await world();
    await dispatch(t, ada, "moveSessionToWorkspace", [conv, null]);
    const row = await read(t, conv);
    expect(row.is_private).toBe(true);
    expect(row.team_id).toBeUndefined();
    expect((await read(t, task)).workspace).toBe(`user:${ada}`);
  });

  test("a team the owner is not in, and a non-owner, are refused", async () => {
    const { t, ada, bea, teamA, teamB, teamC, conv } = await world();
    // A refusal, not a missing verb.
    const refused = (p: Promise<unknown>) => p.then(() => "allowed", (e: any) => String(e?.message ?? e));
    for (const why of [await refused(dispatch(t, ada, "moveSessionToWorkspace", [conv, teamC])), await refused(dispatch(t, bea, "moveSessionToWorkspace", [conv, teamB]))]) {
      expect(why).not.toBe("allowed");
      expect(why).not.toMatch(/Unknown dispatch action/);
    }
    expect((await read(t, conv)).team_id).toBe(teamA);
  });
});
