import { expect, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { makeFunctionReference } from "convex/server";
const listMine = makeFunctionReference<"query">("machineResources:listMine");
import { hashToken } from "./apiTokens";
import { OVERLOAD_REALERT_MS, overloadAlertDue, overloadMessage, storeResourceSnapshot } from "./machineResources";
import type { MachineResourceSnapshot } from "@codecast/shared/contracts";

const modules = {

  "./_generated/server.ts": () => import("./_generated/server"),

  "./syncOutbox.ts": () => import("./syncOutbox"), "./machineResources.ts": () => import("./machineResources"),

};
const sample = (at: number): MachineResourceSnapshot => ({
  version: 1, deviceId: "mac", platform: "darwin", collectionDurationMs: 4, limitations: [], processes: [], groups: [], omittedProcessCount: 0,
  sample: { at, memoryTotal: 1000, memoryAvailable: 500, memoryAvailableIsEstimate: true, load1: 2, logicalCpus: 8, processCount: 20, pressure: "normal" },
});

test("resource report to authenticated read uses real schema and isolates machine owner", async () => {
  const t = convexTest(schema, modules);
  const now = Date.now();
  const [owner, other] = await t.run(async ctx => {
    const owner = await ctx.db.insert("users", { name: "Owner" });
    const other = await ctx.db.insert("users", { name: "Other" });
    await ctx.db.insert("devices", { user_id: owner, device_id: "mac", label: "Mac", platform: "darwin", last_seen: now });
    return [owner, other];
  });
  await t.run(ctx => storeResourceSnapshot(ctx, owner, sample(now), now));
  expect(await t.query(listMine, {})).toEqual([]);
  expect(await t.withIdentity({ subject: other }).query(listMine, {})).toEqual([]);
  const rows = await t.withIdentity({ subject: owner }).query(listMine, {});
  expect(rows).toHaveLength(1);
  expect(rows[0].snapshot.sample.memoryTotal).toBe(1000);
  expect(rows[0].history).toHaveLength(1);
  await expect(t.run(ctx => storeResourceSnapshot(ctx, other, sample(now), now))).rejects.toThrow("not registered");
  expect(await t.run(ctx => storeResourceSnapshot(ctx, owner, sample(now), now + 100))).toEqual({ accepted: false, background_sessions: [] });
  await t.run(ctx => storeResourceSnapshot(ctx, owner, sample(now + 30_000), now + 30_000));
  expect((await t.withIdentity({ subject: owner }).query(listMine, {}))[0].history).toHaveLength(2);
});

test("malformed or oversized reports cannot overwrite the last good reading", async () => {
  const t = convexTest(schema, modules);
  const now = Date.now();
  const user = await t.run(async ctx => {
    const id = await ctx.db.insert("users", {});
    await ctx.db.insert("devices", { user_id: id, device_id: "mac", label: "Mac", platform: "darwin", last_seen: now });
    return id;
  });
  await t.run(ctx => storeResourceSnapshot(ctx, user, sample(now), now));
  for (const invalid of [
    { ...sample(now), sample: { ...sample(now).sample, cpuPercent: 101 } },
    { ...sample(now), limitations: ["x".repeat(241)] },
    sample(now - 600_000),
  ]) await expect(t.run(ctx => storeResourceSnapshot(ctx, user, invalid, now))).rejects.toThrow();
  expect((await t.withIdentity({ subject: user }).query(listMine, {}))[0].snapshot).toEqual(sample(now));
});


test("daemon bearer report reaches the authenticated dashboard and rejects invalid tokens", async () => {
  const t = convexTest(schema, modules);
  const now = Date.now();
  const token = "resource-test-token";
  const user = await t.run(async ctx => {
    const id = await ctx.db.insert("users", {});
    await ctx.db.insert("devices", { user_id: id, device_id: "mac", label: "Mac", platform: "darwin", last_seen: now });
    await ctx.db.insert("api_tokens", { user_id: id, token_hash: await hashToken(token), name: "test", created_at: now, last_used_at: now });
    return id;
  });
  const report = makeFunctionReference<"mutation">("machineResources:report");
  await expect(t.mutation(report, { api_token: "invalid", snapshot: sample(now) })).rejects.toThrow("Authentication");
  expect(await t.mutation(report, { api_token: token, snapshot: sample(now) })).toEqual({ accepted: true, background_sessions: [] });
  expect((await t.withIdentity({ subject: user }).query(listMine, {}))[0].snapshot).toEqual(sample(now));
});

// The press is stored on the machine's row and answered to its daemon on the
// next report, throttled or not, so a render it cannot move gives way within a tick.
test("a session put at background priority reaches its machine's daemon in the next report answer, and comes back out", async () => {
  const t = convexTest(schema, modules);
  const now = Date.now();
  const token = "resource-bg-token";
  const user = await t.run(async ctx => {
    const id = await ctx.db.insert("users", {});
    await ctx.db.insert("devices", { user_id: id, device_id: "mac", label: "Mac", platform: "darwin", last_seen: now });
    await ctx.db.insert("api_tokens", { user_id: id, token_hash: await hashToken(token), name: "test", created_at: now, last_used_at: now });
    return id;
  });
  const report = makeFunctionReference<"mutation">("machineResources:report");
  const setBackground = makeFunctionReference<"mutation">("machineResources:setSessionBackground");
  const as = t.withIdentity({ subject: user });
  await expect(as.mutation(setBackground, { device_id: "mac", session_id: "s1", background: true })).rejects.toThrow("not reported");
  await t.mutation(report, { api_token: token, snapshot: sample(now) });
  await as.mutation(setBackground, { device_id: "mac", session_id: "s1", background: true });
  await as.mutation(setBackground, { device_id: "mac", session_id: "s1", background: true });
  expect(await t.mutation(report, { api_token: token, snapshot: sample(now + 1) })).toEqual({ accepted: false, background_sessions: ["s1"] });
  await expect(t.withIdentity({ subject: "someone-else" as any }).mutation(setBackground, { device_id: "mac", session_id: "s2", background: true })).rejects.toThrow();
  await as.mutation(setBackground, { device_id: "mac", session_id: "s1", background: false });
  expect((await as.query(listMine, {}))[0].background_sessions).toEqual([]);
});

test("an overload incident rings once when it starts, again only when it turns critical or after a quiet spell", () => {
  const now = 10 * 3600_000;
  const elevated = { level: "elevated" as const, since: now - 3 * 60_000, reason: "CPU use has stayed above 90%" };
  expect(overloadAlertDue(null, undefined, now)).toBeNull();
  expect(overloadAlertDue(elevated, undefined, now)).toEqual(elevated);
  const rang = { since: elevated.since, level: "elevated" as const, at: now };
  expect(overloadAlertDue(elevated, rang, now + 60_000)).toBeNull();
  expect(overloadAlertDue({ ...elevated, level: "critical" }, rang, now + 60_000)?.level).toBe("critical");
  const next = { ...elevated, since: now + 5 * 60_000 };
  expect(overloadAlertDue(next, rang, now + 8 * 60_000)).toBeNull();
  expect(overloadAlertDue(next, rang, now + OVERLOAD_REALERT_MS)).toEqual(next);
});

test("the overload message names the cause, the vitals and the heaviest sessions", () => {
  const now = 10 * 3600_000;
  const words = overloadMessage({
    machine: "MacBook-Pro-182",
    incident: { level: "elevated", since: now - 4 * 60_000, reason: "CPU use has stayed above 90%" },
    sample: { at: now, cpuPercent: 96, memoryTotal: 128 * 2 ** 30, memoryAvailable: 34.5 * 2 ** 30, memoryAvailableIsEstimate: true, pressure: "normal", load1: 110, logicalCpus: 16 },
    top: [{ title: "Agent feedback controls", cpu: 860, rss: 1.1 * 2 ** 30 }, { title: "Website warm cards", cpu: 40, rss: 684 * 2 ** 20 }],
    now,
  });
  expect(words.message).toBe("MacBook-Pro-182 is overloaded. CPU use has stayed above 90% for 4 min. CPU 96%, memory 93.5 GB of 128 GB. Heaviest: Agent feedback controls (8.6 cores, 1.1 GB); Website warm cards (40%, 684 MB). Open it to move load to the cloud.");
  expect(words.subtitle).toBe("CPU use has stayed above 90% for 4 min");
});

test("a laptop's sustained overload rings once from the sample that confirms it", async () => {
  const t = convexTest(schema, modules);
  const start = Date.now() - 10 * 60_000;
  const user = await t.run(async ctx => {
    const id = await ctx.db.insert("users", { name: "Owner" });
    await ctx.db.insert("devices", { user_id: id, device_id: "mac", label: "macOS - MacBook-Pro-182", platform: "darwin", last_seen: start });
    return id;
  });
  const hot = (at: number): MachineResourceSnapshot => ({ ...sample(at), sample: { ...sample(at).sample, cpuPercent: 97 } });
  for (let i = 0; i <= 10; i++) {
    const at = start + i * 30_000;
    await t.run(ctx => storeResourceSnapshot(ctx, user, hot(at), at));
  }
  const rows = await t.run(ctx => ctx.db.query("notifications").collect());
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ type: "machine_overloaded", entity_type: "machine", entity_id: "mac" });
  expect(rows[0].message).toStartWith("MacBook-Pro-182 is overloaded. CPU use has stayed above 90%");
});
