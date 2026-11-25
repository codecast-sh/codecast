// The heartbeat tells the daemon whether live replies are on for any of the
// user's teams, from the same team load as snippet_availability.
import { expect, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { api } from "./_generated/api";
import { allModules } from "./testModules.testkit";
import { hashToken } from "./apiTokens";

const TOKEN = "laptop-token";

test("reply_streaming is off by default and on once a team of the user has the flag", async () => {
  const t = convexTest(schema, allModules);
  const team = await t.run(async (ctx) => {
    const now = Date.now();
    const user = await ctx.db.insert("users", { name: "U" });
    await ctx.db.insert("api_tokens", { user_id: user, token_hash: await hashToken(TOKEN), name: "cli", created_at: now, last_used_at: now });
    const team = await ctx.db.insert("teams", { name: "T", created_at: now, invite_code: "t" });
    await ctx.db.insert("team_memberships", { user_id: user, team_id: team, role: "member", joined_at: now } as any);
    return team;
  });
  const beat = () => t.mutation(api.users.daemonHeartbeat, { api_token: TOKEN, version: "1.0.0", platform: "darwin", pid: 1 });

  expect((await beat()).reply_streaming).toBe(false);
  await t.run((ctx) => ctx.db.patch(team, { features: { reply_streaming: true } }));
  const on = await beat();
  expect(on.reply_streaming).toBe(true);
  expect(on.snippet_availability).toBeDefined();
});
