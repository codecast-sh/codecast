import { describe, expect, test } from "bun:test";
import { APP_DAILY_BUDGET_USD, GLOBAL_DAILY_BUDGET_USD, NARRATION_LINES_MAX, VISITOR_DAILY_BUDGET_USD } from "../lib/limits";
import { Narration, Throttle, cleanIdeas, failureFor, nextInLine, openingLine, overBudget, startRefusal, stepLine, thinkingLine, type QueueRow } from "./rules";
import { dayKey } from "../tallies";

const row = (id: string, status: QueueRow<string>["status"], at: number): QueueRow<string> => ({ _id: id, status, _creationTime: at });

describe("queue order", () => {
  test("the oldest queued build starts first", () => {
    expect(nextInLine([row("c", "queued", 30), row("a", "queued", 10), row("b", "queued", 20)])).toBe("a");
  });

  test("nothing starts while one is building", () => {
    expect(nextInLine([row("a", "queued", 10), row("b", "building", 20)])).toBeNull();
  });

  test("finished builds do not hold the queue", () => {
    expect(nextInLine([row("a", "live", 1), row("b", "failed", 2), row("c", "queued", 3)])).toBe("c");
    expect(nextInLine([row("a", "live", 1)])).toBeNull();
    expect(nextInLine([])).toBeNull();
  });
});

describe("budgets", () => {
  const day = dayKey(Date.UTC(2026, 9, 6, 23, 59));

  test("spend counts toward its UTC day", () => {
    expect(day).toBe("2026-10-06");
  });

  test("a build starts only under every budget and while builds are on", () => {
    const spent = { global: 0, app: 0, visitor: 0 };
    const refusal = (paused: boolean, more: Partial<typeof spent>) => startRefusal({ paused, over: overBudget({ ...spent, ...more }) });
    expect(refusal(false, {})).toBeNull();
    expect(refusal(true, {})?.error).toMatch(/paused/);
    expect(refusal(false, { app: APP_DAILY_BUDGET_USD - 0.01 })).toBeNull();
    expect(refusal(false, { app: APP_DAILY_BUDGET_USD })?.error).toMatch(/This app/);
    expect(refusal(false, { global: GLOBAL_DAILY_BUDGET_USD })?.error).toMatch(/Clayground/);
    expect(refusal(false, { visitor: VISITOR_DAILY_BUDGET_USD })?.error).toMatch(/a lot of changes today/);
  });
});

describe("failures read as one plain line with the raw cause behind it", () => {
  test("each outcome", () => {
    expect(failureFor({ kind: "declined", reason: "I can't build a login page for a real bank." }).error).toBe("I can't build a login page for a real bank.");
    expect(failureFor({ kind: "stopped", reason: "time" }).error).toBe("It ran out of time on a big change. Try a smaller step.");
    const invalid = failureFor({ kind: "invalid", problems: ["a", "b"] });
    expect(invalid.detail).toBe("a\nb");
    expect(failureFor({ kind: "stopped", reason: "error", error: "529 overloaded" }).detail).toBe("529 overloaded");
    for (const f of [invalid, failureFor({ kind: "unchanged" }), failureFor({ kind: "stopped", reason: "budget" })]) {
      expect(f.error).not.toMatch(/—|!/);
    }
  });
});

describe("narration", () => {
  test("the first message is the plan, a passing line gives way, and steps on one file fold", () => {
    const n = new Narration();
    n.now("Thinking about adding a reset button", 1);
    n.now("Planning the reset", 2);
    n.stream("m1", "I'll add", 3);
    n.stream("m1", "I'll add a reset button\nunder the score.", 4);
    n.now("Reading App.jsx", 5);
    n.change("src/App.jsx", stepLine("Editing", "src/App.jsx", "adding a reset button."), 6);
    n.change("src/App.jsx", stepLine("Editing", "src/App.jsx", "wiring it to the score"), 7);
    n.change("src/styles.css", stepLine("Editing", "src/styles.css"), 8);
    n.stream("m2", "Now the check.\nOne more fix", 9);
    n.say("Checked, going live", 10);
    n.say("Checked, going live", 11);
    expect(n.view()).toEqual([
      { at: 3, text: "I'll add a reset button under the score.", kind: "plan" },
      { at: 6, text: "Wiring it to the score" },
      { at: 8, text: "Editing styles.css" },
      { at: 9, text: "One more fix" },
      { at: 10, text: "Checked, going live" },
    ]);
  });

  test("a passing line stands until the next line", () => {
    const n = new Narration();
    n.say("Fixing a problem the check found", 1);
    n.now("Thinking it over", 2);
    expect(n.view().at(-1)).toEqual({ at: 2, text: "Thinking it over", kind: "now" });
  });

  test("keeps the latest lines only, and always the plan", () => {
    const n = new Narration();
    n.stream("m1", "The plan", 0);
    for (let i = 1; i < NARRATION_LINES_MAX + 5; i++) n.say(`step ${i}`, i);
    expect(n.view().length).toBe(NARRATION_LINES_MAX);
    expect(n.view()[0]).toEqual({ at: 0, text: "The plan", kind: "plan" });
    expect(n.view().at(-1)?.text).toBe(`step ${NARRATION_LINES_MAX + 4}`);
  });

  test("a build opens on what it is about, in the asker's words", () => {
    expect(openingLine("make the bass frog wobble whenever anyone croaks their own note")).toBe("Thinking about making the bass frog wobble whenever…");
    expect(openingLine("Please add a sun.")).toBe("Thinking about adding a sun");
    expect(openingLine("A multiplayer drawing wall: everyone draws")).toBe("Thinking about a multiplayer drawing wall");
    expect(openingLine("can you, like, rename it")).toBe("Thinking about like, rename it");
    expect(openingLine("could the alto frog blink now and then")).toBe("Thinking about the alto frog blink now and…");
    expect(openingLine("   ")).toBe("Thinking it through");
  });

  test("a thinking summary reads as its latest heading, else its latest finished sentence", () => {
    expect(thinkingLine("**Planning the wobble**\n\nI'll add a keyframe.\n\n**Wiring the croak**\n\nOn each note")).toBe("Wiring the croak");
    expect(thinkingLine("The wobble already works. I'm checking the croak")).toBe("The wobble already works.");
    expect(thinkingLine("The wobble already works. I'm checking the croak.")).toBe("I'm checking the croak.");
    expect(thinkingLine("The")).toBe("");
  });
});

describe("Throttle", () => {
  test("writes at once, folds a burst into one trailing write, and flushes", async () => {
    let now = 0;
    const writes: number[] = [];
    const t = new Throttle(async () => void writes.push(now), 250, () => now);
    t.poke();
    await t.flush();
    now = 100;
    t.poke();
    t.poke();
    await t.flush();
    expect(writes).toEqual([0, 100]);
    now = 1000;
    t.poke();
    await t.flush();
    expect(writes).toEqual([0, 100, 1000]);
  });
});

describe("change ideas", () => {
  test("read as chips: one line, no end stop, lowercase first, no repeats, at most three", () => {
    expect(cleanIdeas(["Make the frogs  harmonize.", "make the frogs harmonize", "", "x".repeat(80), "Add a moon", "Add rain!", "Add snow"])).toEqual([
      "make the frogs harmonize",
      "add a moon",
      "add rain",
    ]);
  });
});
