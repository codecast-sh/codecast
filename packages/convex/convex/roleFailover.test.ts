// A standing session fails over on its own when its host goes quiet with work
// waiting (ct-93807). The incident: a role's standing session ran on a
// teammate's Mac, the Mac went quiet, four wakes sat undelivered until a
// person ran `cast role move` by hand.
//
//   moves       quiet past the threshold with a queued wake: the session moves
//               to the owner's cloud host, the wake goes with it, the owner
//               gets one line naming from, to, why and the billing change
//   recovers    a host back inside the threshold does not move
//   no host     nothing always-on: nothing moves, one line to the owner, once
//   nothing     a quiet host with nothing queued stays put
//   move back   always as the caller: refused onto a teammate's unshared
//               machine (naming who can) and onto a host still offline;
//               otherwise one action returns it and clears the line
// Run: bun test convex/roleFailover.test.ts
import { expect, test } from "bun:test";
import { convexTest } from "convex-test";
import { anyApi } from "convex/server";
import schema from "./schema";
import { ROLE_FAILOVER_QUIET_MS, hostTrouble, performRoleFailoverSweep, pickFailoverHost } from "./roleFailover";
import { performReparentSessionToDevice } from "./devices";
import { moveBackRefusal, roleFailoverLine, roleMoveBackState } from "@codecast/shared/contracts/roleFailover";

const MIN = 60_000;

// The modules these paths reach; the move schedules a few side effects that
// tolerate missing handlers in convex-test.
const modules = {
  "./_generated/server.ts": () => import("./_generated/server"),
  "./syncOutbox.ts": () => import("./syncOutbox"),
  "./orgRoles.ts": () => import("./orgRoles"),
  "./orgChanges.ts": () => import("./orgChanges"),
  "./roleFailover.ts": () => import("./roleFailover"),
  "./notificationRouter.ts": () => import("./notificationRouter"),
  "./notifications.ts": () => import("./notifications"),
};

async function world(opts: { macQuietMs: number; cloudHost?: boolean; queued?: boolean }) {
  const t = convexTest(schema, modules);
  const now = Date.now();
  const seed = await t.run(async (ctx) => {
    const ashot = await ctx.db.insert("users", { name: "Ashot" });
    const jason = await ctx.db.insert("users", { name: "Jason" });
    const team = await ctx.db.insert("teams", { name: "Union", features: { org: true }, invite_code: "union-failover", created_at: now });
    await ctx.db.insert("team_memberships", { team_id: team, user_id: ashot, role: "admin", joined_at: now });
    await ctx.db.insert("team_memberships", { team_id: team, user_id: jason, role: "member", joined_at: now });
    await ctx.db.insert("devices", { user_id: jason, device_id: "jason-mac", label: "Jason's MacBook", platform: "darwin", last_seen: now - opts.macQuietMs });
    if (opts.cloudHost !== false) {
      await ctx.db.insert("devices", { user_id: ashot, device_id: "cloud-1", label: "cloud-1", platform: "linux", is_remote: true, last_seen: now - 10_000 });
    }
    // Ashot's own laptop, also quiet: not always-on, never a destination.
    await ctx.db.insert("devices", { user_id: ashot, device_id: "ashot-mac", label: "Ashot's MacBook", platform: "darwin", last_seen: now - 10_000 });
    return { ashot, jason, team };
  });
  const asAshot = t.withIdentity({ subject: `${seed.ashot}|test` });
  const role = await asAshot.mutation(anyApi.orgRoles.create, { name: "Agent Quality", handle: "agent-quality", team_id: seed.team, provision: false });
  const conv = await t.run(async (ctx) => {
    const bot = await ctx.db.insert("users", { name: "Agent Quality", is_bot: true });
    const conv = await ctx.db.insert("conversations", {
      user_id: seed.jason, owner_user_id: seed.ashot, team_id: seed.team, agent_type: "claude_code", session_id: "sess-aq",
      started_at: now - 3_600_000, updated_at: now - 3_600_000, message_count: 10, is_private: false, status: "active",
      owner_device_id: "jason-mac", project_path: "/Users/jason/src/union", short_id: "jx73kh0",
    } as any);
    const anchor = await ctx.db.insert("anchors", { scope_type: "team", team_id: seed.team, bot_user_id: bot, host_user_id: seed.ashot, conversation_id: conv, name: "Agent Quality", status: "active", org_role_id: role._id, created_at: now });
    await ctx.db.patch(role._id, { anchor_id: anchor });
    await ctx.db.patch(conv, { standing_role_id: role._id, anchor_id: anchor } as any);
    if (opts.queued !== false) {
      await ctx.db.insert("pending_messages", { conversation_id: conv, from_user_id: seed.ashot, owner_user_id: seed.jason, content: "wake: check the area", status: "pending", origin: "scheduler", created_at: now - 30 * MIN, retry_count: 0 } as any);
    }
    return conv;
  });
  return { t, now, seed, role, conv, asAshot };
}

const sweep = (t: any, now: number) => t.run((ctx: any) => performRoleFailoverSweep(ctx, now));
const notices = (t: any, userId: any) => t.run(async (ctx: any) => (await ctx.db.query("notifications").collect()).filter((n: any) => n.type === "role_moved" && String(n.recipient_user_id) === String(userId)));

test("a host quiet past the threshold with a queued wake moves to the cloud host, and the wake goes with it", async () => {
  const w = await world({ macQuietMs: ROLE_FAILOVER_QUIET_MS + MIN });
  const out = await sweep(w.t, w.now);
  expect(out.outcomes).toEqual([expect.objectContaining({ handle: "agent-quality", reason: "offline", moved: true, to: "cloud-1" })]);

  const after = await w.t.run(async (ctx: any) => ({
    conv: await ctx.db.get(w.conv),
    role: await ctx.db.get(w.role._id),
    wakes: await ctx.db.query("pending_messages").collect(),
    resume: (await ctx.db.query("daemon_commands").collect()).find((c: any) => c.command === "resume_session"),
  }));
  expect(after.conv.owner_device_id).toBe("cloud-1");
  expect(String(after.conv.user_id)).toBe(String(w.seed.ashot));
  // The wake is still waiting, now for the new runner's daemon on the new host.
  expect(after.wakes).toHaveLength(1);
  expect(after.wakes[0].status).toBe("pending");
  expect(String(after.wakes[0].owner_user_id)).toBe(String(w.seed.ashot));
  expect(after.resume).toMatchObject({ target_device_id: "cloud-1" });
  expect(String(after.resume.user_id)).toBe(String(w.seed.ashot));
  expect(after.role.failover).toMatchObject({ reason: "offline", from: { device_id: "jason-mac", label: "Jason's MacBook" }, to: { device_id: "cloud-1" }, cross_user: true });

  const lines = await notices(w.t, w.seed.ashot);
  expect(lines).toHaveLength(1);
  expect(lines[0]).toMatchObject({ entity_type: "org_role", entity_id: w.role.short_id });
  expect(lines[0].message).toBe("@agent-quality moved from Jason's MacBook to cloud-1: Jason's MacBook went offline for over 1 hour with work waiting. It now runs and bills under you.");

  // The next tick leaves it alone: it is on a healthy host.
  expect((await sweep(w.t, w.now + 5 * MIN)).outcomes).toEqual([]);
  expect(await notices(w.t, w.seed.ashot)).toHaveLength(1);
});

test("a host that recovers within the threshold does not move", async () => {
  const w = await world({ macQuietMs: ROLE_FAILOVER_QUIET_MS - 2 * MIN });
  expect((await sweep(w.t, w.now)).outcomes).toEqual([]);
  const conv = await w.t.run((ctx: any) => ctx.db.get(w.conv));
  expect(conv.owner_device_id).toBe("jason-mac");
  expect(await notices(w.t, w.seed.ashot)).toHaveLength(0);
});

test("with no cloud host nothing moves, and the owner gets one line, once", async () => {
  const w = await world({ macQuietMs: ROLE_FAILOVER_QUIET_MS + MIN, cloudHost: false });
  const out = await sweep(w.t, w.now);
  expect(out.outcomes).toEqual([expect.objectContaining({ reason: "offline", moved: false })]);
  const conv = await w.t.run((ctx: any) => ctx.db.get(w.conv));
  expect(conv.owner_device_id).toBe("jason-mac");
  const lines = await notices(w.t, w.seed.ashot);
  expect(lines).toHaveLength(1);
  expect(lines[0].message).toBe("@agent-quality is stuck: Jason's MacBook went offline for over 1 hour with work waiting, and there is no always-on machine to move it to.");
  await sweep(w.t, w.now + 5 * MIN);
  expect(await notices(w.t, w.seed.ashot)).toHaveLength(1);
});

// The incident on Nov 15: a floor bump marked @agent-quality stuck, its host
// updated minutes later, and the Stuck banner stayed for 16 hours.
test("a stuck line clears once the host serves again", async () => {
  const w = await world({ macQuietMs: ROLE_FAILOVER_QUIET_MS + MIN, cloudHost: false });
  await sweep(w.t, w.now);
  expect((await w.t.run((ctx: any) => ctx.db.get(w.role._id))).failover).toMatchObject({ reason: "offline" });
  await macBack(w);
  expect((await sweep(w.t, Date.now())).outcomes).toEqual([]);
  expect((await w.t.run((ctx: any) => ctx.db.get(w.role._id))).failover).toBeUndefined();
});

test("a quiet host with nothing queued stays put", async () => {
  const w = await world({ macQuietMs: ROLE_FAILOVER_QUIET_MS + MIN, queued: false });
  expect((await sweep(w.t, w.now)).outcomes).toEqual([]);
});

// Move back always moves as the caller (review of ct-93807): a role admin
// never places a session on a teammate's machine that is not shared with them.
const failedOver = async (w: Awaited<ReturnType<typeof world>>) => {
  await sweep(w.t, w.now);
  return w.t.run(async (ctx: any) => ({ conv: await ctx.db.get(w.conv), role: await ctx.db.get(w.role._id) }));
};
const shareMac = (w: Awaited<ReturnType<typeof world>>) => w.t.run((ctx: any) => ctx.db.insert("device_shares", { user_id: w.seed.jason, device_id: "jason-mac", team_id: w.seed.team, shared_at: w.now }));
const macBack = (w: Awaited<ReturnType<typeof world>>) => w.t.run(async (ctx: any) => {
  const mac = (await ctx.db.query("devices").collect()).find((d: any) => d.device_id === "jason-mac");
  await ctx.db.patch(mac._id, { last_seen: Date.now() });
});

test("move back to a teammate's unshared machine is refused, naming who can", async () => {
  const w = await world({ macQuietMs: ROLE_FAILOVER_QUIET_MS + MIN });
  const before = await failedOver(w);
  await macBack(w);
  await expect(w.asAshot.mutation(anyApi.roleFailover.moveBack, { role_id: String(w.role._id) })).rejects.toThrow("Only Jason can move it back to Jason's MacBook");
  const after = await w.t.run(async (ctx: any) => ({ conv: await ctx.db.get(w.conv), role: await ctx.db.get(w.role._id) }));
  expect(after.conv.owner_device_id).toBe("cloud-1");
  expect(String(after.conv.user_id)).toBe(String(w.seed.ashot));
  expect(after.role.failover).toEqual(before.role.failover);
});

test("move back onto a host still past the quiet threshold is refused", async () => {
  const w = await world({ macQuietMs: ROLE_FAILOVER_QUIET_MS + MIN });
  await failedOver(w);
  await shareMac(w);
  await expect(w.asAshot.mutation(anyApi.roleFailover.moveBack, { role_id: String(w.role._id) })).rejects.toThrow("Jason's MacBook is still offline");
  const conv = await w.t.run((ctx: any) => ctx.db.get(w.conv));
  expect(conv.owner_device_id).toBe("cloud-1");
});

test("move back is one action once the host is back and the caller may use it", async () => {
  const w = await world({ macQuietMs: ROLE_FAILOVER_QUIET_MS + MIN });
  await failedOver(w);
  await shareMac(w);
  await macBack(w);
  await w.asAshot.mutation(anyApi.roleFailover.moveBack, { role_id: String(w.role._id) });
  const after = await w.t.run(async (ctx: any) => ({ conv: await ctx.db.get(w.conv), role: await ctx.db.get(w.role._id) }));
  expect(after.conv.owner_device_id).toBe("jason-mac");
  // Account follows device: on a shared machine it runs under the machine's account again.
  expect(String(after.conv.user_id)).toBe(String(w.seed.jason));
  expect(after.role.failover).toBeUndefined();
  await expect(w.asAshot.mutation(anyApi.roleFailover.moveBack, { role_id: String(w.role._id) })).rejects.toThrow(/no failover/);
});

test("the prior runner, not an admin, moves it back onto their own Mac", async () => {
  const w = await world({ macQuietMs: ROLE_FAILOVER_QUIET_MS + MIN });
  await failedOver(w);
  await macBack(w);
  const asJason = w.t.withIdentity({ subject: `${w.seed.jason}|test` });
  // Jason is a plain member: the role's other moves stay closed to him.
  await expect(asJason.mutation(anyApi.orgRoles.move, { role_id: String(w.role._id), device_id: "jason-mac" })).rejects.toThrow(/Only an admin/);
  await asJason.mutation(anyApi.roleFailover.moveBack, { role_id: String(w.role._id) });
  const after = await w.t.run(async (ctx: any) => ({ conv: await ctx.db.get(w.conv), role: await ctx.db.get(w.role._id) }));
  expect(after.conv.owner_device_id).toBe("jason-mac");
  expect(String(after.conv.user_id)).toBe(String(w.seed.jason));
  expect(after.role.failover).toBeUndefined();
});

test("keep here leaves the session where the move put it and clears the line", async () => {
  const w = await world({ macQuietMs: ROLE_FAILOVER_QUIET_MS + MIN });
  await failedOver(w);
  const asJason = w.t.withIdentity({ subject: `${w.seed.jason}|test` });
  await asJason.mutation(anyApi.roleFailover.keepHere, { role_id: String(w.role._id) });
  const after = await w.t.run(async (ctx: any) => ({ conv: await ctx.db.get(w.conv), role: await ctx.db.get(w.role._id) }));
  expect(after.conv.owner_device_id).toBe("cloud-1");
  expect(after.role.failover).toBeUndefined();
  await expect(w.asAshot.mutation(anyApi.roleFailover.keepHere, { role_id: String(w.role._id) })).rejects.toThrow(/no failover/);
});

// Sprout (Nov 2026): after the sweep moved it, other moves took the session
// elsewhere and the Moved line kept naming a host it no longer ran on.
test("moving the session anywhere but the failover's host clears the line", async () => {
  const w = await world({ macQuietMs: ROLE_FAILOVER_QUIET_MS + MIN });
  expect((await failedOver(w)).role.failover).toMatchObject({ to: { device_id: "cloud-1" } });
  await w.t.run((ctx: any) => performReparentSessionToDevice(ctx, w.seed.ashot, { session_id: String(w.conv), device_id: "cloud-1" }));
  expect((await w.t.run((ctx: any) => ctx.db.get(w.role._id))).failover).toMatchObject({ to: { device_id: "cloud-1" } });
  await w.t.run((ctx: any) => performReparentSessionToDevice(ctx, w.seed.ashot, { session_id: String(w.conv), device_id: "ashot-mac" }));
  expect((await w.t.run((ctx: any) => ctx.db.get(w.role._id))).failover).toBeUndefined();
});

test("roleMoveBackState: only a host the viewer may use, and only once it is back", () => {
  const now = 10_000_000;
  const f = { at: 0, reason: "offline" as const, owner_user_id: "a", from: { device_id: "mac", label: "Mac", user_id: "j" }, to: { device_id: "c", label: "c", user_id: "a" } };
  expect(roleMoveBackState(f, [], now)).toBe("not_yours");
  // Same device id under another account is not that machine.
  expect(roleMoveBackState(f, [{ device_id: "mac", user_id: "a", last_seen: now }], now)).toBe("not_yours");
  expect(roleMoveBackState(f, [{ device_id: "mac", user_id: "j", last_seen: now - ROLE_FAILOVER_QUIET_MS }], now)).toBe("offline");
  expect(roleMoveBackState(f, [{ device_id: "mac", user_id: "j", last_seen: now - MIN }], now)).toBe("ok");
  expect(moveBackRefusal(f, "not_yours", () => "Jason")).toBe("Only Jason can move it back to Mac");
  expect(moveBackRefusal(f, "offline", () => "Jason")).toBe("Mac is still offline");
});

test("hostTrouble folds in the unhealthy-host checks", () => {
  const now = 10_000_000;
  const up = { device_id: "d", last_seen: now - 1000 };
  const opts = { now, roster: [], minCliVersion: "1.5.0", lastFailoverAt: 0 };
  expect(hostTrouble(up, {}, opts)).toBeNull();
  expect(hostTrouble({ ...up, cli_version: "1.4.9" }, {}, opts)).toBe("below_floor");
  expect(hostTrouble({ ...up, loop_freeze_1h_ms: 130_000 }, {}, opts)).toBe("freezing");
  expect(hostTrouble(up, { pane_refused_at: now - 5000 }, opts)).toBe("pane_refused");
  // A refusal from before the last failover is already handled.
  expect(hostTrouble(up, { pane_refused_at: now - 5000 }, { ...opts, lastFailoverAt: now - 1000 })).toBeNull();
  // A sleeping cloud host that queued work boots is not down.
  const managed = { device_id: "c", last_seen: now - 2 * ROLE_FAILOVER_QUIET_MS, is_remote: true, platform: "linux", cloud_host: { managed_by: "lap", state: "stopped", at: now - 1000 } };
  expect(hostTrouble(managed, {}, opts)).toBeNull();
  expect(hostTrouble({ ...managed, cloud_wake: { status: "failed" } }, {}, opts)).toBe("offline");
});

test("pickFailoverHost takes the healthiest always-on machine", () => {
  const now = 10_000_000;
  const a = { device_id: "a", last_seen: now - 1000, is_remote: true, platform: "linux", loop_freeze_1h_ms: 50_000 };
  const b = { device_id: "b", last_seen: now - 5000, is_remote: true, platform: "linux", loop_freeze_1h_ms: 1000 };
  const laptop = { device_id: "l", last_seen: now, platform: "darwin" };
  const old = { device_id: "o", last_seen: now, is_remote: true, platform: "linux", cli_version: "1.0.0" };
  const opts = { now, minCliVersion: "1.5.0" };
  expect(pickFailoverHost([a, b, laptop, old], "x", opts)?.device_id).toBe("b");
  expect(pickFailoverHost([a, b], "b", opts)?.device_id).toBe("a");
  expect(pickFailoverHost([laptop, old], "x", opts)).toBeNull();
});

test("the line names the account when the move changed it", () => {
  const f = { at: 0, reason: "offline" as const, owner_user_id: "u1", from: { device_id: "m", label: "Mac", user_id: "u2" }, to: { device_id: "c", label: "cloud-1", user_id: "u3" }, cross_user: true };
  expect(roleFailoverLine("eng", f, "u1", () => "Dana")).toContain("It now runs and bills under Dana.");
  expect(roleFailoverLine("eng", { ...f, cross_user: false }, "u1", () => "Dana")).not.toContain("bills");
});

test("a standing session that is a registered one is never failed over", async () => {
  const w = await world({ macQuietMs: ROLE_FAILOVER_QUIET_MS + MIN });
  await w.t.run((ctx: any) => ctx.db.patch(w.conv, { register_only: true }));
  const out = await sweep(w.t, w.now);
  expect(out.outcomes).toEqual([]);
  expect((await w.t.run((ctx: any) => ctx.db.get(w.conv))).owner_device_id).toBe("jason-mac");
  expect(await notices(w.t, w.seed.ashot)).toEqual([]);
});
