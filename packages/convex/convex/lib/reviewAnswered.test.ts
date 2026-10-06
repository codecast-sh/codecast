import { describe, expect, test } from "bun:test";
import { answeredNotes, type SentNote } from "./reviewAnswered";

const note = (over: Partial<SentNote>): SentNote => ({ id: "n1", content: "Rename this to something clearer", ...over });
const ids = (r: ReturnType<typeof answeredNotes>) => r.map((a) => `${a.id}:${a.reason}`);

describe("answeredNotes", () => {
  test("an exact quote of the note answers it, whatever the case and spacing", () => {
    const reply = "On your note \"rename   this to something CLEARER\": done, it is `parseRange` now.";
    expect(ids(answeredNotes([note({})], { content: reply }, new Map()))).toEqual(["n1:quote"]);
  });

  test("a blockquoted stretch of the note answers it", () => {
    const n = note({ content: "This loop reads every row twice. Can it stop at the first match?" });
    const reply = "> This loop reads every row twice\n\nIt stops at the first match now.";
    expect(ids(answeredNotes([n], { content: reply }, new Map()))).toEqual(["n1:quote"]);
  });

  test("a short or partial quote does not", () => {
    const reply = "> rename\n\nSure.";
    expect(answeredNotes([note({})], { content: reply }, new Map())).toEqual([]);
  });

  test("file:line inside the note's lines answers it", () => {
    const n = note({ content: "why?", file_path: "packages/web/lib/a.ts", line_number: 40, line_end: 44 });
    for (const reply of [
      "Fixed in `lib/a.ts:42`.", "See a.ts:38-41 for the change.", "a.ts#L44 now guards it",
      "1. **a.ts line 42**: now guarded", "In `a.ts` (lines 43 to 50) the loop stops early", "line 41 of lib/a.ts reads the cache",
    ]) {
      expect(ids(answeredNotes([n], { content: reply }, new Map()))).toEqual(["n1:place"]);
    }
  });

  test("another file or a line outside the note's does not", () => {
    const n = note({ content: "why?", file_path: "lib/a.ts", line_number: 40 });
    for (const reply of ["Fixed lib/a.ts:12.", "Fixed lib/ba.ts:40.", "Fixed lib/a.tsx:40.", "a.ts line 12", "line 40 of b.ts", "line 40 of ba.ts", "a.ts was fine; line 40 elsewhere"]) {
      expect(answeredNotes([n], { content: reply }, new Map())).toEqual([]);
    }
  });

  test("a reply to the message that carried a one-note batch answers that note", () => {
    const n = note({ content: "why?", sent_client_id: "review-batch:1" });
    const sizes = new Map([["review-batch:1", 1]]);
    expect(ids(answeredNotes([n], { content: "Because the cache was cold.", parentClientId: "review-batch:1" }, sizes))).toEqual(["n1:parent"]);
    expect(answeredNotes([n], { content: "Because.", parentClientId: "other" }, sizes)).toEqual([]);
  });

  test("with several notes in the batch the parent link alone answers none", () => {
    const a = note({ id: "a", content: "first remark about naming", sent_client_id: "b1", file_path: "x.ts", line_number: 3 });
    const b = note({ id: "b", content: "second remark about tests", sent_client_id: "b1", file_path: "y.ts", line_number: 9 });
    const sizes = new Map([["b1", 2]]);
    expect(answeredNotes([a, b], { content: "All done.", parentClientId: "b1" }, sizes)).toEqual([]);
    expect(ids(answeredNotes([a, b], { content: "Renamed in x.ts:3.", parentClientId: "b1" }, sizes))).toEqual(["a:place"]);
  });
});
