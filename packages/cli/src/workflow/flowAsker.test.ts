// `cast flow asker` prints one JSON object a station records whole: under the
// cap, every typed line keeps its coordinates and the longest texts lose
// their middles first.
import { describe, expect, test } from "bun:test";
import { fitAskerRecord } from "./flowAsker";

const line = (n: number, text: string) => ({ conversation_id: "c1", short_id: "jx1", line: n, message_id: `m${n}`, provenance: "typed_local", text });

describe("fitAskerRecord", () => {
  test("a read that fits is printed whole", () => {
    const read = { chain: [], typed: [line(1, "ship it")] };
    expect(fitAskerRecord(read)).toEqual(read);
  });

  test("the longest texts are cut in the middle, short ones stay whole, and every line keeps its coordinates", () => {
    const long = `${"a".repeat(40_000)}MIDDLE${"z".repeat(40_000)}`;
    const read = { chain: [], typed: [line(3, "ship everything"), line(9, long), line(12, `${"b".repeat(30_000)}`)] };
    const fit = fitAskerRecord(read, 20_000);
    expect(JSON.stringify(fit).length).toBeLessThanOrEqual(20_000);
    expect(fit.typed.map((t: any) => [t.line, t.message_id])).toEqual([[3, "m3"], [9, "m9"], [12, "m12"]]);
    expect(fit.typed[0].text).toBe("ship everything");
    expect(fit.typed[1].text.startsWith("aaa")).toBe(true);
    expect(fit.typed[1].text.endsWith("zzz")).toBe(true);
    expect(fit.typed[1].text).toContain("characters left out here");
    expect(fit.typed[1].text).not.toContain("MIDDLE");
  });
});
