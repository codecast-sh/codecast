import { describe, expect, test } from "bun:test";
import type { OpsGroup } from "./opsTypes";
import { DEFAULT_QUERY, FIX_STAGE_LABEL, FIX_STAGE_SHORT, escalation, escalationWords, filterIssues, issueOwner, lastDayStart, occurrencesSince, taskOwner, taskStateWord, usersOf, usersText, type FixTask, type IssueCtx } from "./issuesModel";

const HOUR = 3600_000;
const NOW = Date.UTC(2026, 10, 4, 15, 37);
const g = (over: Partial<OpsGroup> = {}): OpsGroup =>
  ({ _id: `g${Math.random()}`, short_id: "eg-1", source_id: "s1", kind: "error", title: "Credit runway below 30 days", status: "open", count: 3, first_seen: NOW - 5 * 24 * HOUR, last_seen: NOW - HOUR, buckets: [], ...over }) as OpsGroup;

describe("an issue's owner", () => {
  const other: FixTask = { title: "Defer candidate_score_ready broker triggers while the provider circuit is open", status: "in_review", assignee: "role-1" };
  const own: FixTask = { title: "Credit runway below 30 days", status: "open", assignee: "u1" };

  test("comes from its task only when the task was filed for this issue", () => {
    expect(taskOwner(g(), other)).toBeNull();
    expect(taskOwner(g(), own)).toBe("u1");
  });

  test("Mine and the page read the same rule", () => {
    const ctx: IssueCtx = { taskStatus: (id) => (id === "t-other" ? { ...other, assignee: "u1" } : own), me: "u1" };
    const borrowed = g({ signal_task_id: "t-other" });
    const filed = g({ signal_task_id: "t-own" });
    expect(issueOwner(borrowed, ctx)).toBeNull();
    expect(filterIssues([borrowed, filed], { ...DEFAULT_QUERY, lane: "all", mine: true }, ctx, NOW)).toEqual([filed]);
  });
});

describe("one way to write each number", () => {
  test("people: exact reads N users, a late count reads ≥N", () => {
    expect(usersText(usersOf(g({ users: 2 }))!)).toBe("2 users");
    expect(usersText(usersOf(g({ users: 1 }))!)).toBe("1 user");
    expect(usersText(usersOf(g({ users: 2, users_since: NOW - HOUR }))!, false)).toBe("≥2");
    expect(usersOf(g())).toBeNull();
  });

  test("a dissolved task reads dissolved everywhere, never done", () => {
    expect(taskStateWord({ status: "done", cause: { dissolved: { at: NOW } } })).toBe("dissolved");
    expect(taskStateWord({ status: "in_review" })).toBe("in review");
  });

  test("the Fix facet and the Fix column use the same words", () => {
    for (const k of Object.keys(FIX_STAGE_LABEL) as (keyof typeof FIX_STAGE_LABEL)[]) if (k !== "none") expect(FIX_STAGE_SHORT[k]).toBe(FIX_STAGE_LABEL[k]);
  });

  test("the last 24 hours on the contributors card count exactly what the issue's own page counts", () => {
    const buckets = Array.from({ length: 30 }, (_, i) => ({ hour: Math.floor(NOW / HOUR) * HOUR - i * HOUR, count: 10 }));
    const grp = g({ buckets, last_seen: NOW - 60_000 });
    const c = occurrencesSince(grp, lastDayStart(NOW), NOW);
    expect(c).toEqual({ n: escalation(grp, NOW).recent, exact: true });
  });

  test("the escalation line carries the day's average rate the × factor divides", () => {
    const buckets = [
      ...Array.from({ length: 48 }, (_, i) => ({ hour: Math.floor(NOW / HOUR) * HOUR - (71 - i) * HOUR, count: 13 })),
      ...Array.from({ length: 24 }, (_, i) => ({ hour: Math.floor(NOW / HOUR) * HOUR - (23 - i) * HOUR, count: 40 })),
    ];
    const e = escalation(g({ buckets }), NOW);
    expect(escalationWords(e)).toContain("avg 40/h vs usual 13/h");
  });
});
