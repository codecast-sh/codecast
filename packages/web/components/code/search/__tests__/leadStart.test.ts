import { expect, test } from "bun:test";
import { leadStart } from "../../../../lib/code/search/leadStart";

const lead = (text: string, hit: string, budget: number) => {
  const start = text.indexOf(hit);
  return text.slice(leadStart(text, start, budget), start);
};

test("a row's lead starts at a word, never mid-word", () => {
  expect(lead("const hello fooBar = 1", "fooBar", 8)).toBe("hello ");
  expect(lead("  return useWatchEffect(x)", "useWatchEffect", 4)).toBe("");
  expect(lead('import { x } from "../hooks/useWatchEffect"', "useWatchEffect", 10)).toBe("hooks/");
  expect(lead('import { x } from "../hooks/useWatchEffect"', "useWatchEffect", 8)).toBe("hooks/");
});

test("a short line shows from its indentation", () => {
  expect(lead("    foo(needle)", "needle", 14)).toBe("foo(");
  expect(lead("x = (((needle", "needle", 3)).toBe("");
  expect(lead("needle", "needle", 14)).toBe("");
});
