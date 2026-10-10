import { describe, expect, test } from "bun:test";
import { lineStartCost, startsAtOnce } from "../LineStartSwitch";
import type { LineAdmission } from "../../../../lib/lineFlow";

// learning-loop.md LL5: the start switch states what turning it on costs.
const role = { id: "r1", handle: "aq-line", paused: false };
const adm = (over: Partial<LineAdmission> = {}): LineAdmission => ({ role, on: false, slots: 3, busy: 0, hands: 0, handsCap: 6, queued: 5, ...over });
const EACH = "Each starts a session that spends model time until you decide on its fix. @aq-line starts at most 6 sessions a day.";

describe("the line's start switch: what it costs", () => {
  test("off: how many problems would start at once, bounded by free places and today's sessions", () => {
    expect(startsAtOnce(adm())).toBe(3);
    expect(startsAtOnce(adm({ busy: 2 }))).toBe(1);
    expect(startsAtOnce(adm({ hands: 5 }))).toBe(1);
    expect(startsAtOnce(adm({ queued: 2 }))).toBe(2);
    expect(startsAtOnce(adm({ queued: null }))).toBeNull();
    expect(lineStartCost(adm())).toBe(`Turning this on starts 3 problems right away, and the other 2 as places free up. ${EACH}`);
    expect(lineStartCost(adm({ queued: 1 }))).toBe(`Turning this on starts 1 problem right away. ${EACH}`);
    expect(lineStartCost(adm({ busy: 3 }))).toBe(`Turning this on starts nothing yet: 5 problems wait for a free place. ${EACH}`);
    expect(lineStartCost(adm({ queued: 0 }))).toBe(`Nothing is waiting, so turning this on starts nothing yet; new problems start as they arrive. ${EACH}`);
  });

  test("off with the role's own switch off says that turns on too", () => {
    expect(lineStartCost(adm({ queued: 1 }), true)).toBe(`Turning this on starts 1 problem right away. ${EACH} It also lets @aq-line start other work in its area on its own.`);
  });

  test("on: what runs now and what waits", () => {
    expect(lineStartCost(adm({ on: true, busy: 2, queued: 4 }))).toBe(`2 of 3 running now, 4 waiting. ${EACH}`);
    expect(lineStartCost(adm({ on: true, busy: null, queued: null }))).toBe(`Up to 3 at a time. ${EACH}`);
  });

  test("no role runs the line: nothing to say", () => {
    expect(lineStartCost(adm({ role: null }))).toBeNull();
  });
});
