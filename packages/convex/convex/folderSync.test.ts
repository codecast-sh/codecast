// Folder sync between one owner's machines: the request reaches only the
// owner's other online devices, only the owner can read the answers, and a
// discard deletes the archive the answer names.
import { describe, expect, setDefaultTimeout, setSystemTime, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { allModules } from "./testModules.testkit";
import { pickFolderPeers } from "./folderSync";
import { hashToken } from "./apiTokens";
import { presentToken } from "@platform/auth/convex";

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
    expect(JSON.parse(cmd!.args!)).toEqual({ path: "/Users/ashot/src/family", conversation_id: conv, requester: "here" });
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

describe("a late export answer", () => {
  const PATH = "/Users/ashot/src/family";
  const sourceReporter = async (t: any, owner: Id<"users">) => {
    await t.run(async (ctx: any) => ctx.db.insert("api_tokens", { user_id: owner, token_hash: await hashToken("there-secret"), name: "there", created_at: 1, last_used_at: 1, device_id: "there" }));
    return (id: Id<"daemon_commands">, result: string) =>
      t.mutation(api.users.reportCommandResult, { api_token: presentToken("there-secret", "there"), command_id: id, result });
  };
  test("a request discarded before any answer is never run, and its late archive is deleted", async () => {
    const { t, owner, conv, as } = await setup();
    const asked = await as(owner).mutation(api.folderSync.requestFolderExport, { device_id: "here", conversation_id: conv, path: PATH });
    const id = asked.command_ids[0] as Id<"daemon_commands">;
    expect(await as(owner).mutation(api.folderSync.discardFolderBundle, { command_id: id })).toEqual({ discarded: false });
    const abandoned = await t.run((ctx) => ctx.db.get(id));
    expect(abandoned).toMatchObject({ error: "abandoned" });
    expect(abandoned!.executed_at).toBeGreaterThan(0);
    const pending = await t.run((ctx) => ctx.db.query("daemon_commands").withIndex("by_user_pending", (q) => q.eq("user_id", owner).eq("executed_at", undefined)).collect());
    expect(pending.map((c) => c._id)).not.toContain(id);

    const report = await sourceReporter(t, owner);
    const storageId = await t.run((ctx) => ctx.storage.store(new Blob(["tgz"])));
    const late = JSON.stringify({ ok: true, storage_id: storageId, bytes: 3, files: 1, path: PATH });
    expect(await report(id, late)).toEqual({ success: true });
    expect(await t.run(async (ctx) => (await ctx.storage.get(storageId)) !== null)).toBe(false);
    const after = await t.run((ctx) => ctx.db.get(id));
    expect(after).toMatchObject({ error: "abandoned", executed_at: abandoned!.executed_at });
    expect(after!.result).toBeUndefined();
  });

  test("an answer to a pending request is still recorded", async () => {
    const { t, owner, conv, as } = await setup();
    const asked = await as(owner).mutation(api.folderSync.requestFolderExport, { device_id: "here", conversation_id: conv, path: PATH });
    const id = asked.command_ids[0] as Id<"daemon_commands">;
    const report = await sourceReporter(t, owner);
    const storageId = await t.run((ctx) => ctx.storage.store(new Blob(["tgz"])));
    const answer = JSON.stringify({ ok: true, storage_id: storageId, bytes: 3, files: 1, path: PATH });
    await report(id, answer);
    expect(await t.run((ctx) => ctx.db.get(id))).toMatchObject({ result: answer });
    expect(await t.run(async (ctx) => (await ctx.storage.get(storageId)) !== null)).toBe(true);
  });
});

describe("requestFolderExport: direct grants, dedupe, rate limit", () => {
  const PATH = "/Users/ashot/src/family";
  const REQUESTER = { ip: "100.64.0.1", name: "mbp.tail1.ts.net." };
  const HASH = "a".repeat(64);
  const argsOf = async (t: any, id: string) => JSON.parse((await t.run((ctx: any) => ctx.db.get(id as Id<"daemon_commands">)))!.args!);
  const done = (t: any, ids: string[]) => t.run(async (ctx: any) => { for (const id of ids) await ctx.db.patch(id as Id<"daemon_commands">, { executed_at: Date.now() }); });

  test("asks for a direct grant when the requester sends its tailnet and token hash", async () => {
    const { t, owner, conv, as } = await setup();
    const asked = await as(owner).mutation(api.folderSync.requestFolderExport, { device_id: "here", conversation_id: conv, path: PATH, tailnet: REQUESTER, token_hash: HASH });
    expect(await argsOf(t, asked.command_ids[0])).toEqual({ path: PATH, conversation_id: conv, requester: "here", direct: { requester: REQUESTER, token_hash: HASH } });
  });

  test("no grant without both fields, on relay_only, or when the source turned direct links off", async () => {
    const { t, owner, conv, as } = await setup();
    const ask = (extra: Record<string, unknown>) => as(owner).mutation(api.folderSync.requestFolderExport, { device_id: "here", conversation_id: conv, path: PATH, ...extra } as any);
    for (const extra of [{ tailnet: REQUESTER }, { token_hash: HASH }, { tailnet: REQUESTER, token_hash: HASH, relay_only: true }]) {
      const asked = await ask(extra);
      expect((await argsOf(t, asked.command_ids[0])).direct).toBeUndefined();
      await done(t, asked.command_ids);
    }
    await t.run(async (ctx) => {
      const there = await ctx.db.query("devices").filter((q) => q.eq(q.field("device_id"), "there")).first();
      await ctx.db.patch(there!._id, { direct_links_off: true });
    });
    const asked = await ask({ tailnet: REQUESTER, token_hash: HASH });
    expect((await argsOf(t, asked.command_ids[0])).direct).toBeUndefined();
  });

  test("no grant when the requester turned direct links off", async () => {
    const { t, owner, conv, as } = await setup();
    await t.run(async (ctx) => {
      const here = await ctx.db.query("devices").filter((q) => q.eq(q.field("device_id"), "here")).first();
      await ctx.db.patch(here!._id, { direct_links_off: true });
    });
    const asked = await as(owner).mutation(api.folderSync.requestFolderExport, { device_id: "here", conversation_id: conv, path: PATH, tailnet: REQUESTER, token_hash: HASH });
    expect((await argsOf(t, asked.command_ids[0])).direct).toBeUndefined();
  });

  test("refuses a requester that is not one of the owner's machines", async () => {
    const { owner, conv, as } = await setup();
    for (const device_id of ["nope", "bos-mac"]) {
      await expect(as(owner).mutation(api.folderSync.requestFolderExport, { device_id, conversation_id: conv, path: PATH })).rejects.toThrow("not one of your machines");
    }
  });

  test("refuses a malformed token hash or tailnet", async () => {
    const { owner, conv, as } = await setup();
    await expect(as(owner).mutation(api.folderSync.requestFolderExport, { device_id: "here", conversation_id: conv, path: PATH, token_hash: "abc" })).rejects.toThrow("token_hash");
    await expect(as(owner).mutation(api.folderSync.requestFolderExport, { device_id: "here", conversation_id: conv, path: PATH, tailnet: { ip: "fd7a::1", name: "x" } })).rejects.toThrow("tailnet");
    await expect(as(owner).mutation(api.folderSync.requestFolderExport, { device_id: "here", conversation_id: conv, path: PATH, tailnet: { ip: "192.168.1.5", name: "x" } })).rejects.toThrow("tailnet");
  });

  test("only_device_id asks that one online machine of the owner, else refuses", async () => {
    const { t, owner, conv, as } = await setup();
    await t.run((ctx) => ctx.db.insert("devices", { user_id: owner, device_id: "third", last_seen: Date.now(), label: "Studio" } as any));
    const ask = (only_device_id: string) => as(owner).mutation(api.folderSync.requestFolderExport, { device_id: "here", conversation_id: conv, path: PATH, only_device_id });
    const asked = await ask("third");
    expect(Object.values(asked.labels)).toEqual(["Studio"]);
    for (const id of ["asleep", "bos-mac", "here", "nope"]) await expect(ask(id)).rejects.toThrow("not one of your online machines");
  });

  test("identical requests get rows of their own, so discarding one leaves the other waiting", async () => {
    const { t, owner, conv, as } = await setup();
    const ask = () => as(owner).mutation(api.folderSync.requestFolderExport, { device_id: "here", conversation_id: conv, path: PATH });
    const first = await ask();
    const second = await ask();
    expect(second.command_ids).not.toEqual(first.command_ids);
    expect(await argsOf(t, second.command_ids[0])).toEqual(await argsOf(t, first.command_ids[0]));
    await as(owner).mutation(api.folderSync.discardFolderBundle, { command_id: first.command_ids[0] as Id<"daemon_commands"> });
    const waiting = await t.run((ctx) => ctx.db.get(second.command_ids[0] as Id<"daemon_commands">));
    expect(waiting!.executed_at).toBeUndefined();
    expect(waiting!.error).toBeUndefined();
  });

  test("the rate limit counts requests across the owner's machines, one unit per request however many machines it asks", async () => {
    const { t, owner, conv, as } = await setup();
    const now = Date.now();
    await t.run(async (ctx) => {
      for (const id of ["p1", "p2", "p3"]) await ctx.db.insert("devices", { user_id: owner, device_id: id, last_seen: now } as any);
      const there = await ctx.db.query("devices").filter((q) => q.eq(q.field("device_id"), "there")).first();
      await ctx.db.patch(there!._id, { folder_export_at: Array(18).fill(now - 60_000) });
    });
    const ask = (only_device_id?: string) => as(owner).mutation(api.folderSync.requestFolderExport, { device_id: "here", conversation_id: conv, path: PATH, ...(only_device_id ? { only_device_id } : {}) });
    const all = await ask();
    expect(all.command_ids).toHaveLength(4);
    const here = () => t.run((ctx) => ctx.db.query("devices").filter((q) => q.eq(q.field("device_id"), "here")).first());
    expect((await here())!.folder_export_at).toHaveLength(1);
    await ask("p1");
    expect((await here())!.folder_export_at).toHaveLength(2);
    await expect(ask("p1")).rejects.toThrow("too many folder requests");
  });

  test("the rate window slides", async () => {
    const { t, owner, conv, as } = await setup();
    const ask = () => as(owner).mutation(api.folderSync.requestFolderExport, { device_id: "here", conversation_id: conv, path: PATH });
    const start = Date.now();
    try {
      await ask();
      const at = async (ms: number) => {
        setSystemTime(new Date(start + ms));
        await t.run(async (ctx) => { for (const d of await ctx.db.query("devices").collect()) if (d.device_id !== "asleep") await ctx.db.patch(d._id, { last_seen: Date.now() }); });
      };
      await at(3 * 60_000);
      const again = await ask();
      expect(again.command_ids).toHaveLength(1);
      await done(t, again.command_ids);
      for (let i = 0; i < 18; i++) await done(t, (await ask()).command_ids);
      await expect(ask()).rejects.toThrow("too many folder requests");
      await at(14 * 60_000);
      expect((await ask()).command_ids).toHaveLength(1);
    } finally {
      setSystemTime();
    }
  });

  test("outcomes name the machine that answered", async () => {
    const { owner, conv, as } = await setup();
    const asked = await as(owner).mutation(api.folderSync.requestFolderExport, { device_id: "here", conversation_id: conv, path: PATH });
    expect(await as(owner).query(api.folderSync.folderExportOutcomes, { command_ids: asked.command_ids as Id<"daemon_commands">[] }))
      .toEqual([expect.objectContaining({ device_id: "there", label: "MacBook-Pro-182" })]);
  });
});
