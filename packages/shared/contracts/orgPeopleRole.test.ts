import { describe, expect, test } from "bun:test";
import { areaSignalsOf, areaStatusLine, areaStatusOf, type AreaInput } from "./orgAreas";
import { reportWaitsWords, roleReportLines } from "./personProfile";
import { formatScheduledTask, parseScheduledTask, roleCardLines, type RoleCard } from "./machineMessages";

// A role's side of people reporting to it (docs/architecture/org-people.md
// P2): the card line each wake carries, the stuck reading in health, and the
// list `cast org show` prints.

const quiet: AreaInput = {
  role_status: "active", has_standing: true, standing_waits_on_person: false, standing_state_line: null,
  waiting_unanswered: 0, waiting_total: 0, review_stalls: 0, blocked_sessions: 0,
  overloaded: false, overloaded_by: [], idle_days: 2, age_days: 40, idle: false, program_ended: null,
};

describe("health counts what waits on a role's people", () => {
  test("a decision or a review past a day on one of its people reads stuck, with the reason in words", () => {
    const a: AreaInput = { ...quiet, people_waiting: [{ name: "Dana", decisions: 2, review_stalls: 0 }, { name: "Lee", decisions: 1, review_stalls: 1 }] };
    expect(areaStatusOf(a)).toBe("stuck");
    expect(areaStatusLine(a, "stuck")).toBe("Stuck: 2 decisions on Dana, 1 decision and 1 task in review on Lee.");
    expect(areaSignalsOf(a)).toEqual([{ code: "people_waiting", severity: "warn", text: "Waiting more than a day on people who report to it: Dana (2 decisions), Lee (1 decision and 1 task in review)." }]);
  });

  test("nobody waiting leaves the status alone", () => {
    expect(areaStatusOf({ ...quiet, people_waiting: [] })).toBe("on_track");
    expect(areaSignalsOf({ ...quiet, people_waiting: [] })).toEqual([]);
  });
});

describe("the role card's people", () => {
  const card: RoleCard = {
    handle: "growth", name: "Growth lead", reports_to: "Ashot", scope: ["Growth"], goals: [],
    people: [
      { line: "Dana @dana · Designer · onboarding", waits: reportWaitsWords({ decisions_over_day: 1, open_tasks: 3, review_over_day: 0 }) },
      { line: "Lee @lee", waits: [] },
    ],
  };

  test("one line per person, with what waits on them", () => {
    expect(roleCardLines(card)).toEqual([
      "Looks after: Growth",
      "Reports to it: Dana @dana · Designer · onboarding · waits on them: 1 decision waiting over a day, 3 open tasks",
      "Reports to it: Lee @lee",
    ]);
  });

  test("the wake frame round-trips the people", () => {
    const parsed = parseScheduledTask(formatScheduledTask({ title: "Check", body: "go", role: card }));
    expect(parsed?.role?.people).toEqual(card.people);
  });

  test("the waits read most pressing first and say nothing when nothing waits", () => {
    expect(reportWaitsWords({ decisions_over_day: 2, open_tasks: 1, review_over_day: 1 })).toEqual(["2 decisions waiting over a day", "1 task in review over a day", "1 open task"]);
    expect(reportWaitsWords({ decisions_over_day: 0, open_tasks: 0, review_over_day: 0 })).toEqual([]);
  });
});

describe("roleReportLines (cast org show)", () => {
  test("lists the people whose managers name the role, one short line each", () => {
    const people = [
      { name: "Dana", handle: "dana", role: "member", is_me: true, title: "Designer", managers: [{ kind: "user", user_id: "u1" }, { kind: "role", role_id: "r1" }] },
      { name: "Lee", handle: "lee", role: "admin", managers: [{ kind: "role", role_id: "r2" }] },
      { name: "Kim", role: "member" },
    ];
    expect(roleReportLines("r1", people)).toEqual(["Dana @dana · Designer"]);
    expect(roleReportLines("r3", people)).toEqual([]);
  });
});
