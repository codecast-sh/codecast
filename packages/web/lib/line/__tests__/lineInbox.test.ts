import { describe, expect, test } from "bun:test";
import { buildLineInbox, inboxCount } from "../lineInbox";
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
    expect(groups.map((g) => g.kind)).toEqual(["decide", "question", "review", "failed", "stuck"]);
    const by = Object.fromEntries(groups.map((g) => [g.kind, g.rows]));
    expect(by.decide[0]).toMatchObject({ title: "Problem 1", ref: "ct-1", cardRef: "sd-1", runId: "r1" });
    expect(by.question[0]).toMatchObject({ ref: "ct-2", detail: null });
    expect(by.review[0].ref).toBe("ct-3");
    expect(by.failed[0]).toMatchObject({ ref: "ct-4", runId: "r4", detail: "prove timed out" });
    expect(by.stuck[0]).toMatchObject({ title: "Codecast", detail: "Line off", waiting: 3, switchOff: true });
    expect(inboxCount(groups)).toBe(5);
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
});
