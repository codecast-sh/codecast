// `cast flow asker` prints one JSON object a station records whole: the typed
// lines rendered for a model, oldest session first, and under the cap every
// line keeps its coordinates while the longest texts lose their middles first.
import { describe, expect, test } from "bun:test";
import { fitAskerRecord } from "./flowAsker";

const line = (sid: string, n: number, text: string, at: string) =>
  ({ conversation_id: `c-${sid}`, short_id: sid, line: n, message_id: `m${n}`, user_name: "Ana", provenance: "typed_local", text, created_at: at });

describe("fitAskerRecord", () => {
  test("a read that fits renders every line whole, oldest session first, with no words left in typed", () => {
    const read = {
      chain: [], starter_id: "u1", starter_name: "Ana",
      typed: [line("jxwork", 2, "and ship it", "2026-11-22T10:00:00Z"), line("jxlead", 7, "fix all of it\nthen ship", "2026-11-21T09:00:00Z")],
    };
    const fit: any = fitAskerRecord(read);
    expect(fit.text).toBe("[jxlead:7] Ana (typed_local): fix all of it\nthen ship\n[jxwork:2] Ana (typed_local): and ship it");
    expect(fit.typed.map((t: any) => [t.short_id, t.line, t.text])).toEqual([["jxlead", 7, undefined], ["jxwork", 2, undefined]]);
    expect(fit).toMatchObject({ starter_id: "u1", starter_name: "Ana" });
  });

  test("the longest texts are cut in the middle, short ones stay whole, and every line keeps its coordinates", () => {
    const long = `${"a".repeat(40_000)}MIDDLE${"z".repeat(40_000)}`;
    const at = "2026-11-22T10:00:00Z";
    const read = { chain: [], typed: [line("jx1", 3, "ship everything", at), line("jx1", 9, long, at), line("jx1", 12, "b".repeat(30_000), at)] };
    const fit: any = fitAskerRecord(read, 20_000);
    expect(JSON.stringify(fit).length).toBeLessThanOrEqual(20_000);
    expect(fit.typed.map((t: any) => [t.line, t.message_id])).toEqual([[3, "m3"], [9, "m9"], [12, "m12"]]);
    const [first, middle] = fit.text.split("\n");
    expect(first).toBe("[jx1:3] Ana (typed_local): ship everything");
    expect(middle.startsWith("[jx1:9] Ana (typed_local): aaa")).toBe(true);
    expect(middle.endsWith("zzz")).toBe(true);
    expect(middle).toContain("characters left out here");
    expect(fit.text).not.toContain("MIDDLE");
  });
});
