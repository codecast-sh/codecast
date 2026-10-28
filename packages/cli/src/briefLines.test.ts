import { describe, expect, test } from "bun:test";
import { authorityLine, briefCharterLines, briefHandLine, briefInitiativeLines, briefProjectNumberLines, briefServesNumbers, standingSessionLine, wakeLine } from "./briefLines";
import { stripAnsi } from "@platform/cli-kit/render";

// The brief's hand line reads the server's BriefHand shape: `state`, not
// `work_state` (the review caught every hand printing "undefined").
describe("briefHandLine", () => {
  test("prints the state, the task's handoff status and its review verdict", () => {
    const line = briefHandLine({ short_id: "jxhand1", title: "Fix the deploy", state: "working", task: { short_id: "ct-5", status: "in_review", execution_status: "done", review_verdict: "changes" } });
    expect(line).toContain("jxhand1");
    expect(line).toContain("· working");
    expect(line).toContain("ct-5 in_review (done) · review changes");
    expect(line).not.toContain("undefined");
  });
  test("a hand with no task prints its state alone", () => {
    const line = briefHandLine({ short_id: "jxhand2", title: "Spike", state: "idle", task: null });
    expect(line).toContain("· idle");
    expect(line).not.toContain("undefined");
  });
});

describe("briefCharterLines", () => {
  test("prints the charter body under its header, and says when there is none", () => {
    const lines = briefCharterLines("# Charter\nOwn the deploys.");
    expect(lines.some((l) => l.includes("## Charter"))).toBe(true);
    expect(lines).toContain("  Own the deploys.");
    expect(briefCharterLines("   ").some((l) => l.includes("no charter yet"))).toBe(true);
  });
});

// The initiatives the role serves (org-staffing.md S25): the owned ones lead,
// each with its health as last said and when, so a check sees a stale read.
describe("briefInitiativeLines", () => {
  const now = Date.parse("2026-10-02T12:00:00Z");
  test("owned first, health with its date, no update yet when none", () => {
    const lines = briefInitiativeLines([
      { short_id: "in-4", title: "Win the private network", health: "at_risk", health_at: now - 11 * 86_400_000, owned: true, metrics: ["Weekly active teams: 412 of 1,000, behind (11 days ago)"], chain: ["Reach 1k teams"] },
      { short_id: "in-9", title: "Docs that match the product", health: "none", health_at: null, owned: false, metrics: [], chain: [] },
    ], now).map(stripAnsi);
    expect(lines[0]).toBe("  initiatives it serves:");
    expect(lines[1]).toBe("    in-4 Win the private network · owns it · at risk, said Sep 21 · under Reach 1k teams · Weekly active teams: 412 of 1,000, behind (11 days ago)");
    expect(lines[2]).toBe("    in-9 Docs that match the product · its project carries it · no update yet");
    expect(briefInitiativeLines([], now)).toEqual([]);
  });
});

// The standing session line carries the session's own state (S29): a Head of
// People reading a lead's brief sees where the lead stands with no second read.
describe("standingSessionLine", () => {
  test("prints the work state, the pinned status and line beside the id", () => {
    const role = { standing_short_id: "jx7b88a", routine: { short_id: "tr-1151", status: "scheduled", run_at: null } };
    expect(stripAnsi(standingSessionLine(role, { state: "dormant", state_status: "blocked", state_line: "Waiting on the pricing decision" }, 0))).toBe("  standing session: jx7b88a · blocked · Waiting on the pricing decision");
    expect(stripAnsi(standingSessionLine(role, { state: "working", state_status: null, state_line: null }, 0))).toBe("  standing session: jx7b88a · working");
    expect(stripAnsi(standingSessionLine({ standing_short_id: null, routine: null }, null, 0))).toBe("  standing session: none · no trigger yet");
  });
});

// How the role's check runs (org-staffing.md S38): read off the trigger, with
// the one command that changes it and no trigger id in it.
describe("wakeLine", () => {
  test("prints the cadence, the gate, the focus and the reason, then the role's own command", () => {
    const [line] = wakeLine({ interval_ms: 86_400_000, wake: { every_ms: 12 * 3_600_000, precheck: "git diff --quiet", focus: "the launch queue", why: "launch week", tuned_at: Date.parse("2026-10-01T09:00:00Z") } }).map(stripAnsi);
    expect(line).toContain("its check runs every 12 hours · only when `git diff --quiet` passes · focus: the launch queue · changed 2026-10-01: launch week");
    expect(line).toContain("cast role tune --every <1h to 7d>");
    expect(line).not.toMatch(/tr-\d|cast trigger/);
  });
  test("a routine read from an older server still prints its cadence; a role with no trigger prints nothing", () => {
    expect(stripAnsi(wakeLine({ interval_ms: 86_400_000 })[0])).toContain("its check runs every day");
    expect(wakeLine(null)).toEqual([]);
  });
});

// A grant's expiry is in the future; the past-only relative form printed every
// one as "until just now".
describe("authorityLine", () => {
  test("prints a held grant's expiry as its date and leaves expired grants out", () => {
    const now = new Date(2026, 9, 12).getTime(), day = 86_400_000;
    const line = stripAnsi(authorityLine({ authority: [{ kind: "spend", label: "Ads", expires_at: now + 90 * day }, { kind: "write", label: "Old", expires_at: now - day }] }, now));
    expect(line).toBe("  authority outside codecast: spend (Ads, until Jan 10, 2027)");
  });
});

describe("an area read by numbers", () => {
  test("project numbers print under their project, and only an area with a number is told how to move it", () => {
    expect(briefProjectNumberLines([{ short_id: "pj-3", title: "Outreach", metrics: ["Cold emails a day: 1,000/day of 10,000, behind (live mw-1, today)"] }]).map(stripAnsi)).toEqual([
      "  project numbers:",
      "    pj-3 Outreach · Cold emails a day: 1,000/day of 10,000, behind (live mw-1, today)",
    ]);
    expect(briefServesNumbers({ initiatives: [{ metrics: [] }], project_numbers: [] })).toBe(false);
    expect(briefServesNumbers({ initiatives: [{ metrics: ["x"] }] })).toBe(true);
    expect(briefServesNumbers({ project_numbers: [{ metrics: ["x"] }] })).toBe(true);
  });
});
