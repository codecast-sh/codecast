import { describe, expect, test } from "bun:test";
import { unplacedCountLine, unplacedLines, type UnplacedView } from "./orgUnplacedLines";

// coverage.unplaced as `cast org inputs`, `cast org health` and `cast brief` print it.
const NOW = 1_800_000_000_000;
const D = 86_400_000;
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
const view = (over: Partial<UnplacedView> = {}): UnplacedView => ({
  plans: [{ short_id: "pl-1048", title: "Remove the extraction layer", status: "active", open_tasks: 11, done_tasks: 3, age_days: 0, last_activity_at: NOW - 3_600_000, driver: { short_id: "jx70tq8", title: "x", last_active_at: NOW } }],
  projects: [{ short_id: "pj-9", title: "Broker escalations", open_tasks: 6, open_plans: 0, lead: null, age_days: 40, last_activity_at: NOW - 40 * D, driver: null }],
  loose_tasks: { total: 3, by_session: [{ session: { short_id: "jx1abcd", title: "Budget work", last_active_at: NOW }, tasks: 3, examples: [{ short_id: "ct-1", title: "a" }, { short_id: "ct-2", title: "b" }], age_days: 5, last_activity_at: NOW - D }] },
  sessions: [{ short_id: "jx2", title: "Long one", owner: "Ashot", age_days: 9, last_activity_at: NOW - D, bound: [{ kind: "plan", short_id: "pl-5" }], reason: "no project" }],
  truncated: false,
  ...over,
});

describe("unplaced lines", () => {
  test("one count line, then one line per item with its age, last move and driver", () => {
    const lines = unplacedLines(view(), NOW).map(strip);
    expect(lines[0]).toBe("  unplaced: 1 plan with no project · 1 project with no goal · 3 loose tasks from 1 session · 1 long session off any goal");
    expect(lines[1]).toBe("    plan    pl-1048 Remove the extraction layer · 11 open of 14 · active · new today · moved 1h ago · jx70tq8");
    expect(lines[2]).toBe("    project pj-9 Broker escalations · 6 open · no lead · 40d old · moved 40d ago · no session");
    expect(lines[3]).toBe("    tasks   jx1abcd Budget work · 3: ct-1, ct-2, … · oldest 5d · moved 1d ago");
    expect(lines[4]).toBe("    session jx2 Long one · 9d running · Ashot · on pl-5: no project · moved 1d ago");
  });

  test("nothing unplaced says so; a floor says it is one; no reading prints nothing", () => {
    expect(unplacedCountLine(view({ plans: [], projects: [], loose_tasks: { total: 0, by_session: [] }, sessions: [] }))).toBe("nothing: every live plan and project reaches a goal");
    expect(unplacedCountLine(view({ truncated: true }))).toEndWith("(a floor)");
    expect(unplacedLines(null, NOW)).toEqual([]);
  });
});
