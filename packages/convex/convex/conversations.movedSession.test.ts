import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { api } from "./_generated/api";
import { hashToken } from "./apiTokens";
import { performReparentSessionToDevice } from "./devices";

setDefaultTimeout(60_000);

const modules = {
  "./_generated/server.ts": () => import("./_generated/server"),
  "./syncOutbox.ts": () => import("./syncOutbox"),
  "./conversations.ts": () => import("./conversations"),
  "./notifications.ts": () => import("./notifications"),
};

const ASHOT_TOKEN = "moved-session-ashot";
const SESSION = "9fadf3dd-9fa9-4e0d-9743-5971ae04fb59";

// jx7cvd9 beside jx78zy0: the Escalations lead moved from Ashot's laptop to a
// machine signed in as Cam (account follows device). The transcript stayed on
// the laptop, its daemon synced it again, and createConversation, finding no
// row Ashot runs, started a second copy that woke and resumed on the laptop
// for two weeks.
async function movedToCam() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const now = Date.now();
    const team = await ctx.db.insert("teams", { name: "union", created_at: now, invite_code: "union" } as any);
    const ashot = await ctx.db.insert("users", { name: "Ashot", emailVerificationTime: 1 } as any);
    const cam = await ctx.db.insert("users", { name: "Cam", emailVerificationTime: 1 } as any);
    for (const u of [ashot, cam]) {
      await ctx.db.insert("team_memberships", { user_id: u, team_id: team, role: "member", joined_at: now } as any);
    }
    await ctx.db.insert("api_tokens", { user_id: ashot, token_hash: await hashToken(ASHOT_TOKEN), name: "cli", created_at: now, last_used_at: now } as any);
    await ctx.db.insert("devices", { user_id: ashot, device_id: "laptop", label: "MacBook", platform: "darwin", last_seen: now } as any);
    await ctx.db.insert("devices", { user_id: cam, device_id: "aws", label: "Union AWS", platform: "linux", last_seen: now } as any);
    const conv = await ctx.db.insert("conversations", {
      user_id: ashot, team_id: team, is_private: false, agent_type: "claude_code", session_id: SESSION,
      owner_device_id: "laptop", project_path: "/Users/ashot/src/union-mobile/outreach",
      started_at: now, updated_at: now, message_count: 0, status: "active",
    } as any);
    await ctx.db.patch(conv, { short_id: conv.toString().slice(0, 7) });
    await performReparentSessionToDevice(ctx, cam, { session_id: conv, device_id: "aws" });
    return { ashot, cam, conv };
  });
  const resync = () => t.mutation(api.conversations.createConversation, {
    user_id: ids.ashot, agent_type: "claude_code", session_id: SESSION,
    project_path: "/Users/ashot/src/union-mobile/outreach", owner_device_id: "laptop", api_token: ASHOT_TOKEN,
  } as any);
  const rows = () => t.run((ctx) => ctx.db.query("conversations").withIndex("by_session_id", (q) => q.eq("session_id", SESSION)).collect());
  return { t, ids, resync, rows };
}

describe("a session moved to another account", () => {
  test("the move hands the row to the new runner and pins the author", async () => {
    const { ids, rows } = await movedToCam();
    const [row] = await rows();
    expect(String(row.user_id)).toBe(String(ids.cam));
    expect(String(row.author_user_id)).toBe(String(ids.ashot));
  });

  test("the old machine re-syncing its leftover transcript starts no second row", async () => {
    const { ids, resync, rows } = await movedToCam();
    const shortId = String(ids.conv).slice(0, 7);
    await expect(resync()).rejects.toThrow(`cast pull ${shortId}`);
    expect(await rows()).toHaveLength(1);
  });

  test("a session id another account holds with no tie to the caller still creates", async () => {
    const { t, ids, resync, rows } = await movedToCam();
    await t.run((ctx) => ctx.db.patch(ids.conv, { author_user_id: undefined }));
    await resync();
    expect(await rows()).toHaveLength(2);
  });
});
