import { describe, expect, test } from "bun:test";
import { applySyncTable } from "../syncProtocol";

type Row = { _id: string; conversation_id: string; content: string };

const prev: Record<string, Row> = {
  c1: { _id: "c1", conversation_id: "convA", content: "kept" },
  c2: { _id: "c2", conversation_id: "convA", content: "deleted-on-server" },
  c3: { _id: "c3", conversation_id: "convB", content: "other-conversation" },
};

// Matrix VIEW-02: the comments/buckets registry entries are isDelta
// (upsert-only), but the v2 cutover feed delivers a COMPLETE view. Without a
// scoped prune, a row deleted on the server survives in the store (and IDB)
// forever — negating the deletion convergence the durable view guarantees.
describe("cutover feed pruning (complete view over an isDelta store table)", () => {
  test("isDelta alone never prunes a server-deleted row — why the prune is mandatory", () => {
    const { table } = applySyncTable(
      "comments",
      [prev.c1],
      {},
      prev,
      { isDelta: true },
    );
    expect(Object.keys(table).sort()).toEqual(["c1", "c2", "c3"]);
  });

  test("pruneAbsentScope removes in-scope absent rows and spares other scopes", () => {
    const { table, pending } = applySyncTable(
      "comments",
      [prev.c1],
      {},
      prev,
      { isDelta: true, pruneAbsentScope: (row) => row.conversation_id === "convA" },
    );
    expect(Object.keys(table).sort()).toEqual(["c1", "c3"]);
    // The prune records a durable exclude so IDB hydration cannot resurrect it.
    expect(pending["comments:c2"]).toMatchObject({ type: "exclude" });
  });

  test("rows with pending local state survive the prune (optimistic writes win)", () => {
    const { table } = applySyncTable(
      "comments",
      [prev.c1],
      { "comments:c2": { type: "include", ts: 1 } },
      prev,
      { isDelta: true, pruneAbsentScope: (row) => row.conversation_id === "convA" },
    );
    expect(Object.keys(table).sort()).toEqual(["c1", "c2", "c3"]);
  });
});
