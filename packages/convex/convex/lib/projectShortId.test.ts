import { describe, expect, test } from "bun:test";
import { mintProjectShortId } from "./projectShortId";

/** A projects table of short ids, read the way the index is. */
const ctxWith = (taken: string[]) => ({
  db: {
    query: () => ({
      withIndex: (_name: string, f: (q: any) => any) => {
        let want = "";
        f({ eq: (_k: string, v: string) => { want = v; return null; } });
        return { first: async () => (taken.includes(want) ? { short_id: want } : null) };
      },
    }),
  },
});

describe("mintProjectShortId", () => {
  test("a project's id is its time in base 36", async () => {
    expect(await mintProjectShortId(ctxWith([]), 1_700_000_000_000)).toBe(`pj-${(1_700_000_000_000).toString(36)}`);
  });
  test("a time another project already holds moves on by a millisecond, so two never share one", async () => {
    const at = 1_700_000_000_000;
    const taken = [`pj-${at.toString(36)}`, `pj-${(at + 1).toString(36)}`];
    expect(await mintProjectShortId(ctxWith(taken), at)).toBe(`pj-${(at + 2).toString(36)}`);
  });
});
