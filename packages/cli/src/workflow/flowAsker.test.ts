// `cast flow asker` prints one JSON object a station records whole: the typed
// lines and the task's card answers rendered for a model in one chronological
// list, and under the cap every line keeps its coordinates while the longest
// texts lose their middles first.
import { describe, expect, test } from "bun:test";
import { fitAskerRecord } from "./flowAsker";

const line = (sid: string, n: number, text: string, at: string) =>
  ({ conversation_id: `c-${sid}`, short_id: sid, line: n, message_id: `m${n}`, user_name: "Ana", provenance: "typed_local", text, created_at: at });

describe("fitAskerRecord", () => {
  test("lines from every session and the task's card answers read in the order they were said, each with its time", () => {
    const read = {
      chain: [], starter_id: "u1", starter_name: "Ana",
      typed: [
        line("jxlead", 7, "fix all of it\nthen ship", "2026-11-21T09:00:00.000Z"),
        line("jxwork", 2, "don't ship yet", "2026-11-22T11:30:00.000Z"),
        line("jxlead", 9, "ship it", "2026-11-22T10:00:00.000Z"),
      ],
      task: { short_id: "ct-7", chain: [], verdicts: [{ card: "sd-4", user_id: "u1", user_name: "Ana", answer: "Revise", note: "the chip is wrong", created_at: "2026-11-22T10:45:00.000Z" }] },
    };
    const fit: any = fitAskerRecord(read);
    expect(fit.text).toBe([
      "[jxlead:7] 2026-11-21 09:00Z Ana (typed_local): fix all of it\nthen ship",
      "[jxlead:9] 2026-11-22 10:00Z Ana (typed_local): ship it",
      "[sd-4] 2026-11-22 10:45Z Ana answered Revise on this task's Ship card: the chip is wrong",
      "[jxwork:2] 2026-11-22 11:30Z Ana (typed_local): don't ship yet",
    ].join("\n"));
    expect(fit.typed.map((t: any) => [t.short_id, t.line, t.text])).toEqual([["jxlead", 7, undefined], ["jxlead", 9, undefined], ["jxwork", 2, undefined]]);
    expect(fit).toMatchObject({ starter_id: "u1", starter_name: "Ana" });
  });

  test("the longest texts are cut in the middle, short ones stay whole, and every line keeps its coordinates", () => {
    const long = `${"a".repeat(40_000)}MIDDLE${"z".repeat(40_000)}`;
    const read = { chain: [], typed: [line("jx1", 3, "ship everything", "2026-11-22T10:00:00Z"), line("jx1", 9, long, "2026-11-22T10:01:00Z"), line("jx1", 12, "b".repeat(30_000), "2026-11-22T10:02:00Z")] };
    const fit: any = fitAskerRecord(read, 20_000);
    expect(JSON.stringify(fit).length).toBeLessThanOrEqual(20_000);
    expect(fit.typed.map((t: any) => [t.line, t.message_id])).toEqual([[3, "m3"], [9, "m9"], [12, "m12"]]);
    const [first, middle] = fit.text.split("\n");
    expect(first).toBe("[jx1:3] 2026-11-22 10:00Z Ana (typed_local): ship everything");
    expect(middle.startsWith("[jx1:9] 2026-11-22 10:01Z Ana (typed_local): aaa")).toBe(true);
    expect(middle.endsWith("zzz")).toBe(true);
    expect(middle).toContain("characters left out here");
    expect(fit.text).not.toContain("MIDDLE");
  });
});
