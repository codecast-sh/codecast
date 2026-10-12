import { describe, expect, test } from "bun:test";
import { mergeText } from "./judgeFixCommand";

const base = ["a", "b", "c", "d", "e", "f", "g", "h"].join("\n") + "\n";

describe("mergeText: a waiting judge fix laid onto another's copy", () => {
  test("edits to different lines of one file both survive", () => {
    const mine = base.replace("b\n", "b mine\n");
    const theirs = base.replace("g\n", "g theirs\n");
    expect(mergeText(mine, base, theirs)).toBe(base.replace("b\n", "b mine\n").replace("g\n", "g theirs\n"));
  });
  test("a copy already built on the other edit is left as it is", () => {
    const theirs = base.replace("g\n", "g theirs\n");
    const mine = theirs.replace("b\n", "b mine\n");
    expect(mergeText(mine, theirs, theirs)).toBe(mine);
  });
  test("two edits to the same line do not merge", () => {
    expect(mergeText(base.replace("c\n", "c one\n"), base, base.replace("c\n", "c two\n"))).toBeNull();
  });
});
