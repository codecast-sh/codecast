// Carrying a session's transcript between one owner's machines: the request
// names only the conversation, reaches only the owner's other online machines,
// and its answers and archives are the owner's alone and never mix with
// folder exports.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { allModules } from "./testModules.testkit";

setDefaultTimeout(120_000);

const REQUESTER = { ip: "100.64.0.1", name: "mbp.tail1.ts.net." };
const HASH = "a".repeat(64);

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
      message_count: 0, is_private: true, status: "active", owner_device_id: "here", project_path: "/Users/ann/src/family",
    } as any);
    return { owner, other, conv };
  });
  const as = (user: Id<"users">) => t.withIdentity({ subject: `${user}|session` });
  const argsOf = async (id: string) => JSON.parse((await t.run((ctx) => ctx.db.get(id as Id<"daemon_commands">)))!.args!);
  const setDevice = (device_id: string, patch: Record<string, unknown>) => t.run(async (ctx) => {
    const d = await ctx.db.query("devices").filter((q) => q.eq(q.field("device_id"), device_id)).first();
    await ctx.db.patch(d!._id, patch as any);
  });
  return { t, ...ids, as, argsOf, setDevice };
}

describe("requestSessionExport", () => {
  test("asks each other online machine of the owner with the conversation only", async () => {
    const { t, owner, conv, as, argsOf } = await setup();
    const asked = await as(owner).mutation(api.sessionTransfer.requestSessionExport, { device_id: "here", conversation_id: conv });
    expect(Object.values(asked.labels)).toEqual(["MacBook-Pro-182"]);
    const cmd = await t.run((ctx) => ctx.db.get(asked.command_ids[0] as Id<"daemon_commands">));
    expect(cmd).toMatchObject({ command: "export_session", target_device_id: "there", user_id: owner });
    const session_id = (await t.run((ctx) => ctx.db.get(conv)))!.session_id;
    expect(await argsOf(asked.command_ids[0])).toEqual({ session_id, conversation_id: conv, requester: "here" });
  });

  test("names the conversation's own session and its newest synced message", async () => {
    const { t, owner, conv, as, argsOf } = await setup();
    const [older, newer] = [crypto.randomUUID(), crypto.randomUUID()];
    await t.run(async (ctx) => {
      for (const [timestamp, message_uuid] of [[1, older], [2, newer], [3, undefined]] as const) {
        await ctx.db.insert("messages", { conversation_id: conv, role: "user", content: "hi", timestamp, ...(message_uuid ? { message_uuid } : {}) } as any);
      }
    });
    const asked = await as(owner).mutation(api.sessionTransfer.requestSessionExport, { device_id: "here", conversation_id: conv });
    expect(await argsOf(asked.command_ids[0])).toMatchObject({ last_uuid: newer });
    await expect(as(owner).mutation(api.sessionTransfer.requestSessionExport, { device_id: "here", conversation_id: conv, session_id: crypto.randomUUID() } as any)).rejects.toThrow();
  });

  test("the newest message a transcript can hold, never a server-minted divider", async () => {
    const { t, owner, conv, as, argsOf } = await setup();
    const u = crypto.randomUUID();
    await t.run(async (ctx) => {
      await ctx.db.insert("messages", { conversation_id: conv, role: "assistant", content: "done", timestamp: 1, message_uuid: u } as any);
      for (const [timestamp, subtype] of [[2, "agent_switch"], [3, "machine_switch"]] as const) {
        await ctx.db.insert("messages", { conversation_id: conv, role: "user", content: "moved", subtype, timestamp, message_uuid: crypto.randomUUID() } as any);
      }
      await ctx.db.insert("messages", { conversation_id: conv, role: "assistant", content: "x", timestamp: 4, message_uuid: "stopped:turn1" } as any);
    });
    const asked = await as(owner).mutation(api.sessionTransfer.requestSessionExport, { device_id: "here", conversation_id: conv });
    expect(await argsOf(asked.command_ids[0])).toMatchObject({ last_uuid: u });
  });

  test("refuses a conversation whose session id is not a UUID", async () => {
    const { t, owner, conv, as } = await setup();
    await t.run((ctx) => ctx.db.patch(conv, { session_id: "forked-123" } as any));
    await expect(as(owner).mutation(api.sessionTransfer.requestSessionExport, { device_id: "here", conversation_id: conv })).rejects.toThrow("no transcript");
  });

  test("refuses someone else's conversation and a requester that is not the owner's machine", async () => {
    const { owner, other, conv, as } = await setup();
    await expect(as(other).mutation(api.sessionTransfer.requestSessionExport, { device_id: "bos-mac", conversation_id: conv })).rejects.toThrow("not your conversation");
    await expect(as(owner).mutation(api.sessionTransfer.requestSessionExport, { device_id: "bos-mac", conversation_id: conv })).rejects.toThrow("not one of your machines");
  });

  test("refuses a path smuggled into the args", async () => {
    const { owner, conv, as } = await setup();
    await expect(as(owner).mutation(api.sessionTransfer.requestSessionExport, { device_id: "here", conversation_id: conv, path: "/Users/ann/.ssh" } as any)).rejects.toThrow();
  });

  test("a direct grant only with both fields and neither machine opted out", async () => {
    const { t, owner, conv, as, argsOf, setDevice } = await setup();
    const ask = (extra: Record<string, unknown> = {}) => as(owner).mutation(api.sessionTransfer.requestSessionExport, { device_id: "here", conversation_id: conv, ...extra } as any);
    const done = (ids: string[]) => t.run(async (ctx) => { for (const id of ids) await ctx.db.patch(id as Id<"daemon_commands">, { executed_at: Date.now() }); });
    const granted = await ask({ tailnet: REQUESTER, token_hash: HASH });
    expect((await argsOf(granted.command_ids[0])).direct).toEqual({ requester: REQUESTER, token_hash: HASH });
    await done(granted.command_ids);
    const relay = await ask({ tailnet: REQUESTER, token_hash: HASH, relay_only: true });
    expect((await argsOf(relay.command_ids[0])).direct).toBeUndefined();
    await done(relay.command_ids);
    await setDevice("there", { direct_links_off: true });
    const off = await ask({ tailnet: REQUESTER, token_hash: HASH });
    expect((await argsOf(off.command_ids[0])).direct).toBeUndefined();
  });

  test("every request gets a row of its own, even an identical one", async () => {
    const { owner, conv, as } = await setup();
    const ask = (token_hash: string) => as(owner).mutation(api.sessionTransfer.requestSessionExport, { device_id: "here", conversation_id: conv, tailnet: REQUESTER, token_hash });
    const first = await ask(HASH);
    expect((await ask(HASH)).command_ids).not.toEqual(first.command_ids);
  });

  test("shares the folder rate limit", async () => {
    const { owner, conv, as, setDevice } = await setup();
    await setDevice("there", { folder_export_at: Array(20).fill(Date.now() - 60_000) });
    await expect(as(owner).mutation(api.sessionTransfer.requestSessionExport, { device_id: "here", conversation_id: conv })).rejects.toThrow("too many transcript requests");
  });
});

describe("sessionExportOutcomes / discardSessionBundle", () => {
  test("answers and archives are the owner's alone, and folder rows never answer here", async () => {
    const { t, owner, other, conv, as } = await setup();
    const asked = await as(owner).mutation(api.sessionTransfer.requestSessionExport, { device_id: "here", conversation_id: conv });
    const id = asked.command_ids[0] as Id<"daemon_commands">;
    const storageId = await t.run((ctx) => ctx.storage.store(new Blob(["tgz"])));
    await t.run((ctx) => ctx.db.patch(id, { executed_at: Date.now(), result: JSON.stringify({ ok: true, storage_id: storageId, bytes: 3, files: 1 }) }));

    expect(await as(owner).query(api.sessionTransfer.sessionExportOutcomes, { command_ids: [id] }))
      .toEqual([expect.objectContaining({ command_id: id, device_id: "there", label: "MacBook-Pro-182" })]);
    expect(await as(other).query(api.sessionTransfer.sessionExportOutcomes, { command_ids: [id] })).toEqual([]);
    expect(await as(owner).query(api.folderSync.folderExportOutcomes, { command_ids: [id] })).toEqual([]);

    expect(await as(other).mutation(api.sessionTransfer.discardSessionBundle, { command_id: id })).toEqual({ discarded: false });
    expect(await as(owner).mutation(api.folderSync.discardFolderBundle, { command_id: id })).toEqual({ discarded: false });
    expect(await t.run(async (ctx) => (await ctx.storage.get(storageId)) !== null)).toBe(true);
    expect(await as(owner).mutation(api.sessionTransfer.discardSessionBundle, { command_id: id })).toEqual({ discarded: true });
    expect(await t.run(async (ctx) => (await ctx.storage.get(storageId)) !== null)).toBe(false);
  });
});
