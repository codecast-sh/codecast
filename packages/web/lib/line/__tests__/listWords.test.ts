import { expect, test } from "bun:test";
import { moreWords } from "../listWords";
import { watchesFor } from "../lineSources";

test("a more button names what one press shows, and what is left only when some stays hidden", () => {
  expect(moreWords(60, 52)).toBe("Show 52 more");
  expect(moreWords(60, 112)).toBe("Show 60 more · 112 left");
});

test("a finder's kinds read as words, Union's escalation kinds included", () => {
  expect(watchesFor(["prompt_miss", "bug", "request"])).toBe("agents not doing what they should, bugs and requests for the team");
});
