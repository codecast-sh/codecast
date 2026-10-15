import { describe, expect, test } from "bun:test";
import { DAY, agoWords, arrivalOf, placementMix, sumArrivals, usd, versionWords, wrongShare } from "../flowStages";

const NOW = Date.UTC(2026, 9, 14, 12);

describe("whether moments are arriving", () => {
  test("nothing for days reads quiet with when the last came, never a rate", () => {
    // The AgentWatch trial on Oct 14: 1,457 moments held, none arrived in five days.
    const days = [0, 0, 0, 0, 0, 0, 0, 0, 120, 300, 0, 0, 0, 0];
    const a = arrivalOf(days, NOW - 5 * DAY, NOW);
    expect(a).toEqual({ tone: "quiet", today: 0, week: 420, lastAt: NOW - 5 * DAY });
    expect(agoWords(a.lastAt, NOW)).toBe("5 days");
  });
  test("an arrival in the last day is live; none ever is none", () => {
    expect(arrivalOf([0, 2, 5], NOW - 3_600_000, NOW).tone).toBe("live");
    expect(arrivalOf([0, 0, 0], null, NOW).tone).toBe("none");
  });
  test("kinds sum day by day, aligned on today, and the newest arrival wins", () => {
    const s = sumArrivals([{ days: [1, 2, 3], newest_at: NOW - 2 * DAY }, { days: [5, 0], newest_at: NOW - DAY / 2 }], NOW);
    expect(s.days).toEqual([1, 7, 3]);
    expect(s.lastAt).toBe(NOW - DAY / 2);
    expect(s.tone).toBe("live");
  });
});

describe("how grouping placed findings", () => {
  test("counts the window's findings of the project by placement, in the rule's order, a finding with none as held", () => {
    const rows = [
      { attach: "new", created_at: NOW - DAY, project_id: "p" },
      { attach: "similar", created_at: NOW - DAY, project_id: "p" },
      { attach: "similar", created_at: NOW - 2 * DAY, project_id: "p" },
      { attach: undefined, created_at: NOW - DAY, project_id: "p" },
      { attach: "judge", created_at: NOW - 9 * DAY, project_id: "p" },
      { attach: "new", created_at: NOW - DAY, project_id: "other" },
    ];
    expect(placementMix(rows, "p", NOW - 7 * DAY).map((m) => [m.key, m.n])).toEqual([["similar", 2], ["new", 1], ["held", 1]]);
  });
});

describe("words and numbers a stage shows", () => {
  test("money, versions and shares", () => {
    expect(usd(1617.51)).toBe("$1,618");
    expect(usd(6.29)).toBe("$6.29");
    expect(usd(0)).toBe("$0");
    expect(usd(null)).toBe("–");
    expect(versionWords(12)).toBe("v12");
    expect(versionWords("ae375ee666")).toBe("ae375ee");
    expect(wrongShare(0, 0)).toBeNull();
    expect(wrongShare(1, 200)).toBe("<1%");
    expect(wrongShare(4, 100)).toBe("4%");
  });
});

describe("cases against a judge", () => {
  test("are not counted as findings grouping placed", () => {
    const rows = [{ attach: "new", created_at: NOW, project_id: "p", source: "judge-review" }, { attach: "new", created_at: NOW, project_id: "p", source: "judge:call" }];
    expect(placementMix(rows, "p", NOW - DAY)).toEqual([{ key: "new", label: "Opened a problem", tone: "new", n: 1 }]);
  });
});

describe("the Decision stage counts what For you lists", () => {
  test("every counted need of the line in its project, trial practice included and told apart", async () => {
    const { forYouOfLine } = await import("../flowStages");
    const need = (o: Record<string, unknown>) => ({ counted: true, trial: false, kind: "decision", publishes: false, process: "agentwatch", projectId: "p", ...o }) as never;
    const needs = [need({ trial: true }), need({ trial: true }), need({}), need({ counted: false }), need({ process: "line" }), need({ projectId: "q" })];
    expect(forYouOfLine(needs, "agentwatch", "p")).toEqual({ total: 3, practice: 2 });
    expect(forYouOfLine(needs, "agentwatch", null)).toEqual({ total: 4, practice: 2 });
  });
});
