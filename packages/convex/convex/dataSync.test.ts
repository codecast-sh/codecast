import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { convexTest } from "convex-test";
import schema from "./schema";
import { api } from "./_generated/api";
import { hashToken } from "./apiTokens";
import { allModules } from "./testModules.testkit";

const ANA = "a".repeat(64);
const BEN = "b".repeat(64);
const FOLDER = ".local/share/tool/data";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

async function setup() {
  const t = convexTest(schema, allModules);
  await t.run(async (ctx) => {
    for (const [name, token] of [["Ana", ANA], ["Ben", BEN]] as const) {
      const user = await ctx.db.insert("users", { name } as any);
      await ctx.db.insert("api_tokens", { user_id: user, token_hash: await hashToken(token), name: "cli", created_at: 1, last_used_at: 1 } as any);
    }
  });
  const store = (text: string) => t.run((ctx) => ctx.storage.store(new Blob([text])));
  return { t, store };
}

const live = (rel: string, text: string, storage_id?: any) => ({ folder: FOLDER, rel, sha256: sha(text), size: Buffer.byteLength(text), mtime: 1000, deleted: false, storage_id });

describe("data sync index", () => {
  test("a file one machine commits reaches another machine of the same person, and nobody else", async () => {
    const { t, store } = await setup();
    await t.mutation(api.dataSync.declareFolders, { api_token: ANA, folders: [{ path: FOLDER, declared_by: "acme/tool" }] });
    const id = await store("one");
    await t.mutation(api.dataSync.commit, { api_token: ANA, device_id: "laptop", changes: [live("f/a.json", "one", id)] });

    const seen = await t.query(api.dataSync.changes, { api_token: ANA, since: 0 });
    expect(seen.rows.map((r) => [r.rel, r.sha256, r.device_id, r.deleted])).toEqual([["f/a.json", sha("one"), "laptop", false]]);
    expect(seen.rows[0]!.url).toBeTruthy();
    expect((await t.query(api.dataSync.changes, { api_token: ANA, since: seen.rows[0]!.seq })).rows).toEqual([]);
    expect((await t.query(api.dataSync.folders, { api_token: ANA }))[0]).toMatchObject({ path: FOLDER, declared_by: "acme/tool", files: 1, bytes: 3 });

    expect((await t.query(api.dataSync.changes, { api_token: BEN, since: 0 })).rows).toEqual([]);
    expect(await t.query(api.dataSync.knownContents, { api_token: BEN, shas: [sha("one")] })).toEqual([]);
  });

  test("bytes whose size or sha do not match the claim are refused", async () => {
    const { t, store } = await setup();
    await t.mutation(api.dataSync.declareFolders, { api_token: ANA, folders: [{ path: FOLDER }] });
    const id = await store("real bytes");
    await expect(t.mutation(api.dataSync.commit, { api_token: ANA, changes: [{ ...live("a", "claimed"), storage_id: id }] })).rejects.toThrow("do not match");
  });

  test("known content is reused without an upload, and storage nobody points to is deleted", async () => {
    const { t, store } = await setup();
    await t.mutation(api.dataSync.declareFolders, { api_token: ANA, folders: [{ path: FOLDER }] });
    const id = await store("same");
    await t.mutation(api.dataSync.commit, { api_token: ANA, changes: [live("a", "same", id)] });
    expect(await t.query(api.dataSync.knownContents, { api_token: ANA, shas: [sha("same"), sha("other")] })).toEqual([sha("same")]);
    await t.mutation(api.dataSync.commit, { api_token: ANA, changes: [live("b", "same")] });

    // Both files share the bytes: deleting one keeps them, deleting the other frees them.
    await t.mutation(api.dataSync.commit, { api_token: ANA, changes: [{ ...live("a", "same"), deleted: true }] });
    expect(await t.run((ctx) => ctx.db.system.get(id))).not.toBeNull();
    await t.mutation(api.dataSync.commit, { api_token: ANA, changes: [{ ...live("b", "same"), deleted: true }] });
    expect(await t.run((ctx) => ctx.db.system.get(id))).toBeNull();

    const rows = (await t.query(api.dataSync.changes, { api_token: ANA, since: 0 })).rows;
    expect(rows.map((r) => [r.rel, r.deleted])).toEqual([["a", true], ["b", true]]);
    expect(rows[0]!.seq).toBeLessThan(rows[1]!.seq);
    expect((await t.query(api.dataSync.folders, { api_token: ANA }))[0]).toMatchObject({ files: 0, bytes: 0 });
  });

  test("only declared folders and plain paths sync", async () => {
    const { t, store } = await setup();
    const id = await store("x");
    await expect(t.mutation(api.dataSync.commit, { api_token: ANA, changes: [live("a", "x", id)] })).rejects.toThrow("not a synced folder");
    await expect(t.mutation(api.dataSync.declareFolders, { api_token: ANA, folders: [{ path: ".ssh/keys" }] })).rejects.toThrow("credentials");
    await expect(t.mutation(api.dataSync.declareFolders, { api_token: ANA, folders: [{ path: "Documents" }] })).rejects.toThrow("two levels");
    await t.mutation(api.dataSync.declareFolders, { api_token: ANA, folders: [{ path: FOLDER }] });
    await expect(t.mutation(api.dataSync.commit, { api_token: ANA, changes: [live("../escape", "x", id)] })).rejects.toThrow("plain path");
    await expect(t.query(api.dataSync.folders, {})).rejects.toThrow("Authentication");
  });
});
