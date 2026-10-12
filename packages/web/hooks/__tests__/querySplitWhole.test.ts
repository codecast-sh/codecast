import { describe, expect, it } from "bun:test";
import { makeFunctionReference } from "convex/server";
import { splitRows } from "@codecast/shared/contracts/inboxSplit";
import { querySplitWhole } from "../useSplitQuery";

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
});
