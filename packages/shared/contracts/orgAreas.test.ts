import { describe, expect, test } from "bun:test";
import { AREA_STATUSES, AREA_STATUS_WORDS, areaChangeLine, areaSignalsOf, areaStatusLine, areaStatusOf, newestStandingFirst, type AreaInput } from "./orgAreas";

// An area as a person reads it (docs/architecture/org-staffing.md S29): the
// status word the signals add up to, most pressing first; the sentence it
// stands on; at most three signals, each a reason to act, in plain words.

const quiet: AreaInput = {
  role_status: "active", has_standing: true, standing_waits_on_person: false, standing_state_line: null,
  waiting_unanswered: 0, waiting_total: 0, review_stalls: 0, blocked_sessions: 0,
  overloaded: false, overloaded_by: [], idle_days: 2, age_days: 40, idle: false, program_ended: null,
};
const on = (over: Partial<AreaInput>): AreaInput => ({ ...quiet, ...over });

describe("areaStatusOf", () => {
  test("the most pressing fact names the status, in this order", () => {
    expect(areaStatusOf(quiet)).toBe("on_track");
    expect(areaStatusOf(on({ idle: true, idle_days: 20 }))).toBe("quiet");
    expect(areaStatusOf(on({ idle: true, overloaded: true, overloaded_by: ["9 decisions a day"] }))).toBe("overloaded");
    expect(areaStatusOf(on({ overloaded: true, review_stalls: 1 }))).toBe("stuck");
    expect(areaStatusOf(on({ waiting_unanswered: 1 }))).toBe("stuck");
    expect(areaStatusOf(on({ blocked_sessions: 2 }))).toBe("stuck");
    expect(areaStatusOf(on({ review_stalls: 3, standing_waits_on_person: true, standing_state_line: "Needs your call" }))).toBe("waiting_on_you");
    expect(areaStatusOf(on({ standing_waits_on_person: true, has_standing: false }))).toBe("not_started");
    expect(areaStatusOf(on({ standing_waits_on_person: true, role_status: "paused" }))).toBe("paused");
    // Young waits alone are not a stall: the role has a day to answer them.
    expect(areaStatusOf(on({ waiting_total: 4 }))).toBe("on_track");
  });

  test("every status has its words", () => {
    for (const s of AREA_STATUSES) expect(AREA_STATUS_WORDS[s]).toMatch(/^[a-z ]+$/);
    expect(AREA_STATUS_WORDS.waiting_on_you).toBe("waiting on you");
  });
});

describe("areaStatusLine and areaSignalsOf", () => {
  test("a stuck area says what is stuck; its signals lead with the oldest wait", () => {
    const a = on({ waiting_unanswered: 1, waiting_total: 3, review_stalls: 2, blocked_sessions: 1, overloaded: true, overloaded_by: ["9 decisions a day"], idle: false });
    expect(areaStatusLine(a, "stuck")).toBe("Stuck: 1 session under it waiting unanswered, 2 tasks stuck in review, 1 task blocked.");
    const signals = areaSignalsOf(a);
    expect(signals).toHaveLength(3);
    expect(signals.map((s) => s.code)).toEqual(["waiting_sessions", "review_stall", "blocked_sessions"]);
    expect(signals[0]).toEqual({ code: "waiting_sessions", severity: "warn", text: "1 session under it has waited more than a day with no answer from it." });
  });

  test("a role that raised something leads with that; young waits are information", () => {
    const a = on({ standing_waits_on_person: true, standing_state_line: "Which market first?", waiting_total: 2 });
    expect(areaStatusLine(a, "waiting_on_you")).toBe("Waiting on you: Which market first?");
    expect(areaSignalsOf(a).map((s) => `${s.severity}:${s.code}`)).toEqual(["blocker:raised", "info:waiting_sessions"]);
    expect(areaSignalsOf(a)[1].text).toBe("2 sessions under it are waiting on someone.");
  });

  test("overloaded, quiet and an ended program read as sentences without the model's numbers", () => {
    const over = on({ overloaded: true, overloaded_by: ["9 decisions a day", "13 sessions at once"] });
    expect(areaStatusLine(over, "overloaded")).toBe("Overloaded: 9 decisions a day, 13 sessions at once.");
    expect(areaSignalsOf(over)[0].text).toBe("More reaches it than one role can answer: 9 decisions a day, 13 sessions at once.");
    expect(areaStatusLine(on({ idle: true, idle_days: 21 }), "quiet")).toBe("Quiet: nothing has moved for 21 days.");
    expect(areaStatusLine(on({ idle: true, idle_days: null, age_days: 15 }), "quiet")).toBe("Quiet: nothing has moved since it started 15 days ago.");
    const ended = on({ program_ended: { ended: "its plan pl-3 is done", then: "retire" } });
    expect(areaSignalsOf(ended)[0].text).toBe("The work it was hired for ended: its plan pl-3 is done. Its tenure says retire it.");
    expect(areaStatusLine(on({ role_status: "paused" }), "paused")).toBe("Paused: its checks hold until you resume it.");
    expect(areaStatusLine(quiet, "on_track")).toBe("On track.");
  });

  test("no line a person reads carries the old model's words", () => {
    const every = [quiet, on({ waiting_unanswered: 2, review_stalls: 1, blocked_sessions: 1, overloaded: true, overloaded_by: ["40 items changing a day"], idle: true, idle_days: 30, program_ended: { ended: "its date is past", then: "review" }, standing_waits_on_person: true, standing_state_line: "x" })];
    const banned = /\bhands?\b|\bcap\b|cap hit|ledger|model:|breach|budget/i;
    for (const a of every) {
      const status = areaStatusOf(a);
      expect(areaStatusLine(a, status)).not.toMatch(banned);
      for (const s of areaSignalsOf(a)) expect(s.text).not.toMatch(banned);
    }
  });
});

describe("the watch's change line", () => {
  test("a lasting status names the role, the word and what it came from; an unowned project names itself", () => {
    expect(areaChangeLine({ kind: "status", role_handle: "growth", role_name: "Growth lead", from: "on_track", to: "stuck", since: 1, line: "Stuck: 2 tasks stuck in review." }))
      .toBe("Growth lead (@growth) has read stuck at two checks in a row, was on track. Stuck: 2 tasks stuck in review.");
    expect(areaChangeLine({ kind: "status", role_handle: "growth", role_name: "Growth lead", from: null, to: "overloaded", since: 1, line: "" }))
      .toBe("Growth lead (@growth) has read overloaded at two checks in a row.");
    expect(areaChangeLine({ kind: "unowned_project", project_id: "p", project_title: "Platform", since: 1, line: "" }))
      .toBe('The project "Platform" has work and no role looking after it.');
  });

  test("newest dated line first; undated lines keep their order after", () => {
    const lines = [{ written_at: null, k: "a" }, { written_at: 5, k: "b" }, { written_at: 9, k: "c" }, { written_at: null, k: "d" }];
    expect(newestStandingFirst(lines).map((l) => l.k)).toEqual(["c", "b", "a", "d"]);
  });
});
