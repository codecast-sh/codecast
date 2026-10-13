import { describe, expect, test } from "bun:test";
import { leftWhy } from "../leftList";
import { problemHeadName, problemListName } from "../problemTable";

const T = "Follow-up playbook permanently skips cold nudges after 5 failed attempts even when the failures are a provider outage (Bedrock no-output-tool + Anthropic out of credit), so 40 contacts never get their nudge";

describe("problem names", () => {
  test("the reader head keeps a title over the list cap whole, its last clause included", () => {
    expect(T.length).toBeGreaterThan(90);
    expect(problemHeadName({ title: T })).toContain("so 40 contacts never get their nudge");
    expect(problemHeadName({ title: T, name: "Cold nudges skipped after a provider outage" })).toBe("Cold nudges skipped after a provider outage");
  });
  test("the list ends the clause it is in rather than cutting it mid-way", () => {
    expect(problemListName({ title: T })).toBe("Follow-up playbook permanently skips cold nudges after 5 failed attempts even when the failures are a provider outage…");
  });
});

const attempt = (n: number, start: number, extra: Record<string, unknown> = {}) => ({ runId: `r${n}`, n, start, end: null, live: true, outcome: { end: null, text: "running" }, card: null, ...extra }) as never;

describe("leftWhy", () => {
  const now = 10 * 3_600_000;
  test("a run started by a new finding", () => {
    const h = { attempts: [attempt(2, 1000, { live: false, end: 2000 }), attempt(3, now - 7 * 60_000)], closes: [], occurrences: [{ at: now - 9 * 60_000, reopened: false }] };
    expect(leftWhy(h, new Map(), now)).toEqual({ moved: "Run 3 started again 7m ago after a new finding", runId: "r3" });
  });
  test("an answer by a teammate", () => {
    const card = { answer: "Ship", answeredAt: now - 5 * 60_000, answeredBy: "u1" };
    const h = { attempts: [attempt(1, now - 3_600_000, { card })], closes: [], occurrences: [] };
    expect(leftWhy(h, new Map([["u1", "Cam"]]), now).moved).toBe("Answered by Cam 5m ago: Ship");
  });
  test("a close", () => {
    const h = { attempts: [attempt(1, now - 3 * 3_600_000, { live: false, end: now - 7_200_000 })], closes: [{ runId: "r1", n: 1, kind: "shipped", at: now - 7_200_000, step: null, back: null, fold: null }], occurrences: [] } as never;
    expect(leftWhy(h, new Map(), now).moved).toBe("Closed as fixed 2h ago");
  });
});
