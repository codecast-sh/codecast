// An approved fix nothing landed waits on a person (approvedFix, LJ8.1 "Approved, not merged"), and For you lists it
// while the problem's own band keeps saying it whole.
import { describe, expect, test } from "bun:test";
import type { CauseHistory, HistoryAttempt } from "../causeHistory";
import { unlandedFix } from "../approvedFix";
import { needCount, needOfCase, unlandedNeed } from "../lineNeeds";

const NOW = new Date(2026, 9, 13, 9).getTime();
const DAY = 86_400_000;
const card = { decisionId: "d", ref: "sd-465", headline: null, change: null, wrong: null, recommend: null, status: "answered", answer: "Ship", note: null, answeredAt: NOW - 6 * DAY, answeredBy: "u1" };
const attempt = (over: Partial<HistoryAttempt> = {}) => ({ runId: "r1", n: 1, start: NOW - 7 * DAY, end: NOW - 6 * DAY, live: false, ended: "shipped", unapproved: false, card, diff: null, merge: null, ...over }) as unknown as HistoryAttempt;
const h = (over: Partial<CauseHistory> = {}) => ({ attempts: [attempt()], ships: [], regressed: false, cameBack: false, ...over }) as unknown as CauseHistory;

describe("unlandedFix", () => {
  test("approved, shipped past its step, nothing merged: waits, even on a problem the line marked done", () => {
    expect(unlandedFix({ status: "done", history: h() })).toEqual({ runId: "r1", at: NOW - 6 * DAY, ref: "sd-465", answeredBy: "u1", behind: null });
  });
  test("answered Ship and the landing refused it for being behind main: approved, landed by a rebase (ct-58259)", () => {
    const failed = attempt({ ended: "failed" as never });
    const shipOutput = "refusing to land: codecast/line-ct-58259 is behind origin/main; rebase first";
    expect(unlandedFix({ status: "open", history: h({ attempts: [failed] }) }, { shipOutput })).toMatchObject({ runId: "r1", behind: "main" });
    // Without that refusal a failed run is a failure, and a done problem is not landed again.
    expect(unlandedFix({ status: "open", history: h({ attempts: [failed] }) })).toBeNull();
    expect(unlandedFix({ status: "done", history: h({ attempts: [failed] }) }, { shipOutput })).toBeNull();
  });
  test("findings back after an approval nothing landed: still approved, not merged", () => {
    expect(unlandedFix({ status: "done", history: h({ cameBack: true }) })).toMatchObject({ runId: "r1", behind: null });
  });
  test("merged, deployed, dropped, unapproved, live, regressed or a trial: nothing waits", () => {
    const merge = { sha: "abc", branch: "b", into: "main", at: NOW, prUrl: null, repository: null };
    expect(unlandedFix({ status: "open", history: h({ attempts: [attempt({ merge })] }) })).toBeNull();
    expect(unlandedFix({ status: "open", history: h({ ships: [{ runId: "r1", merge: null, deploys: [{}] }] as never }) })).toBeNull();
    expect(unlandedFix({ status: "dropped", history: h() })).toBeNull();
    expect(unlandedFix({ status: "open", history: h({ attempts: [attempt({ unapproved: true })] }) })).toBeNull();
    expect(unlandedFix({ status: "open", history: h({ attempts: [attempt({ live: true })] }) })).toBeNull();
    expect(unlandedFix({ status: "open", history: h({ regressed: true }) })).toBeNull();
    expect(unlandedFix({ status: "open", history: h() }, { isTrial: (r) => r === "r1" })).toBeNull();
  });
  test("as a need: the line's to land, never For you's, and never the problem band's own", () => {
    const n = unlandedNeed({ id: "t1", ref: "ct-57458", title: "Intro email", name: null, projectId: "p", process: "g" }, unlandedFix({ status: "done", history: h() })!);
    expect(n).toMatchObject({ kind: "unlanded", counted: false, since: NOW - 6 * DAY, approvedBy: "u1", aliases: ["sd-465"] });
    expect(needCount([n])).toBe(0);
    expect(needCount([n])).toBe(0);
    expect(needOfCase([n], "t1")).toBeNull();
  });
});
