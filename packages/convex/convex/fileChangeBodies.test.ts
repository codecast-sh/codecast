import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import {
  deleteFileChange,
  migrate,
  readFileChangeBodies,
  readFileChangeIndex,
  readFoldChanges,
  writeFileChange,
} from "./fileChangeBodies";

const conversation = "conversation" as any;

function fields(key: string, overrides: Record<string, unknown> = {}) {
  return {
    conversation_id: conversation, change_key: key, message_id: "message" as any, tool_call_id: key,
    seq: 0, file_path: "/r/a.ts", change_type: "write" as const, commit_message: undefined,
    commit_hash: undefined, timestamp: 10, ...overrides,
  };
}

function setup(rows: any[] = [], bodies: any[] = []) {
  const scheduled: any[] = [];
  const db = makeFakeDb({ conversations: [{ _id: conversation }], file_changes: rows, file_change_bodies: bodies });
  return { ctx: { db, scheduler: { runAfter: async (_d: number, _f: any, args: any) => { scheduled.push(args); } } } as any, db, scheduled };
}

describe("file change bodies live apart from their index rows", () => {
  test("a write lands as one index row with sizes and one body row, and a repeat changes nothing", async () => {
    const { ctx, db } = setup();
    await writeFileChange(ctx, null, fields("k1"), { oldContent: "one\n", newContent: "one\ntwo\n" });
    const existing = db._tables.file_changes[0];
    await writeFileChange(ctx, existing, fields("k1"), { oldContent: "one\n", newContent: "one\ntwo\n" });
    expect(db._tables.file_changes).toHaveLength(1);
    expect(db._tables.file_changes[0]).toMatchObject({ change_key: "k1", old_bytes: 4, new_bytes: 8 });
    expect(db._tables.file_changes[0].new_content).toBeUndefined();
    expect(db._tables.file_change_bodies).toEqual([
      { _id: expect.any(String), conversation_id: conversation, change_key: "k1", old_content: "one\n", new_content: "one\ntwo\n" },
    ]);
    expect(db._patched).toHaveLength(0);
  });

  test("a refresh of a legacy inline row moves its text out and updates a changed body", async () => {
    const { ctx, db } = setup([{ _id: "legacy", ...fields("k1"), old_content: "a", new_content: "b" }]);
    await writeFileChange(ctx, db._tables.file_changes[0], fields("k1", { timestamp: 11 }), { oldContent: "a", newContent: "c" });
    expect(db._tables.file_changes[0]).toMatchObject({ timestamp: 11, old_bytes: 1, new_bytes: 1, old_content: undefined, new_content: undefined });
    expect(db._tables.file_change_bodies[0]).toMatchObject({ change_key: "k1", old_content: "a", new_content: "c" });
    await writeFileChange(ctx, db._tables.file_changes[0], fields("k1", { timestamp: 11 }), { oldContent: "a", newContent: "d" });
    expect(db._tables.file_change_bodies).toHaveLength(1);
    expect(db._tables.file_change_bodies[0].new_content).toBe("d");
  });

  test("deleting a change removes its text too", async () => {
    const { ctx, db } = setup();
    await writeFileChange(ctx, null, fields("k1"), { newContent: "x" });
    await writeFileChange(ctx, null, fields("k2"), { newContent: "y" });
    await deleteFileChange(ctx, conversation, "k1");
    expect(db._tables.file_changes.map((r: any) => r.change_key)).toEqual(["k2"]);
    expect(db._tables.file_change_bodies.map((r: any) => r.change_key)).toEqual(["k2"]);
  });

  test("the index carries sizes, not text, and reads legacy sizes from the inline copy", async () => {
    const { ctx } = setup([
      { _id: "r1", ...fields("k1", { timestamp: 10 }), old_content: "ab", new_content: "abc" },
      { _id: "r2", ...fields("k2", { timestamp: 20, change_type: "edit" }), old_bytes: undefined, new_bytes: 5 },
    ]);
    const index = await readFileChangeIndex(ctx, conversation);
    expect(index).toEqual([
      expect.objectContaining({ id: "k1", sequenceIndex: 0, oldBytes: 2, newBytes: 3 }),
      expect.objectContaining({ id: "k2", sequenceIndex: 1, oldBytes: undefined, newBytes: 5 }),
    ]);
    expect(JSON.stringify(index)).not.toContain("abc");
  });

  test("bodies come from the body table or the legacy inline copy, in the order asked, up to the budget", async () => {
    const { ctx } = setup(
      [
        { _id: "r1", ...fields("k1"), old_content: "legacy-old", new_content: "legacy-new" },
        { _id: "r2", ...fields("k2"), new_bytes: 6 },
        { _id: "r3", ...fields("k3"), new_bytes: 6 },
      ],
      [
        { _id: "b2", conversation_id: conversation, change_key: "k2", new_content: "body-2" },
        { _id: "b3", conversation_id: conversation, change_key: "k3", new_content: "body-3" },
      ],
    );
    const all = await readFileChangeBodies(ctx, conversation, ["k2", "k1", "missing", "k3"]);
    expect(all.truncated).toBe(false);
    expect(Array.from(all.bodies.entries())).toEqual([
      ["k2", { oldContent: undefined, newContent: "body-2" }],
      ["k1", { oldContent: "legacy-old", newContent: "legacy-new" }],
      ["k3", { oldContent: undefined, newContent: "body-3" }],
    ]);
    const cut = await readFileChangeBodies(ctx, conversation, ["k2", "k3"], 8);
    expect(cut.truncated).toBe(true);
    expect(Array.from(cut.bodies.keys())).toEqual(["k2"]);
  });

  test("the fold payload holds the inputs a fold reads, every commit, and nothing else", async () => {
    const { ctx } = setup();
    for (let i = 0; i < 5; i++) {
      await writeFileChange(ctx, null, fields(`w${i}`, { timestamp: i, seq: i }), { oldContent: `v${i}`, newContent: `v${i + 1}` });
    }
    await writeFileChange(ctx, null, fields("commit", { timestamp: 9, change_type: "commit", file_path: "", commit_message: "ship" }), { newContent: "" });
    const { changes, truncated } = await readFoldChanges(ctx, conversation);
    expect(truncated).toBe(false);
    expect(changes.map((c) => [c.id, c.newContent])).toEqual([["w0", "v1"], ["w4", "v5"], ["commit", ""]]);
    expect(changes[0]).not.toHaveProperty("newBytes");
  });

  test("migrate moves inline text page by page and schedules the next hop until done", async () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({ _id: `r${i}`, ...fields(`k${i}`), old_content: i % 2 ? "o" : undefined, new_content: `n${i}` }));
    rows.push({ _id: "done", ...fields("done"), new_bytes: 1 } as any);
    const { ctx, db, scheduled } = setup(rows);
    const first = await (migrate as any)._handler(ctx, {});
    expect(first).toEqual({ scanned: 16, moved: 16, done: false });
    expect(scheduled).toHaveLength(1);
    const second = await (migrate as any)._handler(ctx, scheduled[0]);
    expect(second).toEqual({ scanned: 21, moved: 20, done: true });
    expect(db._tables.file_changes.every((r: any) => r.new_content === undefined)).toBe(true);
    expect(db._tables.file_changes[1]).toMatchObject({ old_bytes: 1, new_bytes: 2 });
    expect(db._tables.file_change_bodies).toHaveLength(20);
    expect(db._tables.file_change_bodies.find((r: any) => r.change_key === "k1")).toMatchObject({ old_content: "o", new_content: "n1" });
    // A second pass finds nothing left to move.
    const again = await (migrate as any)._handler({ ...ctx }, {});
    expect(again.moved).toBe(0);
  });
});
