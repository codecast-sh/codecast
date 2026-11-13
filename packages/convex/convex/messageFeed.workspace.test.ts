// The message feed reads one workspace. A viewer in two teams, looking at one,
// saw prompts from members of the other team (who are not in the one shown),
// because the feed walked every team the viewer belonged to. And a member of
// both teams leaked sessions shared with the other team into this one, because
// the team visibility filter accepted any team_id, not only its own.
import { expect, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { api } from "./_generated/api";
import { allModules } from "./testModules.testkit";

test("the team message feed shows only the active team's shared prompts", async () => {
  const t = convexTest(schema, allModules);
  const ids = await t.run(async (ctx) => {
    const now = Date.now();
    const viewer = await ctx.db.insert("users", { name: "Viewer" });
    const onlyOther = await ctx.db.insert("users", { name: "Only Other" });
    const both = await ctx.db.insert("users", { name: "Both" });
    const T = await ctx.db.insert("teams", { name: "T", created_at: now, invite_code: "t" });
    const O = await ctx.db.insert("teams", { name: "O", created_at: now, invite_code: "o" });
    const join = (user_id: any, team_id: any) => ctx.db.insert("team_memberships", { user_id, team_id, role: "member", joined_at: now });
    await join(viewer, T);
    await join(viewer, O);
    await join(onlyOther, O);
    await join(both, T);
    await join(both, O);
    await ctx.db.patch(viewer, { active_team_id: T });
    const prompt = async (user_id: any, team_id: any, label: string) => {
      const conversation_id = await ctx.db.insert("conversations", {
        user_id, team_id, is_private: false, agent_type: "claude_code", session_id: label,
        started_at: now, updated_at: now, message_count: 1, status: "active",
      } as any);
      await ctx.db.insert("messages", { conversation_id, message_uuid: label, role: "user", content: `prompt from ${label}`, timestamp: now } as any);
    };
    await prompt(viewer, T, "viewer in T");
    await prompt(viewer, O, "viewer in O");
    await prompt(onlyOther, O, "only-other in O");
    await prompt(both, T, "both in T");
    await prompt(both, O, "both in O");
    return { viewer, T, O };
  });

  const read = async (args: Record<string, unknown>) => {
    const page: any = await t.withIdentity({ subject: ids.viewer }).query(api.conversations.getMessageFeed, { filter: "team", ...args });
    return page.messages.map((m: any) => [m.content.replace("prompt from ", ""), m.workspace]).sort();
  };

  const inT = [["both in T", `team:${ids.T}`], ["viewer in T", `team:${ids.T}`]];
  expect(await read({})).toEqual(inT);
  expect(await read({ activeTeamId: ids.T })).toEqual(inT);
  expect(await read({ activeTeamId: ids.O })).toEqual([
    ["both in O", `team:${ids.O}`],
    ["only-other in O", `team:${ids.O}`],
    ["viewer in O", `team:${ids.O}`],
  ]);
});
