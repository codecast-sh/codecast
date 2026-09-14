import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Two stack groups on /questions once answered two decisions on one digit:
// each current card added its own capture listener and stopPropagation does
// not stop siblings on the same node. The queue hands `keys` to exactly one
// group, and the handler uses stopImmediatePropagation as the belt.
const root = join(import.meta.dir, "..");
const read = (f: string) => readFileSync(join(root, f), "utf8");

describe("answer keys have one owner", () => {
  test("the queue passes keys to the first stack group only", () => {
    const src = read("DecisionQueueList.tsx");
    expect(src).toMatch(/const firstStackKey = groups\.find\(\(g\) => g\.kind === "stack"\)\?\.key;/);
    expect(src).toMatch(/keys=\{g\.key === firstStackKey\}/);
    expect(src).not.toMatch(/<DecisionCompactCard[^>]*\skeys\s/);
  });
  test("the checklist forwards its keys prop instead of claiming them", () => {
    const src = read("StackChecklist.tsx");
    expect(src).toMatch(/<DecisionCompactCard decision=\{d\} keys=\{keys\}/);
    expect(src).not.toMatch(/<DecisionCompactCard decision=\{d\} keys showTask/);
  });
  test("the capture handler stops sibling listeners", () => {
    const src = read("DecisionAnswerControls.tsx");
    expect(src).toContain("e.stopImmediatePropagation()");
    expect(src).not.toMatch(/e\.stopPropagation\(\)/);
  });
});
