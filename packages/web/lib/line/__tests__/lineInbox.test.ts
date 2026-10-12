import { describe, expect, test } from "bun:test";
import { askLine, askParts, buildLineInbox, groupFailures, inboxCount, inboxProcessOf, lineProjectCounts, type InboxRow } from "../lineInbox";
import { failCause } from "../runReport";
import type { LineIssue } from "../lineModel";
import type { LineAdmission, RollupRow } from "../../lineFlow";

const now = Date.UTC(2026, 9, 11, 12);
const H = 3_600_000;
const cause = (id: string, over: Record<string, unknown> = {}) => ({
  _id: id, short_id: `ct-${id}`, title: `Problem ${id}`, status: "open", created_at: now - 48 * H, updated_at: now - 2 * H, project_id: "p1",
  cause: { signal_count: 1, first_seen: now - 48 * H, last_seen: now - 2 * H, fingerprints: [] }, ...over,
});
const rollup = (over: Partial<RollupRow> = {}): RollupRow => ({ key: "p1", title: "P1", signalsDay: 0, causes: 0, build: 0, awaiting: 0, watching: 0, closed: 0, finders: 0, silent: 0, undeclared: [], hold: null, stalled: 0, failing: false, graphs: [], neverRun: 0, unapproved: 0, notReady: [], ready: 0, notReadyIds: [], startingOff: false, ...over });
const off: LineAdmission = { role: { id: "r", handle: "lead", paused: false }, on: false, slots: 1, busy: null, hands: null, handsCap: null };

describe("the line's inbox", () => {
  test("each thing waiting on the viewer is a row in its group, with the concrete detail", () => {
    const groups = buildLineInbox({
      signals: [],
      tasks: [
        cause("1"),
        cause("2", { readiness: "needs_context", readiness_note: "Which tenant\n saw it?" }),
        cause("3", { status: "in_review" }),
        cause("4", { workflow_run_id: "r4" }),
      ] as never,
      runs: [{ _id: "r4", task_id: "4", status: "failed", fail_reason: "prove timed out", created_at: now - 3 * H, updated_at: now - 2 * H }] as never,
      decisions: [{ _id: "d1", short_id: "sd-1", status: "pending", blocking: true, task_id: "1", workflow_run_id: "r1", created_at: now - H }],
      projects: [{ _id: "p1", title: "Codecast" }],
      rollups: [rollup({ causes: 3, hold: "@lead's line is off, so nothing starts on its own", startingOff: true })],
      admissions: new Map([["p1", off]]),
      now,
    });
    expect(groups.map((g) => g.kind)).toEqual(["decide", "failed", "confirm", "review", "stuck"]);
    const by = Object.fromEntries(groups.map((g) => [g.kind, g.rows]));
    expect(by.decide[0]).toMatchObject({ title: "Problem 1", ref: "ct-1", cardRef: "sd-1", runId: "r1" });
    expect(by.confirm[0]).toMatchObject({ ref: "ct-2", detail: null, ask: "Which tenant saw it?" });
    expect(by.review[0].ref).toBe("ct-3");
    expect(by.failed[0]).toMatchObject({ ref: "ct-4", runId: "r4", detail: "prove timed out" });
    expect(by.stuck[0]).toMatchObject({ title: "Codecast", detail: "Line off", waiting: 3, switchOff: true });
    // For you counts the problems; the project that cannot start is listed, never counted.
    expect(inboxCount(groups)).toBe(4);
  });

  test("a row asks the question grounding wrote, said as what to do", () => {
    expect(askLine("One report: the ledger shows it completed. A person needs to confirm which state is true. If cancelled, fix it.")).toBe("Confirm which state is true.");
    expect(askLine("Only 1 signal, and it is unclear this is a defect. A person must say which sender is Union's.")).toBe("Say which sender is Union's.");
    expect(askLine(null)).toBe("Is this a real problem?");
    // The card says the question once; only what the note says besides it sits under it.
    expect(askParts("The ledger shows it completed. It can't be worked yet because nobody knows the state. A person needs to confirm which state is true.")).toEqual({ question: "Confirm which state is true.", context: "The ledger shows it completed." });
    expect(askParts("A person must say which sender is ours.").context).toBeNull();
    expect(askParts("Akash took the call. It can't be worked yet because nothing says whether Quinn left.")).toEqual({ question: "Nothing says whether Quinn left.", context: "Akash took the call." });
    expect(askLine("One report. Nothing shows whether João was told. A person needs to supply that before anyone closes it.")).toBe("Nothing shows whether João was told: supply that before anyone closes it.");
  });

  test("a failed run on a closed problem, or an earlier failure before a newer run, waits on no one", () => {
    const groups = buildLineInbox({
      signals: [],
      tasks: [cause("5", { status: "done" }), cause("6")] as never,
      runs: [
        { _id: "a", task_id: "5", status: "failed", created_at: now - 3 * H, updated_at: now - 3 * H },
        { _id: "b", task_id: "6", status: "failed", created_at: now - 5 * H, updated_at: now - 5 * H },
        { _id: "c", task_id: "6", status: "completed", created_at: now - 4 * H, updated_at: now - 4 * H },
      ] as never,
      decisions: [],
      projects: [],
      rollups: [],
      admissions: new Map(),
      now,
    });
    expect(groups.find((g) => g.kind === "failed")).toBeUndefined();
  });

  test("failed runs read as the station and what happened there, and runs that stopped the same way are one line", () => {
    expect(failCause({ fail_reason: "max_visits=3 exceeded on implement" })).toMatchObject({ step: "implement", label: "Looped 3 times" });
    expect(failCause({ fail_reason: "no outgoing edge from prove (outcome success, review_verdict none)" })).toMatchObject({ step: "prove", label: "Finished, no next step" });
    expect(failCause({ fail_reason: "no outgoing edge from implement (outcome failure, review_verdict none)" })).toMatchObject({ step: "implement", label: "Failed, no next step" });
    expect(failCause({ fail_reason: "hand jx7f7qs killed after 180m at implement" })).toMatchObject({ step: "implement", label: "Out of time, 3h" });
    expect(failCause({ fail_reason: "something odd (detail)", current_node_id: "ship" })).toMatchObject({ step: "ship", label: "something odd", raw: "something odd (detail)" });
    const row = (k: string, reason: string, at: number): InboxRow => ({ key: k, kind: "failed", at, projectId: "p1", title: k, ref: k, detail: null, caseId: k, runId: k, cardId: null, cardRef: null, fail: failCause({ fail_reason: reason }) });
    const groups = groupFailures([
      row("a", "max_visits=3 exceeded on implement", 1), row("b", "max_visits=3 exceeded on implement", 5), row("c", "max_visits=3 exceeded on implement", 2),
      row("d", "hand x killed after 180m at implement", 3), row("e", "hand y killed after 90m at implement", 4),
      row("f", "max_visits=2 exceeded on prove", 9),
    ]);
    expect(groups.map((g) => [g.step, g.label, g.rows.length])).toEqual([["implement", "Looped 3 times", 3], ["implement", "Out of time", 2], ["prove", "Looped 2 times", 1]]);
    expect(groups[0].rows.map((r) => r.key)).toEqual(["b", "c", "a"]);
    expect(groups[0].newest).toBe(5);
  });

  test("a project's counts are the same picked or not: for you never exceeds open, and the projects sum to the whole", () => {
    const groups = buildLineInbox({
      signals: [],
      tasks: [cause("1", { status: "in_review" }), cause("2", { project_id: "p2", status: "in_review" }), cause("3")] as never,
      runs: [], decisions: [], projects: [{ _id: "p1", title: "P1" }, { _id: "p2", title: "P2" }],
      rollups: [rollup({ causes: 1, hold: "off", startingOff: true })], admissions: new Map([["p1", off]]), now,
    });
    const of = inboxProcessOf([], [{ _id: "1", project_id: "p1" }, { _id: "2", project_id: "p2" }, { _id: "3", project_id: "p1" }]);
    const drawn = of.task({ _id: "1", project_id: "p1" });
    const projectOf = (id: string) => (id === "2" ? "p2" : "p1");
    // Issue 3 is open and waits on no one; the in-review two wait on the viewer.
    const issue = (id: string, status: string) => ({ id, status, history: { attempts: [], closes: [], watches: [], occurrences: [], regressions: [], recurrences: [], ships: [], regressed: false, cameBack: false } } as unknown as LineIssue);
    const counts = lineProjectCounts(groups, of, drawn, [issue("1", "in_review"), issue("2", "in_review"), issue("3", "open")], projectOf);
    expect(counts.get("p1")).toEqual({ forYou: 1, open: 2 });
    expect(counts.get("p2")).toEqual({ forYou: 1, open: 1 });
    expect([...counts.values()].reduce((n, c) => n + c.forYou, 0)).toBe(inboxCount(groups));
  });
});
