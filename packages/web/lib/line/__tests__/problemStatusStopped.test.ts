import { describe, expect, test } from "bun:test";
import { problemStand } from "../problemStatus";
import { underBarOf } from "../problemPage";

const history = (outcome: { tone: string; text: string }) => ({
  attempts: [{ runId: "r1", n: 1, start: 0, end: 1, live: false, outcome, ended: null, endStep: null, unapproved: false, superseded: false, card: null }],
  closes: [], ships: [], watches: [], regressions: [], cameBack: false, regressed: false, coverage: { state: "unknown" },
}) as any;

describe("problemStand: a run that gave up at a failure step", () => {
  test("ct-59445: Build gave up and the handoff left it in review; it reads Failed at Build, not In review", () => {
    const s = problemStand({ status: "in_review", history: history({ tone: "failed", text: "Stopped: Build failed." }) } as any, {}, 0);
    expect(s).toMatchObject({ status: "failed", phrase: "Failed at Build", cause: { key: "failed-at:build" } });
  });
  test("a finished run in review that nobody holds needs a new ask; one a person holds is theirs, named", () => {
    const s = problemStand({ status: "in_review", history: history({ tone: "calm", text: "Ended at Present." }) } as any, {}, 0);
    expect(s).toMatchObject({ status: "newask" });
    const held = problemStand({ status: "in_review", history: history({ tone: "calm", text: "Ended at Present." }) } as any, { task: { status: "in_review", assignee: "u1" } as any, assigneeName: "Ashot" }, 3 * 86_400_000);
    expect(held).toMatchObject({ status: "others", phrase: "In review · Ashot · 3d" });
  });
});

describe("problemStand: a run parked with nothing to change", () => {
  const parked = { ...history({ tone: "calm", text: "Parked." }), attempts: [{ ...history({ tone: "calm", text: "Parked." }).attempts[0], ended: "parked" }] };
  test("ct-57489: a false positive is closed by its person, so its row offers the close", () => {
    const s = problemStand({ status: "open", history: parked } as any, { task: { status: "open", readiness: "not_actionable", readiness_note: "False positive: the reroute guard holds." } as any }, 1);
    expect(s).toMatchObject({ act: "close" });
  });
  test("a park that needs a fact has no close", () => {
    const s = problemStand({ status: "open", history: parked } as any, { task: { status: "open", readiness: "needs_context", readiness_note: "Which tenant?" } as any }, 1);
    expect(s.act).toBeUndefined();
  });
});

describe("problemStand: a newer run waits at a person's step someone else holds", () => {
  // ct-59571: Run 1 was killed at Prove; Run 2 is paused at the Plan gate, held by Jason. The list holds no run visits.
  const two = (() => {
    const h = history({ tone: "failed", text: "Stopped at Prove." });
    return { ...h, attempts: [h.attempts[0], { ...h.attempts[0], runId: "r2", n: 2, start: 2, end: null, live: true, outcome: { tone: "waiting", text: "Waiting for an answer on the plan." } }] };
  })();
  test("without the gate it reads paused with nothing asked (what the list said before)", () => {
    const s = problemStand({ status: "in_progress", history: two } as any, {}, 10);
    expect(s).toMatchObject({ status: "newask", phrase: "Paused, nothing asked" });
  });
  test("with the gate it is the holder's: Plan to approve · Jason Benn, opened from the row", () => {
    const s = problemStand({ status: "in_progress", history: two } as any, { gate: { node: "plan_gate", since: 5, holder: "Jason Benn" }, assigneeName: "Ashot" }, 10);
    expect(s).toMatchObject({ status: "others", phrase: "Plan to approve · Jason Benn", act: "opengate", gate: "plan_gate" });
  });
  test("a need of the viewer's still comes first", () => {
    const s = problemStand({ status: "in_progress", history: two } as any, { gate: { node: "plan_gate", since: 5 }, need: { kind: "decision", mine: true } }, 10);
    expect(s.status).toBe("you");
  });
});

describe("problemStand: a newer run stopped while an earlier run's built fix waits on its answer (ct-57836)", () => {
  // Run 2 built the fix and its card was withdrawn unanswered; Run 4 then stopped at Prove on a spend cap.
  const h = (() => {
    const base = history({ tone: "failed", text: "Stopped at Prove." });
    const a = base.attempts[0];
    return { ...base, attempts: [
      { ...a, runId: "r2", n: 2, outcome: { tone: "calm", text: "Withdrawn." }, card: { ref: "sd-522", status: "withdrawn", answer: null }, diff: { files: 2, added: 10, removed: 3, pr: null } },
      { ...a, runId: "r4", n: 4 },
    ] };
  })();
  test("it is filed by its stop (a spend cap) and lands the built fix from its row, never 'waiting'", () => {
    const s = problemStand({ status: "in_progress", history: h } as any, { failed: { key: "budget:prove", label: "Stopped by a spend limit at Prove", step: "Prove" } }, 10);
    expect(s).toMatchObject({ status: "failed", phrase: "Stopped by a spend limit at Prove", cause: { key: "budget:prove" }, act: "shipbuilt" });
  });
  test("an answered card or a merge since leaves nothing to land", () => {
    const answered = { ...h, attempts: [{ ...h.attempts[0], card: { ref: "sd-522", status: "answered", answer: "Drop" } }, h.attempts[1]] };
    expect(problemStand({ status: "in_progress", history: answered } as any, { failed: { key: "budget:prove", label: "x", step: "Prove" } }, 10).act).toBeUndefined();
  });
});

describe("problemStand: a problem its live flow's bar holds back (sd-1700)", () => {
  const fresh = { attempts: [], closes: [], ships: [], watches: [], regressions: [], cameBack: false, regressed: false, coverage: { state: "unknown" } } as any;
  const task = (score: number | null, findings: number, over: Record<string, unknown> = {}) =>
    ({ status: "open", readiness: "ready", goal_ref: "pj-1", cause: { signal_count: findings, ...(score == null ? {} : { scored: { score } }) }, ...over }) as any;
  const bar = { score: 60, findings: 3 };
  test("one low-scored sighting waits for another finding, under its own chip, saying what it scored and what runs", () => {
    const t = task(42, 1);
    const s = problemStand({ status: "open", history: fresh } as any, { task: t, lineOn: true, underBar: underBarOf(t, bar) }, 1);
    expect(s).toMatchObject({ status: "waiting", phrase: "Scored 42 on 1 finding; runs at score 60+ or 3+ findings", ready: false });
    const unscored = task(null, 2);
    expect(problemStand({ status: "open", history: fresh } as any, { task: unscored, lineOn: true, underBar: underBarOf(unscored, bar) }, 1).phrase).toBe("Not scored yet on 2 findings; runs at score 60+ or 3+ findings");
  });
  test("over the bar, handed to a role, or with no bar set, it is queued as before", () => {
    expect(underBarOf(task(70, 1), bar)).toBeNull();
    expect(underBarOf(task(20, 3), bar)).toBeNull();
    expect(underBarOf(task(20, 1, { assignee: "or-39" }), bar)).toBeNull();
    expect(underBarOf(task(20, 1), null)).toBeNull();
    const s = problemStand({ status: "open", history: fresh } as any, { task: task(70, 1), lineOn: true, underBar: null }, 1);
    expect(s).toMatchObject({ status: "notstarted", phrase: "Queued", ready: true });
  });
});
