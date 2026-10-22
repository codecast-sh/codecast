import { describe, expect, test } from "bun:test";
import { becameOf, decisionEvents, findingIndex, groupCounts, kindWords, sourceWords, timelineRows, timelineSources, type ChainIndex, type TimelineEvent } from "../lineTimeline";

const ws = "team:t1";
const ev = (e: Partial<TimelineEvent> & Pick<TimelineEvent, "_id" | "at" | "kind">): TimelineEvent => ({ workspace: ws, source: "line", title: "x", ...e });

const moment = ev({ _id: "moment:m1", at: 100, kind: "moment", source: "acme-moments", title: "Pat Doe", moment: "mo-1" });
const finding = ev({ _id: "signal:s1", at: 200, kind: "finding", source: "judge:comms", title: "Promised a call and never called", moment: "mo-1", signal: "s1", signal_ref: "sg-1", task: "t1", task_ref: "ct-1" });
const opened = ev({ _id: "task:t1:opened", at: 210, kind: "problem_opened", title: "Missed callbacks", task: "t1", task_ref: "ct-1" });
const station = ev({ _id: "run:r1:prove:300", at: 300, kind: "station", node: "Prove", title: "Missed callbacks", task: "t1", run: "r1" });
const err = ev({ _id: "event:e1", at: 150, kind: "error", source: "acme-web", title: "TypeError", group: "eg-4", project_id: "p2" });

const index = (over: Partial<ChainIndex> = {}): ChainIndex => {
  const { byMoment, byGroup } = findingIndex([moment, finding, opened, station, err]);
  return {
    tasks: new Map([["t1", { short_id: "ct-1", status: "in_review" }]]),
    runOf: new Map([["t1", { _id: "r1", status: "waiting" }]]),
    decisionOf: new Map([["t1", { _id: "d1", short_id: "sd-9", status: "pending" }]]),
    deployOf: new Map(),
    findingsOfMoment: byMoment,
    findingsOfGroup: byGroup,
    ...over,
  };
};

describe("lineTimeline", () => {
  test("rows: newest first, inside the complete range, steps folded unless asked", () => {
    const all = [moment, finding, opened, station, err];
    expect(timelineRows(all, {}).map((e) => e._id)).toEqual(["task:t1:opened", "signal:s1", "event:e1", "moment:m1"]);
    expect(timelineRows(all, { stations: true })[0]._id).toBe("run:r1:prove:300");
    expect(timelineRows(all, { floor: 160 }).map((e) => e._id)).toEqual(["task:t1:opened", "signal:s1"]);
  });

  test("filters: kind group, source, and a project narrows only events that name one", () => {
    const all = [moment, finding, opened, err];
    expect(timelineRows(all, { groups: new Set(["findings"] as const) }).map((e) => e._id)).toEqual(["signal:s1"]);
    expect(timelineRows(all, { sources: new Set(["acme-web"]) }).map((e) => e._id)).toEqual(["event:e1"]);
    expect(timelineRows(all, { project: "p1" }).map((e) => e._id)).not.toContain("event:e1");
    expect(groupCounts(all, null)).toMatchObject({ conversations: 1, findings: 1, problems: 1, errors: 1 });
    expect(timelineSources(all, null).map((s) => s.label)).toEqual(["Acme moments", "Acme web", "Codecast comms judge", "Line"]);
  });

  test("a moment becomes its finding, then the problem, its run and the decision waiting on you", () => {
    expect(becameOf(moment, index(), 1000)).toEqual([
      { kind: "finding", ref: "sg-1", id: "s1" },
      { kind: "problem", ref: "ct-1", id: "t1", state: "waiting on you" },
      { kind: "run", id: "r1", state: "waiting" },
      { kind: "decision", id: "d1", ref: "sd-9", state: "waiting on you" },
    ]);
  });

  test("a merged problem names the problem it went into", () => {
    const ix = index({ tasks: new Map([["t1", { short_id: "ct-1", status: "dropped", merged_into_ref: "ct-7" }]]), runOf: new Map(), decisionOf: new Map() });
    expect(becameOf(finding, ix, 1000)).toEqual([{ kind: "problem", ref: "ct-1", id: "t1", state: "merged into ct-7" }]);
  });

  test("decisions: a line card's source is the line; a session's card names the session that asked", () => {
    const line = decisionEvents({ _id: "d1", short_id: "sd-9", question: "Ship it?", status: "answered", created_at: 5, resolved_at: 9, task_id: "t1", workflow_run_id: "r1", answer_index: 0, options: [{ label: "Ship" }] }, ws, () => "ct-1");
    expect(line.map((e) => [e.kind, e.source, e.detail ?? null])).toEqual([["decision_asked", "line", null], ["decision_answered", "line", "Ship"]]);
    const session = decisionEvents({ _id: "d2", question: "Which sender?", status: "pending", created_at: 7, conversation_id: "c1", session_title: "Cockpit sender personas" }, ws, () => undefined);
    expect(session).toHaveLength(1);
    expect(sourceWords(session[0])).toBe("Cockpit sender personas");
    expect(kindWords(session[0])).toBe("Asked you");
  });
});
