import { expect, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { makeFunctionReference } from "convex/server";
const listMine = makeFunctionReference<"query">("machineResources:listMine");
import { hashToken } from "./apiTokens";
import { storeResourceSnapshot } from "./machineResources";
import type { MachineResourceSnapshot } from "@codecast/shared/contracts";

const modules = { "./_generated/server.ts": () => import("./_generated/server"), "./machineResources.ts": () => import("./machineResources") };
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
  expect(await t.run(ctx => storeResourceSnapshot(ctx, owner, sample(now), now + 100))).toEqual({ accepted: false });
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
  expect(await t.mutation(report, { api_token: token, snapshot: sample(now) })).toEqual({ accepted: true });
  expect((await t.withIdentity({ subject: user }).query(listMine, {}))[0].snapshot).toEqual(sample(now));
});
