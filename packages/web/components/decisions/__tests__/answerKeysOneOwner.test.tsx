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
  test("the queue passes keys to one group, and inside it to the first row only", () => {
    const src = read("DecisionQueueList.tsx");
    expect(src).toMatch(/const keysGroup = \(groups\.find\(\(g\) => g\.kind !== "role"\) \?\? groups\[0\]\)\?\.key;/);
    // Digit keys are developer-mode machinery (questions.internals); hosted mode gets none.
    expect(src).toMatch(/keys=\{internals && g\.key === keysGroup\}/);
    // Every compact card in the queue takes keys only as the group's first row.
    const cards = src.match(/<DecisionCompactCard[^>]*>/g) ?? [];
    expect(cards.length).toBeGreaterThan(0);
    for (const c of cards) expect(c).toMatch(/keys=\{keys && i === 0\}/);
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

// The line jumps stations with Shift and a digit while a card holds the
// cursor. On some layouts that chord still reports a bare digit as e.key, so
// the card's gate refuses it by code, never by key.
describe("Shift and a digit belongs to the page", () => {
  test("answerKeyAllowed refuses a shifted digit and passes a bare one", async () => {
    const { answerKeyAllowed } = await import("../ChangeCardView");
    const ev = (o: Partial<KeyboardEvent>) => ({ metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, key: "1", code: "Digit1", ...o }) as KeyboardEvent;
    expect(answerKeyAllowed(ev({}))).toBe(true);
    expect(answerKeyAllowed(ev({ shiftKey: true, key: "1" }))).toBe(false);
    expect(answerKeyAllowed(ev({ shiftKey: true, key: "!" }))).toBe(false);
    expect(answerKeyAllowed(ev({ shiftKey: true, key: "Enter", code: "Enter" }))).toBe(true);
   }, 60_000);
});

// The undo timeline owns its Enter, digits and x while focused. A decision
// surface that passes no keyScope (DecisionDocument, the queue's compact card,
// the Line's awaiting cards) once answered on the timeline's Enter.
describe("a focused key-owning region keeps the answer keys", () => {
  test("answerKeyAllowed refuses a key whose target is inside another region that owns its keys", async () => {
    const { answerKeyAllowed } = await import("../ChangeCardView");
    const inTimeline = { closest: (sel: string) => (sel.includes("[data-owns-keys]") ? {} : null) };
    const ev = (o: Partial<KeyboardEvent>) => ({ metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, key: "Enter", code: "Enter", ...o }) as KeyboardEvent;
    expect(answerKeyAllowed(ev({ target: inTimeline as any }))).toBe(false);
    expect(answerKeyAllowed(ev({ key: "1", code: "Digit1", target: inTimeline as any }))).toBe(false);
    expect(answerKeyAllowed(ev({ target: { closest: () => null } as any }))).toBe(true);
   }, 60_000);
});
