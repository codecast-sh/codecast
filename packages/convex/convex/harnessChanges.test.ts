import { describe, expect, test } from "bun:test";
import { convexTest } from "convex-test";
import { hashToken } from "@platform/auth/convex";
import { api } from "./_generated/api";
import schema from "./schema";

const modules = {
  "./_generated/server.ts": () => import("./_generated/server"),
  "./harnessChanges.ts": () => import("./harnessChanges"),
  "./devices.ts": () => import("./devices"),
};
const token = "h".repeat(64);

async function seed() {
  const t = convexTest(schema, modules);
  await t.run(async (ctx) => {
    const user = await ctx.db.insert("users", { name: "Owner" } as any);
    await ctx.db.insert("api_tokens", { user_id: user, token_hash: await hashToken(token), name: "cli", created_at: Date.now(), last_used_at: Date.now() } as any);
    await ctx.db.insert("devices", { user_id: user, device_id: "mac", label: "Mac", platform: "darwin", last_seen: Date.now(), status: "online" } as any);
  });
  return t;
}

const change = (at: number, file = "~/.claude/settings.json") => ({
  at,
  file,
  action: "modified" as const,
  what: "hooks",
  why: "automatic update to v1.2.3",
  automatic: true,
  version: "1.2.3",
  bytes_before: 10,
  bytes_after: 20,
});

describe("harnessChanges", () => {
  test("a resent beat stores each change once, newest first", async () => {
    const t = await seed();
    await t.mutation(api.harnessChanges.report, { api_token: token, device_id: "mac", changes: [change(1), change(2)] });
    const again = await t.mutation(api.harnessChanges.report, { api_token: token, device_id: "mac", changes: [change(2), change(3)] });
    expect(again.inserted).toBe(1);
    const rows = await t.query(api.harnessChanges.listForDevice, { api_token: token, device_id: "mac" });
    expect(rows.map((r: any) => r.at)).toEqual([3, 2, 1]);
    expect(rows[0].why).toBe("automatic update to v1.2.3");
  });

  test("keeps the newest 300 per device", async () => {
    const t = await seed();
    for (let batch = 0; batch < 4; batch++) {
      const changes = Array.from({ length: 100 }, (_, i) => change(batch * 100 + i + 1));
      await t.mutation(api.harnessChanges.report, { api_token: token, device_id: "mac", changes });
    }
    const rows = await t.query(api.harnessChanges.listForDevice, { api_token: token, device_id: "mac", limit: 1000 });
    expect(rows.length).toBe(300);
    expect(rows[rows.length - 1].at).toBe(101);
  });

  test("another user cannot read a device's history", async () => {
    const t = await seed();
    await t.mutation(api.harnessChanges.report, { api_token: token, device_id: "mac", changes: [change(1)] });
    const rows = await t.query(api.harnessChanges.listForDevice, { api_token: "x".repeat(64), device_id: "mac" });
    expect(rows).toEqual([]);
  });
});

describe("setDeviceSnippet machine settings", () => {
  test("hooks and auto_update queue apply_snippet and mirror onto the setting, not the snippet list", async () => {
    const t = await seed();
    await t.mutation(api.devices.setDeviceSnippet, { api_token: token, device_id: "mac", snippet: "hooks", enabled: false });
    await t.mutation(api.devices.setDeviceSnippet, { api_token: token, device_id: "mac", snippet: "auto_update", enabled: false });
    const { device, commands } = await t.run(async (ctx) => ({
      device: await ctx.db.query("devices").first(),
      commands: await ctx.db.query("daemon_commands").collect(),
    }));
    expect((device as any).settings).toEqual({ hooks_enabled: false, auto_update: false });
    expect(commands.map((c: any) => [c.command, JSON.parse(c.args)])).toEqual([
      ["apply_snippet", { snippet: "hooks", enabled: false }],
      ["apply_snippet", { snippet: "auto_update", enabled: false }],
    ]);
  });
});
