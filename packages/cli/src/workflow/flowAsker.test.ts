// `cast flow asker` prints one JSON object a station records whole: the typed
// lines and the task's card answers rendered for a model in one chronological
// list. A list too long for the record keeps its newest lines whole and says
// how many of the oldest it left out.
import { describe, expect, test } from "bun:test";
import { fitAskerRecord } from "./flowAsker";

const line = (sid: string, n: number, text: string, at: string) =>
  ({ conversation_id: `c-${sid}`, short_id: sid, line: n, message_id: `m${n}`, user_id: "u1", user_name: "Ana", provenance: "typed_local", text, created_at: at });
const at = (minute: number) => new Date(Date.UTC(2026, 10, 22, 0, minute)).toISOString();

describe("fitAskerRecord", () => {
  test("lines from every session and the task's card answers read in the order they were said, each with its time", () => {
    const read = {
      chain: [], starter_id: "u1", starter_name: "Ana",
      typed: [
        line("jxlead", 7, "fix all of it\nthen ship", "2026-11-21T09:00:00.000Z"),
        line("jxwork", 2, "don't ship yet", "2026-11-22T11:30:00.000Z"),
        line("jxlead", 9, "ship it", "2026-11-22T10:00:00.000Z"),
      ],
      task: { short_id: "ct-7", chain: [] },
      cards: [
        { card: "sd-4", on_task: true, question: "Ship the chip?", user_id: "u1", user_name: "Ana", answer: "Revise", note: "the chip is wrong", created_at: "2026-11-22T10:45:00.000Z" },
        { card: "sd-2", session_short_id: "jxlead", question: "Ship both together, or the links first?", user_id: "u1", user_name: "Ana", answer: "Ship both together", created_at: "2026-11-21T12:00:00.000Z" },
      ],
    };
    const fit: any = fitAskerRecord(read);
    expect(fit.text).toBe([
      "[jxlead:7] 2026-11-21 09:00Z Ana (typed_local): fix all of it\nthen ship",
      '[card sd-2 in jxlead, 2026-11-21 12:00Z] Ana answered "Ship both together" to "Ship both together, or the links first?"',
      "[jxlead:9] 2026-11-22 10:00Z Ana (typed_local): ship it",
      '[card sd-4 on this task, 2026-11-22 10:45Z] Ana answered "Revise" to "Ship the chip?": the chip is wrong',
      "[jxwork:2] 2026-11-22 11:30Z Ana (typed_local): don't ship yet",
    ].join("\n"));
    // The coordinates are in the text; the per-line records stay out of the station's record.
    expect(fit.typed).toBeUndefined();
    expect(fit).toMatchObject({ starter_id: "u1", starter_name: "Ana", task: { short_id: "ct-7", chain: [] } });
    expect(fit.cards).toBeUndefined();
  });

  for (const count of [300, 1_000]) {
    test(`${count} lines fit the record: the newest stay whole and the oldest are counted as left out`, () => {
      const typed = Array.from({ length: count }, (_, i) => line(`jx${i % 7}`, i + 1, `${"words ".repeat(40)}number ${i + 1}`, at(i)));
      const fit: any = fitAskerRecord({ chain: [], starter_id: "u1", starter_name: "Ana", typed });
      expect(JSON.stringify(fit).length).toBeLessThanOrEqual(63_000);
      const lines = fit.text.split("\n");
      expect(lines.at(-1)).toBe(`[jx${(count - 1) % 7}:${count}] ${at(count - 1).slice(0, 10)} ${at(count - 1).slice(11, 16)}Z Ana (typed_local): ${"words ".repeat(40)}number ${count}`);
      const left = Number(lines[0].match(/^\[\.\.\. (\d+) earlier lines left out \.\.\.\]$/)?.[1]);
      expect(left).toBeGreaterThan(0);
      expect(left + lines.length - 1).toBe(count);
      // What is left out is the oldest: the first line shown follows the last one left out.
      expect(lines[1]).toContain(`number ${left + 1}`);
    });
  }

  test("a line too long to carry whole keeps both ends", () => {
    const long = `${"a".repeat(40_000)}MIDDLE${"z".repeat(40_000)}`;
    const fit: any = fitAskerRecord({ chain: [], typed: [line("jx1", 3, "ship everything", at(0)), line("jx1", 9, long, at(1))] });
    const [first, second] = fit.text.split("\n");
    expect(first).toBe(`[jx1:3] 2026-11-22 00:00Z Ana (typed_local): ship everything`);
    expect(second.startsWith("[jx1:9] 2026-11-22 00:01Z Ana (typed_local): aaa")).toBe(true);
    expect(second.endsWith("zzz")).toBe(true);
    expect(second).toContain("characters left out here");
    expect(fit.text).not.toContain("MIDDLE");
  });
});
