import { describe, expect, test } from "bun:test";
import { changedPieces, wholeSentences } from "../ChangeCardView";

const marked = (text: string, other: string) => changedPieces(text, other).filter((p) => p.changed).map((p) => p.text);

describe("changedPieces", () => {
  test("marks only what one side says that the other does not, and keeps the text as written", () => {
    const before = "Added the button. Verified it renders. outcome: shipped";
    const after = "Added the button. Verified it renders. outcome: progress";
    expect(marked(after, before)).toEqual(["outcome: progress"]);
    expect(marked(before, after)).toEqual(["outcome: shipped"]);
    expect(changedPieces(after, before).map((p) => p.text).join("")).toBe(after);
  });

  test("list items count as pieces", () => {
    expect(marked("Fix - Added X - Added Y", "Fix - Added X")).toEqual(["Added Y"]);
  });

  test("nothing is marked when the sides share no piece", () => {
    expect(marked("All new words here.", "Nothing in common.")).toEqual([]);
  });
});

describe("wholeSentences", () => {
  test("a note cut where it was stored ends at its last whole sentence", () => {
    expect(wholeSentences("The reply is right. One minor point: it is accurate. The outcome 'progress' is not…")).toBe("The reply is right. One minor point: it is accurate.");
    expect(wholeSentences("A whole note.")).toBe("A whole note.");
    expect(wholeSentences("One long cut sentence…")).toBe("One long cut sentence…");
  });
});
