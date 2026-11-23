import { describe, expect, it } from "bun:test";
import { splitRows, type SplitCache } from "@codecast/shared/contracts/inboxSplit";
import { compactNulls } from "@codecast/shared/contracts/inboxCompact";
import { expandCompact, rebuildSplitPayload, seedSplitCache } from "../useSplitQuery";

// The live inbox list ships its rows in the compact wire form (null fields
// dropped, restored on arrival). The server splits and hashes the full rows,
// then compacts what it sends; the client must rebuild exactly the rows the
// full form carried, through a push and after a hot row cools.

const NOW = 1_800_000_000_000;
const row = (id: string, at: number, extra: Record<string, unknown> = {}) => ({ _id: id, title: `t-${id}`, updated_at: at, a: null, b: null, c: id === "x" ? 1 : null, ...extra });
// The server's two steps (conversations.ts splitInboxList + compactInboxList).
const serverSplit = (rows: any[], now: number) => {
  const { ids, hot, cold_hash } = splitRows(rows.map((r) => [r._id, r]), now);
  const { rows: wire, null_keys } = compactNulls(hot.map(([, r]) => r));
  return { split: true, ids, hot: wire, cold_hash, hidden_count: 0, truncated: [], null_keys };
};

describe("compact split list", () => {
  it("rebuilds the full rows from a compact push, and again after a hot row cools", () => {
    const rows = [row("x", NOW), row("y", NOW - 86_400_000), row("z", NOW - 1000)];
    const cache: SplitCache<any> = new Map();
    seedSplitCache("list", { ...compactNulls(rows), sessions: compactNulls(rows).rows }, cache);
    const first = rebuildSplitPayload("list", serverSplit(rows, NOW), cache);
    expect(first?.sessions).toEqual(rows);
    const later = rebuildSplitPayload("list", serverSplit(rows, NOW + 3_600_000), cache);
    expect(later?.sessions).toEqual(rows);
  });

  it("restores a compact whole result and passes the full form through", () => {
    const rows = [row("x", NOW), row("y", NOW)];
    const { rows: wire, null_keys } = compactNulls(rows);
    expect(expandCompact("list", { sessions: wire, hidden_count: 0, truncated: [], null_keys })).toEqual({ sessions: rows, hidden_count: 0, truncated: [] });
    const full = { sessions: rows, hidden_count: 0, truncated: [] };
    expect(expandCompact("list", full)).toBe(full);
  });
});
