import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { api } from "./_generated/api";
import { hashToken } from "./apiTokens";
import { allModules } from "./testModules.testkit";
import { enqueuePendingMessage, healAndNotifyStuckMessages } from "./pendingMessages";
import { enqueueKillAndResume } from "./conversations";
import { repositoryKeyOfRemote } from "@codecast/shared/contracts";

setDefaultTimeout(60_000);

const OWNER_TOKEN = "registered-owner-token";
const MATE_TOKEN = "registered-mate-token";
const DEVICE = "dev-laptop";
const HERDR = { kind: "herdr" as const, socket: "/tmp/herdr.sock", pane: "p1" };
const PASEO = { kind: "paseo" as const, agent_id: "agent-9" };

async function setup() {
  const t = convexTest(schema, allModules);
  const ids = await t.run(async (ctx) => {
    const now = Date.now();
    const owner = await ctx.db.insert("users", { name: "Owner", email: "owner@x.com" } as any);
    const mate = await ctx.db.insert("users", { name: "Mate", email: "mate@x.com" } as any);
    for (const [user, token] of [[owner, OWNER_TOKEN], [mate, MATE_TOKEN]] as const) {
      await ctx.db.insert("api_tokens", { user_id: user, token_hash: await hashToken(token), name: "cli", created_at: now, last_used_at: now } as any);
    }
    const team = await ctx.db.insert("teams", { name: "T", created_at: now, invite_code: "t" } as any);
    for (const user of [owner, mate]) {
      await ctx.db.insert("team_memberships", { user_id: user, team_id: team, role: "member", joined_at: 0, visibility: "full" } as any);
      await ctx.db.patch(user, { active_team_id: team } as any);
    }
    const daemonConv = await ctx.db.insert("conversations", {
      user_id: owner, team_id: team, is_private: false, agent_type: "claude_code", session_id: "ordinary", short_id: "jx7ordi",
      started_at: now, updated_at: now, message_count: 1, status: "active", owner_device_id: DEVICE,
    } as any);
    const senderConv = await ctx.db.insert("conversations", {
      user_id: owner, team_id: team, is_private: false, agent_type: "claude_code", session_id: "sender", short_id: "jx7snd1",
      started_at: now, updated_at: now, message_count: 1, status: "active", owner_device_id: DEVICE,
    } as any);
    const mateConv = await ctx.db.insert("conversations", {
      user_id: mate, team_id: team, is_private: false, agent_type: "claude_code", session_id: "mate-sess", short_id: "jx7mate",
      started_at: now, updated_at: now, message_count: 1, status: "active", owner_device_id: "dev-mate",
    } as any);
    return { owner, mate, team, daemonConv, senderConv, mateConv };
  });
  const register = (extra: Record<string, unknown> = {}) =>
    t.mutation(api.registeredSessions.registerSession, {
      api_token: OWNER_TOKEN, session_id: "reg-1", cwd: "/home/me/work/proj/", device_id: DEVICE, delivery_target: HERDR, ...extra,
    } as any);
  const conv = (id: any) => t.run(async (ctx) => (await ctx.db.get(id)) as any);
  const pendingRows = () => t.run(async (ctx) => (await ctx.db.query("pending_messages").collect()) as any[]);
  const forDaemon = (device_id = DEVICE) => t.query(api.pendingMessages.getPendingMessagesForDaemon, { api_token: OWNER_TOKEN, device_id });
  const forRelay = (device_id = DEVICE) => t.query(api.pendingMessages.pendingForDevice, { api_token: OWNER_TOKEN, device_id });
  const send = (token: string, to: string, extra: Record<string, unknown> = {}) =>
    t.mutation(api.pendingMessages.sendSessionMessage, { to, body: "hello there", api_token: token, ...extra } as any);
  return { t, ...ids, register, conv, pendingRows, forDaemon, forRelay, send };
}

describe("registerSession visibility", () => {
  test("creates a shared register-only row through the visibility chokepoint", async () => {
    const s = await setup();
    const { conversation_id, short_id } = await s.register();
    const row = await s.conv(conversation_id);
    expect(short_id).toBe(conversation_id.toString().slice(0, 7));
    expect(row.short_id).toBe(short_id);
    expect(row.register_only).toBe(true);
    expect(row.delivery_target).toEqual(HERDR);
    expect(row.owner_device_id).toBe(DEVICE);
    expect(row.title).toBe("proj");
    expect(row.project_path).toBe("/home/me/work/proj/");
    expect(row.message_count).toBe(0);
    expect(row.is_private).toBe(false);
    expect(row.team_id).toBe(s.team);
    expect(row.auto_shared).toBe(true);
    expect(row.status).toBe("active");

    const events = await s.t.run((ctx) => ctx.db.query("authority_events").collect() as Promise<any[]>);
    const event = events.find((e) => e.kind === "conversation_visibility_changed" && e.conversation_id === conversation_id);
    expect(event).toBeDefined();
    expect(event.actor_user_id).toBe(s.owner);
  });

  test("a teammate lists it in the feed with no messages and can send to it", async () => {
    const s = await setup();
    const { conversation_id, short_id } = await s.register();
    const feed: any = await s.t.query(api.conversations.feedForCLI, { api_token: MATE_TOKEN });
    const card = feed.conversations.find((c: any) => c.session_id === "reg-1");
    expect(card).toBeDefined();
    expect(card.title).toBe("proj");
    const msgs = await s.t.run((ctx) => ctx.db.query("messages").withIndex("by_conversation_id", (q) => q.eq("conversation_id", conversation_id)).collect());
    expect(msgs).toHaveLength(0);

    const res: any = await s.send(MATE_TOKEN, short_id);
    expect(res.message_id).not.toBeNull();
    const rows = await s.pendingRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].conversation_id).toBe(conversation_id);
    expect(rows[0].from_user_id).toBe(s.mate);
    expect(rows[0].owner_user_id).toBe(s.owner);
  });

  test("a folder the owner locked stays private and unreachable for a teammate", async () => {
    const s = await setup();
    await s.t.run((ctx) => ctx.db.insert("directory_team_mappings", {
      user_id: s.owner, path_prefix: "/home/me/work", auto_share: false, private: true, created_at: Date.now(),
    } as any));
    const { conversation_id, short_id } = await s.register();
    const row = await s.conv(conversation_id);
    expect(row.is_private).toBe(true);
    expect(row.team_id).toBeUndefined();
    expect(row.auto_shared).toBeUndefined();
    await expect(s.send(MATE_TOKEN, short_id)).rejects.toThrow();
    expect(await s.pendingRows()).toHaveLength(0);
  });

  test("a repository the owner locked stays private from a worktree outside the locked folder", async () => {
    const s = await setup();
    const remote = "git@github.com:acme/widgets.git";
    await s.t.run((ctx) => ctx.db.insert("directory_team_mappings", {
      user_id: s.owner, path_prefix: "/home/me/elsewhere", auto_share: false, private: true,
      repository: repositoryKeyOfRemote(remote), created_at: Date.now(),
    } as any));
    const { conversation_id, short_id } = await s.register({ git_remote_url: remote });
    const row = await s.conv(conversation_id);
    expect(row.is_private).toBe(true);
    expect(row.team_id).toBeUndefined();
    await expect(s.send(MATE_TOKEN, short_id)).rejects.toThrow();
  });

  test("an owner with no team stays private", async () => {
    const s = await setup();
    await s.t.run(async (ctx) => {
      for (const m of await ctx.db.query("team_memberships").collect()) await ctx.db.delete(m._id);
      await ctx.db.patch(s.owner, { active_team_id: undefined } as any);
    });
    const { conversation_id } = await s.register();
    const row = await s.conv(conversation_id);
    expect(row.is_private).toBe(true);
    expect(row.team_id).toBeUndefined();
  });

  test("a title falls back to the cwd when no segment is left", async () => {
    const s = await setup();
    const { conversation_id } = await s.register({ cwd: "/" });
    expect((await s.conv(conversation_id)).title).toBe("/");
  });
});

describe("registerSession re-registration", () => {
  test("updates the target and clears ended_at", async () => {
    const s = await setup();
    const first = await s.register();
    await s.t.mutation(api.registeredSessions.markEnded, { api_token: OWNER_TOKEN, session_id: "reg-1" });
    expect((await s.conv(first.conversation_id)).ended_at).toBeGreaterThan(0);
    expect((await s.conv(first.conversation_id)).status).toBe("completed");

    const again = await s.register({ delivery_target: PASEO, device_id: "dev-other", cwd: "/srv/next" });
    expect(again.conversation_id).toBe(first.conversation_id);
    const row = await s.conv(first.conversation_id);
    expect(row.delivery_target).toEqual(PASEO);
    expect(row.owner_device_id).toBe("dev-other");
    expect(row.project_path).toBe("/srv/next");
    expect(row.ended_at).toBeUndefined();
    expect(row.status).toBe("active");
  });

  test("refuses a re-registration from another device while the row is live", async () => {
    const s = await setup();
    const { conversation_id } = await s.register();
    await expect(s.register({ device_id: "dev-other", delivery_target: PASEO })).rejects.toThrow(/another device/);
    const row = await s.conv(conversation_id);
    expect(row.owner_device_id).toBe(DEVICE);
    expect(row.delivery_target).toEqual(HERDR);
    await s.register({ delivery_target: PASEO });
    expect((await s.conv(conversation_id)).delivery_target).toEqual(PASEO);
  });

  test("leaves a row its owner made private private", async () => {
    const s = await setup();
    const { conversation_id } = await s.register();
    await s.t.mutation(api.conversations.setPrivacy, { api_token: OWNER_TOKEN, conversation_id, is_private: true });
    await s.register({ delivery_target: PASEO });
    const row = await s.conv(conversation_id);
    expect(row.is_private).toBe(true);
    expect(row.delivery_target).toEqual(PASEO);
  });

  test("refuses to take over a daemon-synced session", async () => {
    const s = await setup();
    await expect(s.register({ session_id: "ordinary" })).rejects.toThrow(/already synced/);
    const row = await s.conv(s.daemonConv);
    expect(row.register_only).toBeUndefined();
    expect(row.delivery_target).toBeUndefined();
  });

  test("requires authentication", async () => {
    const s = await setup();
    await expect(s.register({ api_token: "nope" })).rejects.toThrow(/Authentication failed/);
  });
});

describe("no double delivery between daemon and relay", () => {
  test("a register-only row is the relay's alone, an ordinary row the daemon's alone", async () => {
    const s = await setup();
    const { conversation_id, short_id } = await s.register();
    await s.send(OWNER_TOKEN, short_id);
    await s.send(MATE_TOKEN, short_id);
    await s.send(OWNER_TOKEN, "jx7ordi");
    const rows = await s.pendingRows();
    const regRows = rows.filter((r) => r.conversation_id === conversation_id);
    const ordRows = rows.filter((r) => r.conversation_id === s.daemonConv);
    expect(regRows).toHaveLength(2);
    expect(ordRows).toHaveLength(1);

    const daemonIds = (await s.forDaemon()).map((r: any) => r._id);
    expect(daemonIds).toEqual(ordRows.map((r) => r._id));

    const relay: any[] = await s.forRelay();
    expect(relay.map((r) => r._id)).toEqual([regRows[0]._id]);
    expect(relay[0].delivery_target).toEqual(HERDR);
    expect(relay[0].session_id).toBe("reg-1");
    expect(await s.forRelay("dev-other")).toEqual([]);

    for (const r of regRows) {
      const claimed = await s.t.mutation(api.pendingMessages.claimPendingMessageForDelivery, {
        api_token: OWNER_TOKEN, message_id: r._id, device_id: DEVICE,
      });
      expect(claimed).toBeNull();
    }
    const claimedOrdinary = await s.t.mutation(api.pendingMessages.claimPendingMessageForDelivery, {
      api_token: OWNER_TOKEN, message_id: ordRows[0]._id, device_id: DEVICE,
    });
    expect(claimedOrdinary).not.toBeNull();
  });

  test("the relay's ack through updateMessageStatus marks the row delivered", async () => {
    const s = await setup();
    const { short_id } = await s.register();
    await s.send(MATE_TOKEN, short_id);
    const [row]: any[] = await s.forRelay();
    const res = await s.t.mutation(api.pendingMessages.updateMessageStatus, {
      api_token: OWNER_TOKEN, message_id: row._id, status: "delivered", delivered_at: Date.now(), device_id: DEVICE,
    });
    expect(res.skipped).toBe(false);
    const after = (await s.pendingRows())[0];
    expect(after.status).toBe("delivered");
    expect(await s.forRelay()).toEqual([]);
  });

  test("a row the daemon could not take is not shown to the relay either", async () => {
    const s = await setup();
    const { conversation_id, short_id } = await s.register();
    await s.send(MATE_TOKEN, short_id);
    expect(await s.forRelay()).toHaveLength(1);
    await s.t.run((ctx) => ctx.db.patch(conversation_id, { execution_protocol_state: "quiescing" } as any));
    expect(await s.forRelay()).toEqual([]);
  });

  test("a direct queued send is pending and visible to the relay", async () => {
    const s = await setup();
    const { short_id } = await s.register();
    await s.send(OWNER_TOKEN, short_id, { direct: true, queue: true });
    const rows = await s.pendingRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("pending");
    expect(rows[0].queued).toBeUndefined();
    expect((await s.forRelay()).map((r: any) => r._id)).toEqual([rows[0]._id]);
  });

  test("an ack from another device is skipped", async () => {
    const s = await setup();
    const { short_id } = await s.register();
    await s.send(MATE_TOKEN, short_id);
    const [row]: any[] = await s.forRelay();
    const res = await s.t.mutation(api.pendingMessages.updateMessageStatus, {
      api_token: OWNER_TOKEN, message_id: row._id, status: "delivered", delivered_at: Date.now(), device_id: "dev-other",
    });
    expect(res.skipped).toBe(true);
    expect((await s.pendingRows())[0].status).toBe("pending");
  });
});

describe("the send gate", () => {
  test("a session send with wake false reaches a cold register-only row", async () => {
    const s = await setup();
    const { conversation_id, short_id } = await s.register();
    await s.t.run((ctx) => ctx.db.patch(conversation_id, { updated_at: Date.now() - 3 * 60 * 60_000 } as any));
    const res: any = await s.send(OWNER_TOKEN, short_id, { from: "jx7snd1", wake: false });
    expect(res.message_id).not.toBeNull();
    const rows = (await s.pendingRows()).filter((r) => r.conversation_id === conversation_id);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("pending");
  });
});

describe("the healer", () => {
  test("leaves register-only rows alone and still acts on ordinary ones", async () => {
    const s = await setup();
    const { conversation_id } = await s.register();
    const now = Date.now();
    const old = now - 60 * 60_000;
    const seeded = await s.t.run(async (ctx) => {
      const make = async (conversation_id: any, status: string) =>
        ctx.db.insert("pending_messages", {
          conversation_id, from_user_id: s.mate, owner_user_id: s.owner, content: `body ${status}`,
          status, retry_count: 2, created_at: old,
          ...(conversation_id === s.daemonConv ? {} : { from_conversation_id: s.mateConv }),
        } as any);
      const reg = [] as any[];
      for (const status of ["pending", "injected", "failed"]) reg.push(await make(conversation_id, status));
      const ordinary = await make(s.daemonConv, "injected");
      return { reg, ordinary };
    });
    await s.t.run(async (ctx) => { await healAndNotifyStuckMessages(ctx, now); });
    const after = await s.t.run(async (ctx) => {
      const out = [] as any[];
      for (const id of seeded.reg) out.push(await ctx.db.get(id));
      return { reg: out, ordinary: (await ctx.db.get(seeded.ordinary)) as any };
    });
    expect(after.reg.map((r: any) => r.status)).toEqual(["pending", "injected", "failed"]);
    for (const r of after.reg) {
      expect(r.retry_count).toBe(2);
      expect(r.dead_session_revived_at).toBeUndefined();
    }
    expect(after.ordinary.status).toBe("pending");
    expect(after.ordinary.dead_session_revived_at).toBe(now);
    for (const r of after.reg) expect(r.sender_notified_at).toBeUndefined();
    const notices = (await s.pendingRows()).filter((r) => r.conversation_id === s.mateConv);
    expect(notices).toEqual([]);
  });
});

describe("markEnded", () => {
  test("stamps ended_at and bounces what was waiting", async () => {
    const s = await setup();
    const { conversation_id, short_id } = await s.register();
    await s.send(MATE_TOKEN, short_id, { from: "jx7mate" });
    await s.send(OWNER_TOKEN, short_id, { from: "jx7snd1" });
    await s.t.run((ctx) => ctx.db.insert("pending_messages", {
      conversation_id, from_user_id: s.owner, owner_user_id: s.owner, content: "held note", status: "held", retry_count: 0, created_at: Date.now(),
    } as any));
    expect(await s.forRelay()).toHaveLength(1);

    await s.t.mutation(api.registeredSessions.markEnded, { api_token: OWNER_TOKEN, session_id: "reg-1" });
    const row = await s.conv(conversation_id);
    expect(row.ended_at).toBeGreaterThan(0);
    const firstEnded = row.ended_at;

    const rows = await s.pendingRows();
    const toReg = rows.filter((r) => r.conversation_id === conversation_id);
    expect(toReg.map((r) => r.status)).toEqual(["cancelled", "cancelled", "cancelled"]);
    expect(row.status).toBe("completed");
    const selfNotices = rows.filter((r) => r.conversation_id === s.senderConv);
    expect(selfNotices).toHaveLength(1);
    expect(selfNotices[0].content).toContain("could not be delivered");
    const notices = rows.filter((r) => r.conversation_id === s.mateConv);
    expect(notices).toHaveLength(1);
    expect(notices[0].status).toBe("pending");
    expect(notices[0].content).toContain("could not be delivered");

    await s.t.mutation(api.registeredSessions.markEnded, { api_token: OWNER_TOKEN, session_id: "reg-1" });
    expect((await s.conv(conversation_id)).ended_at).toBe(firstEnded);

    await expect(s.send(MATE_TOKEN, short_id)).rejects.toThrow(/has ended/);
    await expect(s.send(OWNER_TOKEN, short_id, { from: "jx7snd1" })).rejects.toThrow(/has ended/);

    const feed: any = await s.t.query(api.conversations.feedForCLI, { api_token: MATE_TOKEN });
    expect(feed.conversations.find((c: any) => c.session_id === "reg-1")).toBeUndefined();
    expect(await s.forRelay()).toEqual([]);
  });

  test("a direct enqueue into an ended row lands cancelled", async () => {
    const s = await setup();
    const { conversation_id } = await s.register();
    await s.t.mutation(api.registeredSessions.markEnded, { api_token: OWNER_TOKEN, session_id: "reg-1" });
    const id = await s.t.run(async (ctx) => {
      const target = await ctx.db.get(conversation_id);
      return await enqueuePendingMessage(ctx, target, s.owner, { content: "late" });
    });
    const row = (await s.pendingRows()).find((r) => r._id === id);
    expect(row.status).toBe("cancelled");
    expect(await s.forRelay()).toEqual([]);
  });

  test("refuses a session that is not a registered one of the caller", async () => {
    const s = await setup();
    await expect(s.t.mutation(api.registeredSessions.markEnded, { api_token: OWNER_TOKEN, session_id: "ordinary" })).rejects.toThrow(/No registered session/);
    await s.register();
    await expect(s.t.mutation(api.registeredSessions.markEnded, { api_token: MATE_TOKEN, session_id: "reg-1" })).rejects.toThrow(/No registered session/);
  });
});

describe("no second deliverer", () => {
  test("resuming or restarting a registered session throws and queues no daemon command", async () => {
    const s = await setup();
    const { conversation_id, short_id } = await s.register();
    await expect(s.t.mutation(api.conversations.cliResumeSession, { api_token: OWNER_TOKEN, session: short_id })).rejects.toThrow(/does not resume a registered session/);
    await expect(s.t.run((ctx) => enqueueKillAndResume(ctx as any, s.owner, { _id: conversation_id, session_id: "reg-1", register_only: true }))).rejects.toThrow(/does not resume a registered session/);
    expect(await s.t.run((ctx) => ctx.db.query("daemon_commands").collect())).toHaveLength(0);
  });

  test("the cast claude wrapper's managed-session poll neither sees nor settles a registered row", async () => {
    const s = await setup();
    const { conversation_id, short_id } = await s.register();
    await s.t.run((ctx) => ctx.db.insert("managed_sessions", {
      session_id: "reg-1", conversation_id, user_id: s.owner, pid: 1, started_at: Date.now(), last_heartbeat: Date.now(),
    } as any));
    await s.send(MATE_TOKEN, short_id);
    const [row] = await s.pendingRows();
    expect(await s.t.query(api.managedSessions.getPendingMessagesForSession, { api_token: OWNER_TOKEN, session_id: "reg-1" })).toEqual([]);
    const res: any = await s.t.mutation(api.managedSessions.markMessageDelivered, { api_token: OWNER_TOKEN, message_id: row._id });
    expect(res.skipped).toBe(true);
    expect((await s.pendingRows())[0].status).toBe("pending");
  });
});
