import { describe, expect, test } from "bun:test";
import { pruneScope, SYNC_ACTIONS_RETENTION_MS } from "./syncLogPrune";
import { readRangePage, CHURN_ONLY_FIELDS } from "./syncLog";

// The retention floor (design D10, sync-convergence C9): the prune walk deletes
// a contiguous prefix from the old floor, moves the floor to the last deleted
// position (or to the head when the scope drained), and readRangePage answers
// `resync` when the floor passed the caller's cursor. These pin both floor
// branches and the partial-prune (budget exhausted) shape, against the real
// readRangePage so the verdict a returning client gets is what is asserted.

const NOW = 1_800_000_000_000;
const CUTOFF = NOW - SYNC_ACTIONS_RETENTION_MS;
const OLD = CUTOFF - 1000;
const YOUNG = CUTOFF + 1000;
const SCOPE = "user:u1";

function makeDb(rows: Array<{ position: number; ts: number }>, head: { position: number; floor?: number }) {
  const actions = new Map<string, any>();
  for (const r of rows) {
    actions.set(`a:${r.position}`, { _id: `a:${r.position}`, scope_key: SCOPE, position: r.position, ts: r.ts, entity_type: "tasks", entity_id: `e${r.position}`, op: "upsert" });
  }
  const heads = new Map<string, any>([["h:1", { _id: "h:1", scope_key: SCOPE, position: head.position, floor: head.floor ?? 0 }]]);
  const table = (t: string) => (t === "sync_actions" ? actions : heads);
  const db: any = {
    async get(id: any) { return table(String(id).startsWith("a:") ? "sync_actions" : "sync_heads").get(String(id)) ?? null; },
    async patch(id: any, fields: any) {
      const m = table(String(id).startsWith("a:") ? "sync_actions" : "sync_heads");
      const cur = m.get(String(id));
      if (cur) m.set(String(id), { ...cur, ...fields });
    },
    async delete(id: any) { actions.delete(String(id)); },
    query(t: string) {
      let rows = [...table(t).values()];
      const api: any = {
        withIndex(_n: string, fn: (q: any) => any) {
          const preds: Array<(r: any) => boolean> = [];
          const q: any = {
            eq: (f: string, v: any) => { preds.push((r) => r[f] === v); return q; },
            gt: (f: string, v: any) => { preds.push((r) => r[f] > v); return q; },
          };
          fn(q);
          rows = rows.filter((r) => preds.every((p) => p(r)));
          return api;
        },
        order(dir?: string) {
          rows = [...rows].sort((a, b) => (dir === "desc" ? b.position - a.position : a.position - b.position));
          return api;
        },
        async first() { return rows[0] ?? null; },
        async unique() { return rows[0] ?? null; },
        async take(n: number) { return rows.slice(0, n); },
        async collect() { return rows; },
      };
      return api;
    },
  };
  return { db, head: () => heads.get("h:1")!, positions: () => [...actions.values()].map((r) => r.position).sort((a, b) => a - b) };
}

describe("pruneScope — floor branches", () => {
  test("drained scope (nothing above the floor, head ahead): floor jumps to head", async () => {
    const { db, head } = makeDb([], { position: 5, floor: 0 });
    const r = await pruneScope(db, head(), CUTOFF, 100);
    expect(r).toEqual({ pruned: 0, budget: 100, done: true });
    expect(head().floor).toBe(5);
    // A cursor BELOW the floor missed rows that are gone: resync.
    expect((await readRangePage(db, SCOPE, 3, 10)).resync).toBe(true);
    // A cursor AT the floor has seen everything: plain empty page, no resync.
    const at = await readRangePage(db, SCOPE, 5, 10);
    expect(at.resync).toBeUndefined();
    expect(at.actions).toEqual([]);
  });

  test("drained scope with floor already at head writes nothing", async () => {
    const { db, head } = makeDb([], { position: 5, floor: 5 });
    await pruneScope(db, head(), CUTOFF, 100);
    expect(head().floor).toBe(5);
  });

  test("young oldest row: one probe, nothing pruned, floor untouched", async () => {
    const { db, head, positions } = makeDb([{ position: 1, ts: YOUNG }, { position: 2, ts: OLD }], { position: 2 });
    const r = await pruneScope(db, head(), CUTOFF, 100);
    expect(r.pruned).toBe(0);
    expect(head().floor).toBe(0);
    expect(positions()).toEqual([1, 2]); // the old row behind a young one is over-retained, never skipped past
  });

  test("sawEnd: a fully old scope with holes advances the floor to the head", async () => {
    // Positions 1 and 2 are old; 3 is a hole left by a coalesced move whose
    // row (at 4) was itself pruned earlier — the head is 4.
    const { db, head, positions } = makeDb([{ position: 1, ts: OLD }, { position: 2, ts: OLD }], { position: 4, floor: 0 });
    const r = await pruneScope(db, head(), CUTOFF, 100);
    expect(r.pruned).toBe(2);
    expect(r.done).toBe(true);
    expect(positions()).toEqual([]);
    expect(head().floor).toBe(4);
    // Cursor 2 read rows 1 and 2 but never the (now gone) row at 4: resync.
    expect((await readRangePage(db, SCOPE, 2, 10)).resync).toBe(true);
    // Cursor at the head has seen everything.
    expect((await readRangePage(db, SCOPE, 4, 10)).resync).toBeUndefined();
  });

  test("prefix walk stops at the first young row and floors at the last deleted position", async () => {
    const { db, head, positions } = makeDb(
      [{ position: 1, ts: OLD }, { position: 2, ts: OLD }, { position: 3, ts: YOUNG }, { position: 4, ts: OLD }],
      { position: 4 },
    );
    const r = await pruneScope(db, head(), CUTOFF, 100);
    expect(r.pruned).toBe(2);
    expect(positions()).toEqual([3, 4]);
    expect(head().floor).toBe(2);
    expect((await readRangePage(db, SCOPE, 1, 10)).resync).toBe(true);
    const page = await readRangePage(db, SCOPE, 2, 10);
    expect(page.resync).toBeUndefined();
    expect(page.actions.map((a) => a.position)).toEqual([3, 4]);
  });

  test("partial prune (budget exhausted) floors at the last deleted row and leaves the rest readable", async () => {
    const { db, head, positions } = makeDb(
      [{ position: 1, ts: OLD }, { position: 2, ts: OLD }, { position: 3, ts: OLD }, { position: 4, ts: YOUNG }],
      { position: 4 },
    );
    const r = await pruneScope(db, head(), CUTOFF, 2);
    expect(r).toEqual({ pruned: 2, budget: 0, done: false });
    expect(positions()).toEqual([3, 4]);
    expect(head().floor).toBe(2);
    // The client at the old floor still reads the not-yet-pruned old row; no
    // gap opens between the floor and the surviving rows.
    const page = await readRangePage(db, SCOPE, 2, 10);
    expect(page.resync).toBeUndefined();
    expect(page.actions.map((a) => a.position)).toEqual([3, 4]);
    expect((await readRangePage(db, SCOPE, 1, 10)).resync).toBe(true);
    // The next run finishes the walk from the new floor.
    const r2 = await pruneScope(db, head(), CUTOFF, 100);
    expect(r2.pruned).toBe(1);
    expect(head().floor).toBe(3);
    expect((await readRangePage(db, SCOPE, 3, 10)).actions.map((a) => a.position)).toEqual([4]);
  });
});

describe("churn exemption — the projection's semantic fields ride the log", () => {
  test("armed_trigger_kind is not churn-only", () => {
    expect(CHURN_ONLY_FIELDS.conversations.has("armed_trigger_kind")).toBe(false);
  });
});
