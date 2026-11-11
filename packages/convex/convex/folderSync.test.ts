// Folder sync between one owner's machines: the request reaches only the
// owner's other online devices, only the owner can read the answers, and a
// discard deletes the archive the answer names.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { allModules } from "./testModules.testkit";
import { pickFolderPeers } from "./folderSync";

setDefaultTimeout(120_000);

async function setup() {
  const t = convexTest(schema, allModules);
  const now = Date.now();
  const ids = await t.run(async (ctx) => {
    const owner = await ctx.db.insert("users", { name: "Ann", email: "ann@x.dev" } as any);
    const other = await ctx.db.insert("users", { name: "Bo", email: "bo@x.dev" } as any);
    for (const [user, device_id, last_seen, label] of [
      [owner, "here", now, "MacBook-Pro-2"],
      [owner, "there", now - 1_000, "MacBook-Pro-182"],
      [owner, "asleep", now - 60 * 60_000, "Mac mini"],
      [other, "bos-mac", now, "Bo's Mac"],
    ] as const) {
      await ctx.db.insert("devices", { user_id: user, device_id, last_seen, label } as any);
    }
    const conv = await ctx.db.insert("conversations", {
      user_id: owner, agent_type: "claude_code", session_id: crypto.randomUUID(), started_at: 1, updated_at: 1,
      message_count: 0, is_private: true, status: "active", owner_device_id: "here", project_path: "/Users/ashot/src/family",
    } as any);
    return { owner, other, conv };
  });
  const as = (user: Id<"users">) => t.withIdentity({ subject: `${user}|session` });
  return { t, ...ids, as };
}

describe("pickFolderPeers", () => {
  test("online devices other than the requester, freshest first", () => {
    const now = 10_000_000;
    const peers = pickFolderPeers([
      { device_id: "a", last_seen: now - 5_000 },
      { device_id: "me", last_seen: now },
      { device_id: "b", last_seen: now - 1_000 },
      { device_id: "off", last_seen: now - 10 * 60_000 },
    ], "me", now);
    expect(peers.map((p) => p.device_id)).toEqual(["b", "a"]);
  });
});

describe("requestFolderExport", () => {
  test("asks each other online machine of the owner, once", async () => {
    const { t, owner, conv, as } = await setup();
    const asked = await as(owner).mutation(api.folderSync.requestFolderExport, { device_id: "here", conversation_id: conv, path: "/Users/ashot/src/family" });
    expect(asked.command_ids).toHaveLength(1);
    expect(Object.values(asked.labels)).toEqual(["MacBook-Pro-182"]);
    const cmd = await t.run((ctx) => ctx.db.get(asked.command_ids[0] as Id<"daemon_commands">));
    expect(cmd).toMatchObject({ command: "export_folder", target_device_id: "there", user_id: owner });
    expect(JSON.parse(cmd!.args!)).toEqual({ path: "/Users/ashot/src/family", conversation_id: conv });
  });

  test("refuses any path but the conversation's own folder", async () => {
    const { owner, conv, as } = await setup();
    for (const path of ["/Users/ashot/.ssh", "/Users/ashot", "/", "/Users/ashot/src/family/../.."]) {
      await expect(as(owner).mutation(api.folderSync.requestFolderExport, { device_id: "here", conversation_id: conv, path })).rejects.toThrow("not this conversation's folder");
    }
    const ok = await as(owner).mutation(api.folderSync.requestFolderExport, { device_id: "here", conversation_id: conv, path: "/Users/ashot/src/family/" });
    expect(ok.command_ids).toHaveLength(1);
  });

  test("refuses someone else's conversation", async () => {
    const { other, conv, as } = await setup();
    await expect(as(other).mutation(api.folderSync.requestFolderExport, { device_id: "bos-mac", conversation_id: conv, path: "/x" })).rejects.toThrow("not your conversation");
  });

  test("answers are the owner's alone, and a discard deletes the archive", async () => {
    const { t, owner, other, conv, as } = await setup();
    const asked = await as(owner).mutation(api.folderSync.requestFolderExport, { device_id: "here", conversation_id: conv, path: "/Users/ashot/src/family" });
    const id = asked.command_ids[0] as Id<"daemon_commands">;
    const storageId = await t.run((ctx) => ctx.storage.store(new Blob(["tgz"])));
    await t.run((ctx) => ctx.db.patch(id, { executed_at: Date.now(), result: JSON.stringify({ ok: true, storage_id: storageId, bytes: 3, files: 1, path: "/Users/ashot/src/family" }) }));

    const mine = await as(owner).query(api.folderSync.folderExportOutcomes, { command_ids: [id] });
    expect(mine).toEqual([expect.objectContaining({ command_id: id, label: "MacBook-Pro-182" })]);
    expect(await as(other).query(api.folderSync.folderExportOutcomes, { command_ids: [id] })).toEqual([]);

    expect(await as(other).mutation(api.folderSync.discardFolderBundle, { command_id: id })).toEqual({ discarded: false });
    expect(await t.run(async (ctx) => (await ctx.storage.get(storageId)) !== null)).toBe(true);
    expect(await as(owner).mutation(api.folderSync.discardFolderBundle, { command_id: id })).toEqual({ discarded: true });
    expect(await t.run(async (ctx) => (await ctx.storage.get(storageId)) !== null)).toBe(false);
  });
});
