// Page state (pageState.ts): who reads and writes each declared collection,
// the page's gates in front of both, the caps, row ownership, and the
// declaration following publish and rollback while the rows stay.
import { describe, expect, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import { allModules } from "./testModules.testkit";
import { kTokenFor, passwordHash } from "./lib/artifactGates";
import { PAGE_STATE_LIMITS, parsePageDataDeclaration } from "@codecast/shared/contracts/pageData";

const SLUG = "stateslug1";

const declaration = {
  state: {
    votes: { write: "anyone" },
    notes: { write: "signed-in", own: true },
    answers: { write: "anyone", read: "owner" },
    config: {},
  },
};

async function setup(extra: Record<string, unknown> = {}) {
  const t = convexTest(schema, allModules);
  const ids = await t.run(async (ctx) => {
    const owner = await ctx.db.insert("users", { name: "Pat" } as any);
    const alice = await ctx.db.insert("users", { name: "Alice" } as any);
    const bob = await ctx.db.insert("users", { name: "Bob" } as any);
    const storage = await ctx.storage.store(new Blob(["<html></html>"], { type: "text/html" }));
    const artifact = await ctx.db.insert("artifacts", {
      slug: SLUG, user_id: owner, title: "Poll", storage_id: storage, size: 10, version: 1, created_at: 1, updated_at: 1, owner_key: "ownerkey", ...extra,
    } as any);
    await ctx.db.insert("artifact_identities", { token: "tok-alice", user_id: alice, artifact_id: artifact, created_at: 1 });
    await ctx.db.insert("artifact_identities", { token: "tok-bob", user_id: bob, artifact_id: artifact, created_at: 1 });
    return { owner, alice, bob, artifact };
  });
  const parsed = parsePageDataDeclaration(declaration);
  if (!parsed.ok) throw new Error(parsed.error);
  const publish = (version: number, state: typeof parsed.state | null = parsed.state) =>
    t.mutation(internal.pageData.replaceQueries, {
      slug: SLUG, owner: ids.owner, version,
      set_json: state ? JSON.stringify({ workspace: `user:${ids.owner}`, queries: [], state }) : "",
    });
  await publish(1);
  const write = (collection: string, op: "set" | "insert" | "patch" | "delete" | "clear", key?: string, value?: unknown, who: Record<string, string> = {}) =>
    t.mutation(api.pageState.write, { slug: SLUG, collection, op, key, ...(value !== undefined ? { value_json: JSON.stringify(value) } : {}), ...who });
  const list = (collection: string, who: Record<string, string> = {}) => t.query(api.pageState.list, { slug: SLUG, collection, ...who });
  return { t, ...ids, publish, write, list };
}

describe("declaration", () => {
  test("state alone is a declaration, levels default and are checked", () => {
    expect(parsePageDataDeclaration({ state: { a: {} } })).toMatchObject({ ok: true, queries: [], state: [{ id: "a", read: "viewers", write: "editors", own: false }] });
    expect(parsePageDataDeclaration({ state: { a: { write: "everyone" } } })).toMatchObject({ ok: false, error: expect.stringContaining('"write" is one of') });
    expect(parsePageDataDeclaration({ state: { "Bad Id": {} } })).toMatchObject({ ok: false });
    expect(parsePageDataDeclaration({})).toMatchObject({ ok: false });
  });
});

describe("reads and writes", () => {
  test("anyone writes a write:anyone collection, and the rows come back in insert order", async () => {
    const { write, list } = await setup();
    const a = await write("votes", "insert", undefined, { choice: "red" });
    const b = await write("votes", "insert", undefined, { choice: "blue" });
    expect("key" in a && "key" in b).toBe(true);
    const ans: any = await list("votes");
    expect(ans.rows.map((r: any) => JSON.parse(r.value_json).choice)).toEqual(["red", "blue"]);
    expect(ans.rows[0].by).toBeNull();
  });

  test("editors-only collections refuse viewers and take the owner key", async () => {
    const { write, list } = await setup();
    expect(await write("config", "set", "theme", "dark")).toEqual({ error: expect.stringContaining("editors only") });
    expect(await write("config", "set", "theme", "dark", { owner_key: "ownerkey" })).toEqual({ key: "theme" });
    const ans: any = await list("config");
    expect(JSON.parse(ans.rows[0].value_json)).toBe("dark");
  });

  test("an edit link holder is an editor only in link edit mode", async () => {
    const off = await setup({ edit_key: "editkey" });
    expect(await off.write("config", "set", "x", 1, { edit_key: "editkey" })).toMatchObject({ error: expect.any(String) });
    const on = await setup({ edit_key: "editkey", edit_mode: "link" });
    expect(await on.write("config", "set", "x", 1, { edit_key: "editkey" })).toEqual({ key: "x" });
  });

  test("an owner-read collection takes anonymous answers but shows them only to the owner", async () => {
    const { write, list } = await setup();
    expect(await write("answers", "insert", undefined, { email: "a@b.c" })).toHaveProperty("key");
    expect(await list("answers")).toEqual({ error: expect.stringContaining("owner") });
    expect(((await list("answers", { owner_key: "ownerkey" })) as any).rows).toHaveLength(1);
  });

  test("signed-in writers own their rows when the collection says so", async () => {
    const { write, list } = await setup();
    expect(await write("notes", "set", "n1", "hi")).toEqual({ error: expect.stringContaining("Sign in") });
    expect(await write("notes", "set", "n1", "hi", { identity_token: "tok-alice" })).toEqual({ key: "n1" });
    expect(await write("notes", "set", "n1", "mine now", { identity_token: "tok-bob" })).toEqual({ error: expect.stringContaining("only rows you wrote") });
    expect(await write("notes", "delete", "n1", undefined, { identity_token: "tok-bob" })).toMatchObject({ error: expect.any(String) });
    // The owner is an editor and may change anyone's row.
    expect(await write("notes", "set", "n1", "moderated", { owner_key: "ownerkey" })).toEqual({ key: "n1" });
    const rows: any[] = ((await list("notes", { identity_token: "tok-alice" })) as any).rows;
    expect(rows[0]).toMatchObject({ key: "n1", by: { name: "Alice" }, mine: true });
  });

  test("patch merges into an object row; clear is for editors", async () => {
    const { write, list } = await setup();
    await write("votes", "set", "tally", { red: 1 });
    await write("votes", "patch", "tally", { blue: 2 });
    expect(JSON.parse(((await list("votes")) as any).rows[0].value_json)).toEqual({ red: 1, blue: 2 });
    expect(await write("votes", "clear")).toMatchObject({ error: expect.any(String) });
    expect(await write("votes", "clear", undefined, undefined, { owner_key: "ownerkey" })).toEqual({ cleared: 1 });
    expect(((await list("votes")) as any).rows).toEqual([]);
  });

  test("rows and collections are capped, and the page's budget bounds writers", async () => {
    const { write } = await setup();
    expect(await write("votes", "set", "big", "x".repeat(PAGE_STATE_LIMITS.row_bytes))).toEqual({ error: expect.stringContaining("at most") });
    expect(await write("votes", "set", "k".repeat(PAGE_STATE_LIMITS.key_chars + 1), 1)).toEqual({ error: expect.stringContaining("keys are at most") });
    expect(await write("nope", "set", "a", 1)).toEqual({ error: expect.stringContaining('no state collection "nope"') });
    let refused: unknown = null;
    for (let i = 0; i <= PAGE_STATE_LIMITS.writes_per_minute; i++) {
      const r: any = await write("votes", "set", "same", i);
      if (r.error) { refused = r.error; break; }
    }
    expect(refused).toEqual(expect.stringContaining("too many writes"));
    // Editors are outside the budget.
    expect(await write("votes", "set", "same", 0, { owner_key: "ownerkey" })).toEqual({ key: "same" });
  });
});

describe("gates", () => {
  test("a password page needs its k token; the owner key stands behind the wall", async () => {
    const hash = await passwordHash("pw", SLUG);
    const { write, list } = await setup({ password_hash: hash });
    expect(await list("votes")).toEqual({ error: "This page is password protected" });
    expect(await write("votes", "insert", undefined, 1)).toEqual({ error: "This page is password protected" });
    const k = await kTokenFor(hash, SLUG);
    expect(await list("votes", { k })).toHaveProperty("rows");
    expect(await list("votes", { owner_key: "ownerkey" })).toHaveProperty("rows");
  });

  test("an expired page answers nothing", async () => {
    const { list } = await setup({ expires_at: 1 });
    expect(await list("votes")).toEqual({ error: "This page has expired" });
  });
});

describe("declaration lifecycle", () => {
  test("a publish without state removes the config but keeps the rows; a rollback brings both back", async () => {
    const { t, artifact, write, list, publish } = await setup();
    await write("votes", "set", "kept", true);
    await publish(2, null);
    expect(await list("votes")).toEqual({ error: "This page declares no state" });
    await t.mutation(internal.pageData.restoreSet, { artifact_id: artifact, from_version: 1, to_version: 3 });
    expect(((await list("votes")) as any).rows.map((r: any) => r.key)).toEqual(["kept"]);
  });

  test("the owner's CLI writes as an editor and reads every collection", async () => {
    const { t, owner } = await setup();
    expect(await t.mutation(internal.pageState.ownerWrite, { owner, target: SLUG, collection: "config", op: "set", key: "seed", value_json: "[1,2]" })).toEqual({ key: "seed" });
    const read: any = await t.query(internal.pageState.ownerRead, { owner, target: SLUG });
    expect(read.collections.map((c: any) => c.id)).toEqual(["votes", "notes", "answers", "config"]);
    expect(read.collections[3]).toMatchObject({ bytes: 5, rows: [{ key: "seed", value_json: "[1,2]" }] });
  });
});
