import { expect, test } from "bun:test";
import { convexTest } from "convex-test";
import { makeFunctionReference } from "convex/server";
import schema from "./schema";
import { storeResourceSnapshot } from "./machineResources";
import type { MachineResourceSnapshot } from "@codecast/shared/contracts";

const start = makeFunctionReference<"mutation">("resourceOffload:start");
const modules = { "./_generated/server.ts": () => import("./_generated/server"), "./resourceOffload.ts": () => import("./resourceOffload"), "./sessionMigrations.ts": () => import("./sessionMigrations") };
async function setup() {
  const t = convexTest(schema, modules);
  const now = Date.now();
  const data = await t.run(async ctx => {
    const user = await ctx.db.insert("users", {});
    const other = await ctx.db.insert("users", {});
    await ctx.db.insert("devices", { user_id: user, device_id: "mac", label: "Mac", platform: "darwin", last_seen: now });
    const target = await ctx.db.insert("devices", { user_id: user, device_id: "linux", label: "Linux", platform: "linux", is_remote: true, last_seen: now });
    const conv = await ctx.db.insert("conversations", { user_id: user, session_id: "s1", owner_device_id: "mac", agent_type: "claude_code", status: "active", is_private: true, message_count: 1, started_at: now, updated_at: now });
    const snapshot: MachineResourceSnapshot = { version: 1, deviceId: "mac", platform: "darwin", sample: { at: now, memoryTotal: 10000, memoryAvailable: 5000, memoryAvailableIsEstimate: true, pressure: "normal", load1: 100, logicalCpus: 8, processCount: 1 }, processes: [{ pid: 123, ppid: 1, name: "claude", kind: "agent", cpu: 20, rss: 100, sessionId: "s1" }], groups: [{ kind: "agent", cpu: 20, rss: 100, processCount: 1 }], omittedProcessCount: 0, collectionDurationMs: 1, limitations: [] };
    await storeResourceSnapshot(ctx, user, snapshot, now);
    return { user, other, conv, target, snapshot };
  });
  const args = { source_device_id: "mac", wait_for_idle_ms: 60_000, selections: [{ conversation_id: data.conv, session_id: "s1", destination_id: "linux", attested: [] as string[] }] };
  return { t, authed: t.withIdentity({ subject: data.user }), args, ...data };
}

test("authenticated preflight writes nothing; attested start produces only safe batches", async () => {
  const { t, authed, args, other } = await setup();
  await expect(t.mutation(start, args)).rejects.toThrow("Authentication required");
  await expect(t.withIdentity({ subject: other }).mutation(start, args)).rejects.toThrow("source laptop");
  const preview = await authed.mutation(start, { ...args, dry_run: true });
  expect(preview.checks[0].blockers).toEqual([]);
  expect(preview.checks[0].pending.length).toBeGreaterThan(0);
  expect(await t.run(ctx => ctx.db.query("migration_batches").collect())).toEqual([]);
  await expect(authed.mutation(start, args)).rejects.toThrow("Confirm:");
  args.selections[0].attested = preview.checks[0].pending;
  const run = await authed.mutation(start, args);
  expect(run.batches).toHaveLength(1);
  await expect(authed.mutation(start, args)).rejects.toThrow("queued or active move");
  expect((await t.run(ctx => ctx.db.query("migration_batches").collect()))[0].interrupt_on_timeout).toBe(false);
  expect((await t.run(ctx => ctx.db.query("session_migrations").collect()))[0].status).toBe("queued");
});

test("a pin or host failure after preview cannot be overridden by attestations", async () => {
  const { t, authed, args, conv, target } = await setup();
  args.selections[0].attested = (await authed.mutation(start, { ...args, dry_run: true })).checks[0].pending;
  await t.run(ctx => ctx.db.patch(conv, { inbox_pinned_at: Date.now() }));
  await expect(authed.mutation(start, args)).rejects.toThrow("Pinned");
  await t.run(async ctx => {
    await ctx.db.patch(conv, { inbox_pinned_at: undefined });
    await ctx.db.patch(target, { host_readiness: { at: Date.now(), setup: { ok: false, error: "service failed" } } });
  });
  await expect(authed.mutation(start, args)).rejects.toThrow("Host setup failed");
  expect(await t.run(ctx => ctx.db.query("migration_batches").collect())).toEqual([]);
});

test("stale resource evidence and duplicate selections cannot start a transfer", async () => {
  const { t, authed, args } = await setup();
  await expect(authed.mutation(start, { ...args, selections: [...args.selections, ...args.selections] })).rejects.toThrow("once");
  await t.run(async ctx => {
    const report = (await ctx.db.query("machine_resources").collect())[0];
    await ctx.db.patch(report._id, { received_at: Date.now() - 300000 });
  });
  await expect(authed.mutation(start, args)).rejects.toThrow("Refresh");
});

test("live children and combined destination memory prevent unsafe bulk starts", async () => {
  const { t, authed, args, conv, user, snapshot } = await setup();
  const child = await t.run(ctx => ctx.db.insert("conversations", { user_id: user, session_id: "child", parent_conversation_id: conv, is_subagent: true, agent_type: "claude_code", status: "active", is_private: true, message_count: 0, started_at: Date.now(), updated_at: Date.now() }));
  expect((await authed.mutation(start, { ...args, dry_run: true })).checks[0].blockers.join()).toContain("unfinished subagents");
  const second = await t.run(async ctx => {
    await ctx.db.patch(child, { status: "completed" });
    const second = await ctx.db.insert("conversations", { user_id: user, session_id: "s2", owner_device_id: "mac", agent_type: "claude_code", status: "active", is_private: true, message_count: 1, started_at: Date.now(), updated_at: Date.now() });
    const report = (await ctx.db.query("machine_resources").collect())[0];
    await ctx.db.patch(report._id, { snapshot: { ...snapshot, processes: [...snapshot.processes, { ...snapshot.processes[0], pid: 124, sessionId: "s2" }] } });
    await storeResourceSnapshot(ctx, user, { ...snapshot, deviceId: "linux", platform: "linux", processes: [], sample: { ...snapshot.sample, memoryAvailable: 150 } });
    return second;
  });
  args.selections.push({ conversation_id: second, session_id: "s2", destination_id: "linux", attested: [] });
  const preview = await authed.mutation(start, { ...args, dry_run: true });
  expect(preview.checks.every((c: any) => c.blockers.some((b: string) => b.includes("selected group")))).toBe(true);
  expect(await t.run(ctx => ctx.db.query("migration_batches").collect())).toEqual([]);
});


test("an older runner cannot claim destination continuation before resume executes", async () => {
  const { t, authed, args } = await setup();
  args.selections[0].attested = (await authed.mutation(start, { ...args, dry_run: true })).checks[0].pending;
  await authed.mutation(start, args);
  const migration = await t.run(async ctx => {
    const row = (await ctx.db.query("session_migrations").collect())[0];
    await ctx.db.patch(row._id, { status: "resuming" });
    return row._id;
  });
  const confirm = makeFunctionReference<"mutation">("sessionMigrations:confirmSession");
  expect(await authed.mutation(confirm, { migration_id: migration, ok: true })).toMatchObject({ status: "failed" });
  expect((await t.run(ctx => ctx.db.get(migration)))?.error).toContain("continuation was not confirmed");
});
