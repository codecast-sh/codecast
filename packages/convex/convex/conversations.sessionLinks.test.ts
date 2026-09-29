import { describe, expect, test } from "bun:test";
import { convexTest } from "convex-test";
import { hashToken } from "@platform/auth/convex";
import { api } from "./_generated/api";
import schema from "./schema";

// /cli/session-links answers the session trailer hook, which adds a
// Codecast-Session link to a commit only when the session's team can read it
// (packages/cli/src/sessionTrailer.ts). team_visible is that answer, by the
// rule commit ingest uses to trust the link (isConversationTeamVisible).

const modules = {
  "./_generated/server.ts": () => import("./_generated/server"),
  "./conversations.ts": () => import("./conversations"),
};
const token = "s".repeat(64);

async function seed() {
  const t = convexTest(schema, modules);
  await t.run(async (ctx) => {
    const user = await ctx.db.insert("users", { name: "Owner" } as any);
    const team = await ctx.db.insert("teams", { name: "Team", created_at: 1 } as any);
    await ctx.db.insert("team_memberships", { user_id: user, team_id: team, role: "member", joined_at: 1 } as any);
    await ctx.db.insert("api_tokens", { user_id: user, token_hash: await hashToken(token), name: "cli", created_at: 1, last_used_at: 1 } as any);
    const conv = (session_id: string, extra: Record<string, unknown>) =>
      ctx.db.insert("conversations", { user_id: user, session_id, agent_type: "claude_code", started_at: 1, updated_at: 1, message_count: 0, status: "active", ...extra } as any);
    await conv("shared", { team_id: team, is_private: false });
    await conv("revealed", { team_id: team, is_private: true, team_visibility: "summary" });
    await conv("private", { team_id: team, is_private: true });
    await conv("personal", { is_private: false });
  });
  return t;
}

describe("getSessionLinks team_visible", () => {
  test("true only for a session its team can read", async () => {
    const t = await seed();
    const visible = async (session_id: string) =>
      ((await t.mutation(api.conversations.getSessionLinks, { session_id, api_token: token })) as any).team_visible;
    expect(await visible("shared")).toBe(true);
    expect(await visible("revealed")).toBe(true);
    expect(await visible("private")).toBe(false);
    expect(await visible("personal")).toBe(false);
  });
});
