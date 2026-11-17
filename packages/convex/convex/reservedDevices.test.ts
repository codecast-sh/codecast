import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { allModules } from "./testModules.testkit";
import { hashToken } from "./apiTokens";
import { api } from "./_generated/api";

setDefaultTimeout(30_000);

// A machine reserved for one job (devices.reserved_for) takes work only by
// name: it never claims a broadcast start, never adopts an offline owner's
// session, and never sees untargeted work in its command poll.
const TOKEN = "reserved-devices-test-token";

async function seed() {
  const t = convexTest(schema, allModules);
  const now = Date.now();
  const ids = await t.run(async (ctx) => {
    const user = await ctx.db.insert("users", { name: "me" } as any);
    await ctx.db.insert("api_tokens", { user_id: user, token_hash: await hashToken(TOKEN), name: "cli", created_at: 1, last_used_at: 1 } as any);
    await ctx.db.insert("devices", { user_id: user, device_id: "line-4", label: "Linux - line-4", platform: "linux", last_seen: now, reserved_for: "Union line" } as any);
    await ctx.db.insert("devices", { user_id: user, device_id: "laptop", label: "macOS - laptop", platform: "darwin", last_seen: now - 10 * 60_000 } as any);
    const conv = await ctx.db.insert("conversations", {
      user_id: user, session_id: "s-1", agent_type: "claude_code", project_path: "/home/ubuntu/work/union-mobile",
      started_at: now, updated_at: now, message_count: 0, status: "active", owner_device_id: "laptop",
    } as any);
    const fresh = await ctx.db.insert("conversations", {
      user_id: user, session_id: "s-2", agent_type: "claude_code", started_at: now, updated_at: now, message_count: 0, status: "active",
    } as any);
    for (const target of [undefined, "line-4"]) {
      await ctx.db.insert("daemon_commands", { user_id: user, command: "start_session", args: "{}", created_at: now, ...(target ? { target_device_id: target } : {}) } as any);
    }
    await ctx.db.insert("daemon_commands", { user_id: user, command: "status", created_at: now } as any);
    return { user, conv, fresh };
  });
  return { t, ...ids };
}

describe("a reserved machine takes work only by name", () => {
  test("it never adopts an offline owner's session or an unowned one", async () => {
    const { t, conv, fresh } = await seed();
    const takeover = await t.mutation(api.devices.claimConversationForStart, { api_token: TOKEN, conversation_id: conv, device_id: "line-4" });
    expect(takeover.won).toBe(false);
    const broadcast = await t.mutation(api.devices.claimConversationForStart, { api_token: TOKEN, conversation_id: fresh, device_id: "line-4" });
    expect(broadcast.won).toBe(false);
    const owners = await t.run(async (ctx) => [(await ctx.db.get(conv))?.owner_device_id ?? null, (await ctx.db.get(fresh))?.owner_device_id ?? null]);
    expect(owners).toEqual(["laptop", null]);
  });

  test("its poll holds targeted work and device-wide commands, never untargeted starts", async () => {
    const { t } = await seed();
    const seen = await t.query(api.users.getMyPendingCommands, { api_token: TOKEN, device_id: "line-4" });
    expect(seen.map((c: any) => c.command).sort()).toEqual(["start_session", "status"]);
    const unreserved = await t.query(api.users.getMyPendingCommands, { api_token: TOKEN, device_id: "laptop" });
    expect(unreserved.filter((c: any) => c.command === "start_session")).toHaveLength(1);
  });

  test("opening it again lets it claim like any machine", async () => {
    const { t, fresh } = await seed();
    expect(await t.mutation(api.devices.setDeviceReservation, { api_token: TOKEN, device_id: "line-4", purpose: "  " })).toEqual({ reserved_for: null });
    const claim = await t.mutation(api.devices.claimConversationForStart, { api_token: TOKEN, conversation_id: fresh, device_id: "line-4" });
    expect(claim.won).toBe(true);
    expect(await t.mutation(api.devices.setDeviceReservation, { api_token: TOKEN, device_id: "line-4", purpose: "  Union   line " })).toEqual({ reserved_for: "Union line" });
  });
});
