import { describe, expect, it } from "bun:test";
import { makeFunctionReference } from "convex/server";
import { rowHash, splitRows } from "@codecast/shared/contracts/inboxSplit";
import { querySplitWhole, setSplitPersistence } from "../useSplitQuery";

// The recovery polls read through querySplitWhole: a quiet inbox's poll must
// move the split form, and the whole list only when the cache cannot vouch.
const NOW = 1_800_000_000_000;
const row = (id: string, n = 1) => ({ _id: id, updated_at: NOW - 60 * 60_000, n });

function fakeConvex(rows: () => any[]) {
  const asked: any[] = [];
  const convex = {
    watchQuery: (_q: any, args: any) => {
      asked.push(args);
      const whole = { sessions: rows(), hidden_count: 0, truncated: [] };
      const value = args.split
        ? (() => { const s = splitRows(whole.sessions.map((r) => [r._id, r]), NOW); return { split: true, ids: s.ids, hot: s.hot.map(([, r]) => r), cold_hash: s.cold_hash, hidden_count: 0, truncated: [] }; })()
        : whole;
      return { localQueryResult: () => value, onUpdate: () => () => {} } as any;
    },
  };
  return { convex, asked };
}

describe("querySplitWhole", () => {
  it("fetches the whole list once, then answers polls from the split form", async () => {
    let rows = [row("a"), row("b")];
    const { convex, asked } = fakeConvex(() => rows);
    const q = makeFunctionReference<"query">("test:querySplitWholeList");
    const signal = new AbortController().signal;

    expect((await querySplitWhole(convex, q, {}, "list", signal)).sessions).toEqual(rows);
    expect(asked.map((a) => !!a.split)).toEqual([true, false]); // cold cache: split, then whole

    asked.length = 0;
    expect((await querySplitWhole(convex, q, {}, "list", signal)).sessions).toEqual(rows);
    expect(asked.map((a) => !!a.split)).toEqual([true]); // held: the split form alone

    asked.length = 0;
    rows = [row("a", 2), row("b")];
    expect((await querySplitWhole(convex, q, {}, "list", signal)).sessions).toEqual(rows);
    expect(asked.map((a) => !!a.split)).toEqual([true, false]); // a cold row changed: whole again
  });

  it("rebuilds the first split result from rows a past launch saved", async () => {
    const rows = [row("a"), row("b")];
    const saved = rows.map((r) => ({ id: r._id, hash: rowHash(r), row: JSON.parse(JSON.stringify(r)) }));
    setSplitPersistence({ load: async () => saved, save: () => {} });
    try {
      const { convex, asked } = fakeConvex(() => rows);
      const q = makeFunctionReference<"query">("test:querySplitWholeRestored");
      expect((await querySplitWhole(convex, q, {}, "list", new AbortController().signal)).sessions).toEqual(rows);
      expect(asked.map((a) => !!a.split)).toEqual([true]); // no whole download
    } finally {
      setSplitPersistence(null);
    }
  });

  it("fetches the whole list when a saved row is out of date", async () => {
    const rows = [row("a", 2), row("b")];
    const stale = [row("a"), row("b")].map((r) => ({ id: r._id, hash: rowHash(r), row: r }));
    setSplitPersistence({ load: async () => stale, save: () => {} });
    try {
      const { convex, asked } = fakeConvex(() => rows);
      const q = makeFunctionReference<"query">("test:querySplitWholeStale");
      expect((await querySplitWhole(convex, q, {}, "list", new AbortController().signal)).sessions).toEqual(rows);
      expect(asked.map((a) => !!a.split)).toEqual([true, false]);
    } finally {
      setSplitPersistence(null);
    }
  });
});
