import { describe, expect, test } from "bun:test";
import { lineStartCost, lineStartLines, startsAtOnce } from "../LineStartSwitch";
import type { LineAdmission } from "../../../../lib/lineFlow";

// learning-loop.md LL5: the start switch states what turning it on costs, in short lines (LL6).
const role = { id: "r1", handle: "aq-line", paused: false };
const adm = (over: Partial<LineAdmission> = {}): LineAdmission => ({ role, on: false, slots: 3, busy: 0, hands: 0, handsCap: 6, queued: 5, ...over });
const EACH = "Each is a session that spends model time until you decide on its fix.";

describe("the line's start switch: what it costs", () => {
  test("off: how many problems would start at once, bounded by free places and today's sessions", () => {
    expect(startsAtOnce(adm())).toBe(3);
    expect(startsAtOnce(adm({ busy: 2 }))).toBe(1);
    expect(startsAtOnce(adm({ hands: 5 }))).toBe(1);
    expect(startsAtOnce(adm({ queued: 2 }))).toBe(2);
    expect(startsAtOnce(adm({ queued: null }))).toBeNull();
    expect(lineStartLines(adm())).toEqual({ now: `Turning it on starts 3 problems right away. ${EACH}`, pace: "Then about 6 a day, so all 5 ready take about 2 days.", held: null, also: null });
    expect(lineStartLines(adm({ queued: 1 }))).toMatchObject({ now: `Turning it on starts 1 problem right away. ${EACH}`, pace: null });
    expect(lineStartLines(adm({ busy: 3 }))?.now).toBe(`Turning it on starts nothing yet: 5 ready wait for a free place. ${EACH}`);
    expect(lineStartLines(adm({ queued: 0 }))?.now).toBe("Turning it on starts nothing yet: no problem is ready to start.");
  });

  test("the case people met: 64 waiting, 44 ready, 5 places, 6 sessions a day, and why 20 are held", () => {
    const l = lineStartLines(adm({ queued: 44, slots: 5 }), false, 64, [{ count: 12, words: "12 need a goal" }, { count: 8, words: "8 are not grounded yet" }]);
    expect(l).toEqual({
      now: `Turning it on starts 5 problems right away. ${EACH}`,
      pace: "Then about 6 a day, so all 44 ready take about 8 days.",
      held: { count: 20, why: "12 need a goal, 8 are not grounded yet" },
      also: null,
    });
    expect(lineStartCost(adm({ queued: 44, slots: 5 }), false, 64)).toBe(`Turning it on starts 5 problems right away. ${EACH} Then about 6 a day, so all 44 ready take about 8 days. 20 wait on you or another run.`);
    // The header counts only the ready ones: nothing held to say.
    expect(lineStartLines(adm({ queued: 5 }), false, 5)?.held).toBeNull();
  });

  test("off with the role's own switch off says that turns on too", () => {
    expect(lineStartLines(adm({ queued: 1 }), true)?.also).toBe("It also lets @aq-line start other work in its area on its own.");
  });

  test("on: what runs now and what waits", () => {
    expect(lineStartCost(adm({ on: true, busy: 2, queued: 4 }))).toBe(`2 of 3 running now, 4 ready to start. ${EACH} @aq-line starts at most 6 sessions a day.`);
    expect(lineStartCost(adm({ on: true, busy: null, queued: null }))).toBe(`Up to 3 at a time. ${EACH} @aq-line starts at most 6 sessions a day.`);
  });

  test("no role runs the line: nothing to say", () => {
    expect(lineStartCost(adm({ role: null }))).toBeNull();
  });
});
