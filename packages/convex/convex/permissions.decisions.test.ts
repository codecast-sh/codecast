// A permission answer carries more than approve/deny: a denial's reason and an
// approval that keeps Claude's suggested rules. And a prompt whose machine
// stopped beating is expired so Needs Input does not keep asking.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { PERMISSION_DEVICE_LAPSE_MS } from "./permissions";

setDefaultTimeout(60_000);

const modules = {
  "./_generated/server.ts": () => import("./_generated/server"),
  "./permissions.ts": () => import("./permissions"),
  "./syncOutbox.ts": () => import("./syncOutbox"),
};

const RULE = { type: "addRules", rules: [{ toolName: "Bash", ruleContent: "bun test:*" }], behavior: "allow", destination: "localSettings" };

async function setup() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const owner = await ctx.db.insert("users", { email: "o@x", name: "Owner", last_heartbeat: Date.now() } as any);
    const conv = await ctx.db.insert("conversations", {
      session_id: "s1", user_id: owner, owner_device_id: "dev-1", is_private: true, title: "x", created_at: 1, updated_at: 1,
    } as any);
    const device = await ctx.db.insert("devices", { user_id: owner, device_id: "dev-1", last_seen: Date.now() } as any);
    return { owner, conv, device };
  });
  const { api, internal } = await import("./_generated/api");
  const asOwner = t.withIdentity({ subject: `${ids.owner}|x` } as any);
  const insert = (over: Record<string, any> = {}) =>
    t.run((ctx) => ctx.db.insert("pending_permissions", {
      conversation_id: ids.conv, session_id: "s1", tool_name: "Bash", arguments_preview: "bun test", status: "pending",
      created_at: Date.now(), owner_user_id: ids.owner, ...over,
    } as any));
  const get = (id: any) => t.run((ctx) => ctx.db.get(id)) as Promise<any>;
  return { t, ids, api, internal, asOwner, insert, get };
}

describe("permission answers", () => {
  test("a denial keeps its reason and the daemon reads it back", async () => {
    const { api, asOwner, insert, get } = await setup();
    const id = await insert();
    await asOwner.mutation(api.permissions.updatePermissionStatus, { permission_id: id, status: "denied", message: "  use bun test --watch instead " });
    expect((await get(id)).deny_message).toBe("use bun test --watch instead");
    const decision = await asOwner.query(api.permissions.getPermissionDecision, { session_id: "s1", permission_id: id });
    expect(decision).toMatchObject({ status: "denied", deny_message: "use bun test --watch instead" });
  });

  test("remember sticks only to an approval of a row with suggestions", async () => {
    const { api, asOwner, insert, get } = await setup();
    const withRules = await insert({ suggestions: [RULE] });
    const bare = await insert({ arguments_preview: "other" });
    await asOwner.mutation(api.permissions.updatePermissionStatus, { permission_id: withRules, status: "approved", remember: true });
    await asOwner.mutation(api.permissions.updatePermissionStatus, { permission_id: bare, status: "approved", remember: true });
    expect((await get(withRules)).remember).toBe(true);
    expect((await get(bare)).remember).toBeUndefined();
    const responded = await asOwner.query(api.permissions.getAllRespondedPermissions, { user_id: "" + (await get(withRules)).owner_user_id });
    expect(responded.find((p: any) => p._id === withRules)).toMatchObject({ status: "approved", remember: true, session_id: "s1" });
  });

  test("createPermissionRequest stores the suggestions it was given", async () => {
    const { api, ids, asOwner, get } = await setup();
    const id = await asOwner.mutation(api.permissions.createPermissionRequest, {
      conversation_id: ids.conv, session_id: "s1", tool_name: "Bash", arguments_preview: "bun test", suggestions: [RULE],
    });
    expect((await get(id)).suggestions).toEqual([RULE]);
  });
});

describe("expireOfflinePermissions", () => {
  test("cancels pending prompts of a device that stopped beating, leaves live ones", async () => {
    const { t, ids, internal, insert, get } = await setup();
    const live = await insert();
    expect(await t.mutation(internal.permissions.expireOfflinePermissions, {})).toEqual({ expired: 0, pending: 1 });
    expect((await get(live)).status).toBe("pending");

    await t.run((ctx) => ctx.db.patch(ids.device, { last_seen: Date.now() - PERMISSION_DEVICE_LAPSE_MS - 1000 }));
    expect(await t.mutation(internal.permissions.expireOfflinePermissions, {})).toEqual({ expired: 1, pending: 1 });
    const row = await get(live);
    expect(row.status).toBe("cancelled");
    expect(row.resolved_at).toBeGreaterThan(0);
  });

  test("a conversation with no device falls back to the owner's heartbeat", async () => {
    const { t, ids, internal, insert, get } = await setup();
    await t.run((ctx) => ctx.db.patch(ids.conv, { owner_device_id: undefined } as any));
    const id = await insert();
    await t.mutation(internal.permissions.expireOfflinePermissions, {});
    expect((await get(id)).status).toBe("pending");
    await t.run((ctx) => ctx.db.patch(ids.owner, { last_heartbeat: Date.now() - PERMISSION_DEVICE_LAPSE_MS - 1000 } as any));
    await t.mutation(internal.permissions.expireOfflinePermissions, {});
    expect((await get(id)).status).toBe("cancelled");
  });
});
