import { describe, expect, test } from "bun:test";
import { APP_DAILY_BUDGET_USD, GLOBAL_DAILY_BUDGET_USD, NARRATION_LINES_MAX } from "../lib/limits";
import { Narration, Throttle, cleanIdeas, dayKey, failureFor, nextInLine, spentOn, startRefusal, stepLine, type QueueRow } from "./rules";

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

  test("spend counts only on its own UTC day", () => {
    expect(day).toBe("2026-10-06");
    expect(spentOn({ day, usd: 3 }, day)).toBe(3);
    expect(spentOn({ day: "2026-10-05", usd: 3 }, day)).toBe(0);
    expect(spentOn(undefined, day)).toBe(0);
  });

  test("a build starts only under both budgets and while builds are on", () => {
    expect(startRefusal({ paused: false, appSpent: 0, globalSpent: 0 })).toBeNull();
    expect(startRefusal({ paused: true, appSpent: 0, globalSpent: 0 })?.error).toMatch(/paused/);
    expect(startRefusal({ paused: false, appSpent: APP_DAILY_BUDGET_USD, globalSpent: 0 })?.error).toMatch(/This app/);
    expect(startRefusal({ paused: false, appSpent: 0, globalSpent: GLOBAL_DAILY_BUDGET_USD })?.error).toMatch(/Clayground/);
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
  test("steps append, repeats fold, a streamed message keeps one line", () => {
    const n = new Narration();
    n.say("Reading v3", 1);
    n.say("Reading v3", 2);
    n.stream("m1", "I'll add", 3);
    n.stream("m1", "I'll add a reset button", 4);
    n.say(stepLine("Editing", "src/App.jsx", "adding a reset button."), 5);
    n.say(stepLine("Editing", "src/styles.css"), 6);
    expect(n.view()).toEqual([
      { at: 1, text: "Reading v3" },
      { at: 3, text: "I'll add a reset button" },
      { at: 5, text: "Adding a reset button (src/App.jsx)" },
      { at: 6, text: "Editing src/styles.css" },
    ]);
  });

  test("keeps the latest lines only", () => {
    const n = new Narration();
    for (let i = 0; i < NARRATION_LINES_MAX + 5; i++) n.say(`step ${i}`, i);
    expect(n.view().length).toBe(NARRATION_LINES_MAX);
    expect(n.view().at(-1)?.text).toBe(`step ${NARRATION_LINES_MAX + 4}`);
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
