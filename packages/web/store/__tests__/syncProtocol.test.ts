import { describe, expect, it } from "bun:test";
import { applySyncTable } from "../syncProtocol";

type Row = { _id: string; updated_at: number; status: "open" | "done" | "dropped" };

const r = (id: string, updated_at: number, status: Row["status"] = "open"): Row =>
  ({ _id: id, updated_at, status });

describe("applySyncTable — snapshot mode", () => {
  it("drops prev rows that are missing from incoming (server authoritative)", () => {
    const prev: Record<string, Row> = { a: r("a", 1), b: r("b", 2) };
    const incoming: Row[] = [r("a", 5)];
    const { table } = applySyncTable("tasks", incoming, {}, prev);
    expect(Object.keys(table).sort()).toEqual(["a"]);
    expect(table.a.updated_at).toBe(5);
  });
});

describe("applySyncTable — delta mode", () => {
  it("preserves prev rows that are absent from the delta", () => {
    const prev: Record<string, Row> = { a: r("a", 1), b: r("b", 2), c: r("c", 3) };
    const incoming: Row[] = [r("a", 10)];
    const { table } = applySyncTable("tasks", incoming, {}, prev, { isDelta: true });
    expect(Object.keys(table).sort()).toEqual(["a", "b", "c"]);
    expect(table.a.updated_at).toBe(10);
    expect(table.b.updated_at).toBe(2);
    expect(table.c.updated_at).toBe(3);
  });

  it("treats a soft-delete (status='dropped') as an update, not a removal", () => {
    const prev: Record<string, Row> = { a: r("a", 1), b: r("b", 2) };
    const incoming: Row[] = [r("a", 5, "dropped")];
    const { table } = applySyncTable("tasks", incoming, {}, prev, { isDelta: true });
    expect(Object.keys(table).sort()).toEqual(["a", "b"]);
    expect(table.a.status).toBe("dropped");
  });

  it("adds new rows from a delta", () => {
    const prev: Record<string, Row> = { a: r("a", 1) };
    const incoming: Row[] = [r("z", 9)];
    const { table } = applySyncTable("tasks", incoming, {}, prev, { isDelta: true });
    expect(Object.keys(table).sort()).toEqual(["a", "z"]);
  });

  it("respects field pending overrides for incoming rows", () => {
    const prev: Record<string, Row> = { a: r("a", 1) };
    const incoming: Row[] = [r("a", 5, "open")];
    const pending = { "tasks:a:status": { type: "field" as const, value: "done" } };
    const { table } = applySyncTable("tasks", incoming, pending, prev, { isDelta: true });
    expect(table.a.status).toBe("done");
  });

  it("does NOT clear pending excludes just because the delta omits a record", () => {
    const prev: Record<string, Row> = { a: r("a", 1) };
    const incoming: Row[] = [];
    const pending = { "tasks:a": { type: "exclude" as const } };
    const { pending: nextPending } = applySyncTable("tasks", incoming, pending, prev, { isDelta: true });
    expect(nextPending["tasks:a"]?.type).toBe("exclude");
  });
});
