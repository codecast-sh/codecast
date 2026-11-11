import { describe, expect, test } from "bun:test";
import { clampMirrorNote, mirrorRowNeedsWrite } from "./vaultMirror";
import { VAULT_MIRROR_MAX_LINKS, VAULT_MIRROR_MAX_TAGS } from "@codecast/shared/contracts";

const row = {
  content_hash: "aaaa",
  title: "A",
  mtime: 100,
  size: 10,
  scan_id: "scan-1",
  body_storage_id: "blob-1",
};
const same = { content_hash: "aaaa", title: "A", mtime: 100, size: 10 };

describe("mirrorRowNeedsWrite", () => {
  test("a note with no row yet always writes", () => {
    expect(mirrorRowNeedsWrite(null, same, "scan-1")).toBe(true);
  });

  test("an unchanged note under the current scan stamp writes nothing", () => {
    expect(mirrorRowNeedsWrite(row, same, "scan-1")).toBe(false);
  });

  test("changed content, title, mtime or size each force a write", () => {
    expect(mirrorRowNeedsWrite(row, { ...same, content_hash: "bbbb" }, "scan-1")).toBe(true);
    expect(mirrorRowNeedsWrite(row, { ...same, title: "B" }, "scan-1")).toBe(true);
    expect(mirrorRowNeedsWrite(row, { ...same, mtime: 200 }, "scan-1")).toBe(true);
    expect(mirrorRowNeedsWrite(row, { ...same, size: 11 }, "scan-1")).toBe(true);
  });

  test("a newly uploaded body forces a write even when the content is unchanged", () => {
    expect(mirrorRowNeedsWrite(row, { ...same, body_storage_id: "blob-2" }, "scan-1")).toBe(true);
    expect(mirrorRowNeedsWrite(row, { ...same, body_storage_id: "blob-1" }, "scan-1")).toBe(false);
  });

  test("a stale scan stamp forces a write, or the sweep would delete the row", () => {
    expect(mirrorRowNeedsWrite(row, same, "scan-2")).toBe(true);
  });

  test("an incremental push (no scan) leaves an unchanged row alone", () => {
    expect(mirrorRowNeedsWrite(row, same, undefined)).toBe(false);
  });
});

describe("clampMirrorNote", () => {
  test("caps the two arrays that can grow without bound", () => {
    const note = {
      tags: Array.from({ length: VAULT_MIRROR_MAX_TAGS + 40 }, (_, i) => `t${i}`),
      links: Array.from({ length: VAULT_MIRROR_MAX_LINKS + 40 }, (_, i) => `l${i}`),
    };
    const clamped = clampMirrorNote(note);
    expect(clamped.tags).toHaveLength(VAULT_MIRROR_MAX_TAGS);
    expect(clamped.links).toHaveLength(VAULT_MIRROR_MAX_LINKS);
    expect(clamped.links[0]).toBe("l0");
  });

  test("leaves an ordinary note untouched", () => {
    const note = { tags: ["a"], links: ["B"], title: "keep me" };
    expect(clampMirrorNote(note)).toEqual(note);
  });
});

// F19: a note may hold only a body its own user uploaded through the ticketed
// upload route. Another account's storage id is ignored, so it can never be
// served from, or deleted through, someone else's mirror row.
import { setDefaultTimeout } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { allModules } from "./testModules.testkit";

setDefaultTimeout(120_000);

describe("body ownership", () => {
  const note = (path: string, body?: Id<"_storage">) => ({
    path, title: path, mtime: 1, size: 1, content_hash: "h-" + path, tags: [], links: [], heading_count: 0,
    ...(body ? { body_storage_id: body } : {}),
  });
  const push = (as: any, notes: any[], deleted_paths?: string[]) =>
    as.mutation(api.vaultMirror.cliUpsertNotes, { device_id: "d1", vault_id: "v1", vault_name: "V", notes, deleted_paths });

  test("a foreign storage id is ignored and survives the attacker's deletes; an own upload is kept", async () => {
    const t = convexTest(schema, allModules);
    const { alice, mallory } = await t.run(async (ctx) => ({
      alice: await ctx.db.insert("users", { name: "Alice" } as any),
      mallory: await ctx.db.insert("users", { name: "Mallory" } as any),
    }));
    const as = (u: Id<"users">) => t.withIdentity({ subject: `${u}|session` });

    // Alice uploads through the ticket flow the daemon uses.
    const url: string = await as(alice).mutation(api.vaultMirror.cliBodyUploadUrl, {});
    const ticket = new URL(url, "https://x").searchParams.get("ticket")!;
    const uploader = await t.mutation(internal.vaultMirror.consumeUploadTicket, { token: ticket });
    expect(uploader).toBe(alice);
    // A ticket works once.
    expect(await t.mutation(internal.vaultMirror.consumeUploadTicket, { token: ticket })).toBeNull();
    const blob = await t.run(async (ctx) => {
      const id = await ctx.storage.store(new Blob(["# secret"]));
      await ctx.runMutation(internal.artifacts.recordUpload, { user_id: alice, storage_id: id });
      return id;
    });

    // Mallory names Alice's blob: the row lands without it, and deleting the
    // row leaves the blob alone.
    await push(as(mallory), [note("x.md", blob)]);
    const mRow = await t.run((ctx) => ctx.db.query("vault_notes").filter((q) => q.eq(q.field("user_id"), mallory)).first());
    expect(mRow?.body_storage_id).toBeUndefined();
    await push(as(mallory), [], ["x.md"]);
    expect(await t.run((ctx) => ctx.db.system.get(blob))).not.toBeNull();

    // Alice's own push claims it.
    await push(as(alice), [note("a.md", blob)]);
    const aRow = await t.run((ctx) => ctx.db.query("vault_notes").filter((q) => q.eq(q.field("user_id"), alice)).first());
    expect(aRow?.body_storage_id).toBe(blob);
    // Claimed: a second row (even Alice's own) cannot take the same blob.
    await push(as(alice), [note("b.md", blob)]);
    const b = await t.run((ctx) => ctx.db.query("vault_notes").filter((q) => q.eq(q.field("path"), "b.md")).first());
    expect(b?.body_storage_id).toBeUndefined();
    // Re-pushing the row that already holds it keeps it.
    await push(as(alice), [{ ...note("a.md", blob), mtime: 2 }]);
    const again = await t.run((ctx) => ctx.db.query("vault_notes").filter((q) => q.eq(q.field("path"), "a.md")).first());
    expect(again?.body_storage_id).toBe(blob);
  });

  test("an unknown or expired ticket uploads nothing", async () => {
    const t = convexTest(schema, allModules);
    expect(await t.mutation(internal.vaultMirror.consumeUploadTicket, { token: "nope" })).toBeNull();
    const user = await t.run((ctx) => ctx.db.insert("users", { name: "U" } as any));
    await t.run((ctx) => ctx.db.insert("vault_upload_tickets", { token: "old", user_id: user, expires_at: Date.now() - 1 }));
    expect(await t.mutation(internal.vaultMirror.consumeUploadTicket, { token: "old" })).toBeNull();
  });
});
