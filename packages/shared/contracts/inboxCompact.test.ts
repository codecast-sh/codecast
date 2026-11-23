import { describe, expect, it } from "bun:test";
import { compactNulls, expandNulls, NULLS_FIELD } from "./inboxCompact";
import { rowHash, stableStringify } from "./inboxSplit";

const rows = () => {
  const out: Record<string, unknown>[] = [];
  for (let i = 0; i < 40; i++) {
    const row: Record<string, unknown> = { _id: `id${i}`, title: `t${i}`, updated_at: 1_800_000_000_000 + i };
    for (let f = 0; f < 140; f++) if ((i * 7 + f) % 3) row[`f${f}`] = (i + f) % 5 ? null : f;
    if (i % 4 === 0) row.only_sometimes = null;
    out.push(row);
  }
  return out;
};

describe("compact null wire form", () => {
  it("restores every row exactly, absent keys staying absent", () => {
    const full = rows();
    const { rows: wire, null_keys } = compactNulls(full);
    const back = expandNulls(wire, null_keys);
    expect(back.map((r) => stableStringify(r))).toEqual(full.map((r) => stableStringify(r)));
    expect(back.map((r) => Object.keys(r).sort())).toEqual(full.map((r) => Object.keys(r).sort()));
    expect(back.map(rowHash)).toEqual(full.map(rowHash));
  });

  it("carries far fewer bytes than the full form", () => {
    const full = rows();
    const { rows: wire, null_keys } = compactNulls(full);
    expect(JSON.stringify({ wire, null_keys }).length).toBeLessThan(JSON.stringify(full).length / 2);
  });

  it("leaves rows with no nulls, and lists with none, as they were", () => {
    const plain = [{ _id: "a", n: 1 }, { _id: "b", n: 2 }];
    const { rows: wire, null_keys } = compactNulls(plain);
    expect(null_keys).toEqual([]);
    expect(expandNulls(wire, null_keys)).toEqual(plain);
    const mixed = compactNulls([{ _id: "a", x: null }, { _id: "b", x: 1 }]);
    expect(NULLS_FIELD in mixed.rows[1]).toBe(false);
    expect(expandNulls(mixed.rows, mixed.null_keys)).toEqual([{ _id: "a", x: null }, { _id: "b", x: 1 }]);
  });
});
