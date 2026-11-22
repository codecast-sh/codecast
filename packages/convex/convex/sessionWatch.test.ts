// Subscribing to a session and muting one, under convex-test: the setting
// row's lifecycle, a teammate subscribed to "needs input" hearing every
// waiting episode, the session, folder, project and teammate mutes silencing
// the runner's own ping, and "every message" subscribers hearing a coalesced
// batch.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { allModules } from "./testModules.testkit";
import { noteWatchedActivity, sessionNotifyKey } from "./sessionWatch";

setDefaultTimeout(120_000);

async function setup(convExtra: Record<string, any> = {}) {
  const t = convexTest(schema, allModules);
  const now = Date.now();
  const ids = await t.run(async (ctx) => {
    const ana = await ctx.db.insert("users", { name: "Ana", notifications_enabled: true, push_token: "ExponentPushToken[ana]" } as any);
    const ben = await ctx.db.insert("users", { name: "Ben", notifications_enabled: true, push_token: "ExponentPushToken[ben]" } as any);
    const team = await ctx.db.insert("teams", { name: "Acme", invite_code: "ACME1234", created_at: 1 } as any);
    await ctx.db.insert("team_memberships", { user_id: ana, team_id: team, role: "admin", joined_at: 1 } as any);
    await ctx.db.insert("team_memberships", { user_id: ben, team_id: team, role: "member", joined_at: 2 } as any);
    const project = await ctx.db.insert("projects", { user_id: ana, team_id: team, title: "Billing", status: "active", created_at: 1, updated_at: 1 } as any);
    const conv = await ctx.db.insert("conversations", {
      user_id: ana,
      agent_type: "claude_code",
      session_id: "sess-1",
      started_at: now - 600_000,
      updated_at: now - 70_000,
      message_count: 2,
      is_private: false,
      status: "active",
      team_id: team,
      title: "Fix billing",
      project_path: "/repo/billing",
      git_root: "/repo/billing",
      ...convExtra,
    } as any);
    await ctx.db.insert("messages", { conversation_id: conv, role: "user", content: "Fix it", timestamp: now - 80_000 } as any);
    await ctx.db.insert("messages", { conversation_id: conv, role: "assistant", content: "Done. Ship it?", timestamp: now - 70_000 } as any);
    await ctx.db.insert("managed_sessions", {
      session_id: "sess-1", conversation_id: conv, user_id: ana, pid: 1, started_at: now - 600_000,
      last_heartbeat: now - 5_000, agent_status: "idle", agent_status_updated_at: now - 60_000,
    } as any);
    return { ana, ben, team, project, conv };
  });
  const as = (user: Id<"users">) => t.withIdentity({ subject: `${user}|session` });
  const pings = (user: Id<"users">) =>
    t.run(async (ctx) => (await ctx.db.query("notifications").collect()).filter((n) => n.recipient_user_id === user));
  const check = () => t.mutation(internal.notifications.checkNeedsInput, { conversation_id: ids.conv });
  return { t, ...ids, as, pings, check };
}

describe("session notify setting", () => {
  test("set, change and clear: one row, listed under the shared store key", async () => {
    const { t, ben, conv, as } = await setup();
    await as(ben).mutation(api.sessionWatch.setLevel, { conversation_id: conv, level: "needs_input" });
    await as(ben).mutation(api.sessionWatch.setLevel, { conversation_id: conv, level: "all" });
    const listed = await as(ben).query(api.sessionWatch.listMine, {});
    expect(listed).toMatchObject([{ _id: sessionNotifyKey(conv), conversation_id: conv, level: "all" }]);

    await as(ben).mutation(api.sessionWatch.setLevel, { conversation_id: conv, level: "default" });
    expect(await as(ben).query(api.sessionWatch.listMine, {})).toEqual([]);
    expect(await t.run((ctx) => ctx.db.query("entity_subscriptions").collect())).toEqual([]);
  });

  test("clearing a setting on a row that predates it keeps the row's thread following", async () => {
    const { t, ben, conv, as } = await setup();
    await t.run((ctx) => ctx.db.insert("entity_subscriptions", {
      user_id: ben, entity_type: "conversation", entity_id: conv, reason: "commenter", muted: false, created_at: 1,
    }));
    await as(ben).mutation(api.sessionWatch.setLevel, { conversation_id: conv, level: "muted" });
    await as(ben).mutation(api.sessionWatch.setLevel, { conversation_id: conv, level: "default" });
    const rows = await t.run((ctx) => ctx.db.query("entity_subscriptions").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ reason: "commenter", muted: false });
    expect(rows[0].notify).toBeUndefined();
  });

  test("nobody sets a level on a session they cannot read", async () => {
    const { ben, conv, as } = await setup({ is_private: true });
    await expect(as(ben).mutation(api.sessionWatch.setLevel, { conversation_id: conv, level: "all" })).rejects.toThrow(/not found/i);
  });
});

describe("needs-input pings", () => {
  test("a teammate subscribed to needs input hears it, once per episode", async () => {
    const { ana, ben, conv, as, pings, check } = await setup();
    await as(ben).mutation(api.sessionWatch.setLevel, { conversation_id: conv, level: "needs_input" });
    await check();
    expect((await pings(ben)).map((n) => n.type)).toEqual(["session_idle"]);
    expect((await pings(ana)).map((n) => n.type)).toEqual(["session_idle"]);
    await check();
    expect(await pings(ben)).toHaveLength(1);
  });

  test("a subscriber hears a pinned session the owner's chime skips", async () => {
    const { ana, ben, conv, as, pings, check } = await setup({ inbox_pinned_at: 1 });
    await as(ben).mutation(api.sessionWatch.setLevel, { conversation_id: conv, level: "needs_input" });
    await check();
    expect(await pings(ben)).toHaveLength(1);
    expect(await pings(ana)).toHaveLength(0);
  });

  test("the runner subscribed to their own session is told once, not twice", async () => {
    const { ana, conv, as, pings, check } = await setup();
    await as(ana).mutation(api.sessionWatch.setLevel, { conversation_id: conv, level: "needs_input" });
    await check();
    expect(await pings(ana)).toHaveLength(1);
  });

  test("a finished turn does not ring an every-message subscriber twice", async () => {
    const { ben, conv, as, pings, check } = await setup();
    await as(ben).mutation(api.sessionWatch.setLevel, { conversation_id: conv, level: "all" });
    await check();
    expect(await pings(ben)).toHaveLength(0);
  });

  test("a muted session rings its runner nothing", async () => {
    const { ana, conv, as, pings, check } = await setup();
    await as(ana).mutation(api.sessionWatch.setLevel, { conversation_id: conv, level: "muted" });
    await check();
    expect(await pings(ana)).toHaveLength(0);
  });

  test("a muted folder or project silences it; the session's own setting wins over both", async () => {
    for (const mute of [{ muted_folders: ["/repo/billing"] }, "project"] as const) {
      const { t, ana, conv, project, as, pings, check } = await setup();
      const patch = mute === "project" ? { muted_projects: [project] } : mute;
      if (mute === "project") await t.run((ctx) => ctx.db.patch(conv, { project_id: project }));
      await as(ana).mutation(api.users.updateNotificationPreferences, patch as any);
      await check();
      expect(await pings(ana)).toHaveLength(0);

      await as(ana).mutation(api.sessionWatch.setLevel, { conversation_id: conv, level: "needs_input" });
      await t.run((ctx) => ctx.db.patch(conv, { message_count: 3, watch_notified_key: undefined, needs_input_notified_key: undefined }));
      await check();
      expect(await pings(ana)).toHaveLength(1);
    }
  });

  test("a muted teammate's session rings an owner nothing", async () => {
    const { t, ana, ben, conv, as, pings, check } = await setup();
    await t.run((ctx) => ctx.db.patch(conv, { owner_user_id: ben }));
    await as(ben).mutation(api.users.updateNotificationPreferences, { muted_members: [ana] });
    await check();
    expect(await pings(ben)).toHaveLength(0);
  });
});

describe("every-message subscribers", () => {
  test("assistant replies inside one batch ring once, with the count and the newest text", async () => {
    const { t, ben, conv, as, pings } = await setup();
    await as(ben).mutation(api.sessionWatch.setLevel, { conversation_id: conv, level: "all" });
    const now = Date.now();
    await t.run(async (ctx) => {
      await ctx.db.insert("messages", { conversation_id: conv, role: "assistant", content: "Reading the invoice code", timestamp: now - 2_000 } as any);
      await ctx.db.insert("messages", { conversation_id: conv, role: "assistant", content: "", tool_calls: [], timestamp: now - 1_500 } as any);
      await ctx.db.insert("messages", { conversation_id: conv, role: "assistant", content: "Found the rounding bug", timestamp: now - 1_000 } as any);
      await ctx.db.patch(conv, { watch_flushed_at: now - 3_000 });
    });
    const res = await t.mutation(internal.sessionWatch.flushWatchedActivity, { conversation_id: conv });
    expect(res).toEqual({ notified: 1, count: 2 });
    const rows = await pings(ben);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ type: "session_activity", message: "2 new messages: Found the rounding bug" });
    const outbox = await t.run((ctx) => ctx.db.query("push_outbox").collect());
    expect(outbox.find((p) => p.user_id === ben)).toMatchObject({ title: "Fix billing", subtitle: "2 new messages", body: "Found the rounding bug" });

    // Nothing new since: the next flush rings nobody, and the bell keeps one row.
    expect(await t.mutation(internal.sessionWatch.flushWatchedActivity, { conversation_id: conv })).toEqual({ notified: 0, count: 0 });
    expect(await pings(ben)).toHaveLength(1);
  });

  test("assistant text arriving opens one batch, and a second write inside it opens none", async () => {
    const { t, ben, conv, as } = await setup();
    await as(ben).mutation(api.sessionWatch.setLevel, { conversation_id: conv, level: "all" });
    await t.run(async (ctx) => {
      await noteWatchedActivity(ctx as any, (await ctx.db.get(conv))!);
      await noteWatchedActivity(ctx as any, (await ctx.db.get(conv))!);
    });
    const due = await t.run(async (ctx) => (await ctx.db.get(conv))!.watch_flush_due_at);
    expect(due).toBeGreaterThan(Date.now());
    const jobs = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    expect(jobs.filter((j: any) => j.name.includes("flushWatchedActivity"))).toHaveLength(1);
  });

  test("nobody subscribed: assistant text opens no batch", async () => {
    const { t, conv } = await setup();
    await t.run(async (ctx) => noteWatchedActivity(ctx as any, (await ctx.db.get(conv))!));
    expect(await t.run(async (ctx) => "watch_flush_due_at" in (await ctx.db.get(conv))!)).toBe(false);
  });
});
