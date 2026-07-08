import { describe, expect, test } from "bun:test";
import { mergeChangeFeed } from "./changeFeed";

const row = (entity_id: string, seq: number, op: "upsert" | "delete" = "upsert", entity_type: any = "tasks") =>
  ({ entity_type, entity_id, op, seq });

describe("mergeChangeFeed", () => {
  test("no capped source → emits everything, hasMore false, cursor = max seq", () => {
    const r = mergeChangeFeed(
      [
        { rows: [row("a", 10), row("b", 20)], capped: false },
        { rows: [row("c", 15)], capped: false },
      ],
      0,
    );
    expect(r.hasMore).toBe(false);
    expect(r.nextSince).toBe(20);
    expect(r.changes.map((c) => c.entity_id)).toEqual(["a", "c", "b"]); // sorted by seq
  });

  test("empty → cursor unchanged, not done-with-more", () => {
    const r = mergeChangeFeed([{ rows: [], capped: false }], 99);
    expect(r).toEqual({ changes: [], nextSince: 99, hasMore: false });
  });

  test("dedups an entity present in two scopes, keeping the latest seq", () => {
    const r = mergeChangeFeed(
      [
        { rows: [row("a", 10)], capped: false },
        { rows: [row("a", 30)], capped: false },
      ],
      0,
    );
    expect(r.changes).toEqual([{ entity_type: "tasks", entity_id: "a", op: "upsert" }]);
    expect(r.nextSince).toBe(30);
  });

  test("capped source: advances only to the lowest capped watermark, no gaps", () => {
    // owner capped at seq 50 (more exist beyond), team uncapped up to 80.
    // We must NOT emit team rows past 50, or a resume from >50 would skip owner
    // rows between 50 and that point.
    const r = mergeChangeFeed(
      [
        { rows: [row("a", 10), row("b", 50)], capped: true },
        { rows: [row("c", 20), row("d", 80)], capped: false },
      ],
      0,
    );
    expect(r.hasMore).toBe(true);
    expect(r.nextSince).toBe(50);
    expect(r.changes.map((c) => c.entity_id)).toEqual(["a", "c", "b"]); // d(80) excluded
  });

  test("two capped sources → watermark is the LOWER of the two", () => {
    const r = mergeChangeFeed(
      [
        { rows: [row("a", 10), row("b", 40)], capped: true },
        { rows: [row("c", 15), row("d", 70)], capped: true },
      ],
      0,
    );
    expect(r.hasMore).toBe(true);
    expect(r.nextSince).toBe(40);
    expect(r.changes.map((c) => c.entity_id)).toEqual(["a", "c", "b"]); // seq≤40 included; d(70) excluded
  });

  test("delete op is preserved through the merge", () => {
    const r = mergeChangeFeed([{ rows: [row("a", 5, "delete")], capped: false }], 0);
    expect(r.changes).toEqual([{ entity_type: "tasks", entity_id: "a", op: "delete" }]);
  });
});
