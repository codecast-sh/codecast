import { describe, expect, test } from "bun:test";
import { peopleOf, personFor, riskText, type Person } from "../editionModel";
import { buildTimeline, type TimelineDay } from "../timelineModel";
import { EMPTY_URL, type ChangesUrl } from "../useChangesUrlState";
import { DAY, edition, story } from "./fixtures";

const url = (over: Partial<ChangesUrl> = {}): ChangesUrl => ({ ...EMPTY_URL, ...over });
const days = (stories: ReturnType<typeof story>[], u = url(), person: Person | null = null, editions: ReturnType<typeof edition>[] = [], weeks: ReturnType<typeof edition>[] = []) =>
  buildTimeline({ stories, editions, weeks, url: u, person, today: "2026-10-12" });
const shownKeys = (stories: ReturnType<typeof story>[], u: ChangesUrl, person: Person | null) =>
  days(stories, u, person).flatMap((d) => (d.kind === "day" ? [...d.stories, ...d.small].map((s) => s.story_key) : []));

describe("buildTimeline", () => {
  test("one entry per day with stories, newest first, heaviest story first", () => {
    const items = days([
      story("old", { date: "2026-09-30", importance: 3 }),
      story("small", { importance: 2, insertions: 1 }),
      story("big", { importance: 2, insertions: 900 }),
    ]);
    expect(items.map((i) => (i.kind === "day" ? i.date : i.week))).toEqual([DAY, "2026-09-30"]);
    expect((items[0] as TimelineDay).stories.map((s) => s.story_key)).toEqual(["big", "small"]);
  });

  test("the edition's one sentence heads its day once written, and its brief list folds", () => {
    const items = days([story("a", { importance: 4 }), story("b")], url(), null, [
      edition({ headline: "Uploads retry now", status: "final", brief_story_keys: ["b"] }),
    ]);
    const day = items[0] as TimelineDay;
    expect(day.summary).toBe("Uploads retry now");
    expect(day.stories.map((s) => s.story_key)).toEqual(["a"]);
    expect(day.small.map((s) => s.story_key)).toEqual(["b"]);
  });

  test("before an edition, importance 1 is housekeeping and the day has no sentence", () => {
    const day = days([story("a", { importance: 3 }), story("chore", { importance: 1 })])[0] as TimelineDay;
    expect(day.summary).toBeNull();
    expect(day.small.map((s) => s.story_key)).toEqual(["chore"]);
  });

  test("branch stories show only with all branches", () => {
    const stories = [story("main"), story("wip", { on_default_branch: false, importance: 2 })];
    expect(shownKeys(stories, url(), null)).toEqual(["main"]);
    expect(shownKeys(stories, url({ branches: "all" }), null).sort()).toEqual(["main", "wip"]);
  });

  test("area, risk and text filters hide what they miss, and a day with nothing left drops out", () => {
    const stories = [
      story("web", { area: "web", headline: "Line pages" }),
      story("cli", { area: "cli", risks: [{ code: "schema", evidence: [] }] }),
      story("quiet", { area: "docs", date: "2026-09-30" }),
    ];
    expect(shownKeys(stories, url({ areas: ["web"] }), null)).toEqual(["web"]);
    expect(shownKeys(stories, url({ risk: true }), null)).toEqual(["cli"]);
    expect(shownKeys(stories, url({ q: "pages" }), null)).toEqual(["web"]);
    expect(days(stories, url({ areas: ["web"] }))).toHaveLength(1);
    const day = days(stories, url({ areas: ["web"] }))[0] as TimelineDay;
    expect(day.total).toBe(2);
  });

  test("a finished week's notes sit where the timeline enters the week, only once written and never repeating a day", () => {
    const stories = [story("mon", { date: "2026-09-28" }), story("fri")];
    const weeks = [edition({ scope: "week", date: "2026-W40", headline: "Calls moved to one window", status: "final" })];
    const items = days(stories, url(), null, [], weeks);
    expect(items.map((i) => i.kind)).toEqual(["week", "day", "day"]);
    expect(days(stories, url(), null, [], [{ ...weeks[0], status: "facts" } as any]).map((i) => i.kind)).toEqual(["day", "day"]);
    // The week in progress, or notes that restate a day, add nothing.
    expect(buildTimeline({ stories, editions: [], weeks, url: url(), person: null, today: "2026-10-03" }).map((i) => i.kind)).toEqual(["day", "day"]);
    const echo = [edition({ headline: "Calls moved to one window", status: "final" })];
    expect(days(stories, url(), null, echo, weeks).map((i) => i.kind)).toEqual(["day", "day"]);
  });
});

describe("people", () => {
  const roster = [{ _id: "u_ana", name: "Ana Lopez" }, { _id: "u_ben", name: "" }] as any[];
  // Ana ran one session that committed under her name, and committed twice with no session.
  const stories = [
    story("session", { actor_user_ids: ["u_ana" as any], author_names: ["Ana Lopez"] }),
    story("commit1", { author_names: ["ana lopez "] }),
    story("commit2", { author_names: ["Ana Lopez"], area: "cli" }),
    story("other", { author_names: ["Cid"], area: "cli" }),
    story("blank", { actor_user_ids: ["u_ben" as any], author_names: [" "] }),
  ];

  test("one person per human: the roster name, every id and spelling that is them, blank names skipped", () => {
    expect(peopleOf(stories, roster)).toEqual([
      { key: "ana lopez", name: "Ana Lopez", userIds: ["u_ana"], authorNames: ["Ana Lopez", "ana lopez "] },
      { key: "cid", name: "Cid", userIds: [], authorNames: ["Cid"] },
    ]);
  });

  test("choosing the person keeps their session story and both commit-only stories", () => {
    const people = peopleOf(stories, roster);
    expect(shownKeys(stories, url({ person: "ana lopez" }), personFor("ana lopez", people)).sort()).toEqual(["commit1", "commit2", "session"]);
  });

  test("an agent or bot suffix is the same person", () => {
    const people = peopleOf([story("a", { author_names: ["Cid (agent)", "cid", "Cid[bot]"] })]);
    expect(people).toEqual([{ key: "cid", name: "Cid", userIds: [], authorNames: ["Cid (agent)", "cid", "Cid[bot]"] }]);
  });

  test("an older link naming the roster id finds the same three stories", () => {
    expect(shownKeys(stories, url({ person: "u_ana" }), personFor("u_ana", peopleOf(stories, roster)))).toHaveLength(3);
  });
});

describe("riskText", () => {
  const SHA = "0123456789abcdef0123456789abcdef01234567";

  test("a worded risk is its line alone, without the evidence it already explains", () => {
    const s = { risks: [{ code: "schema" as const, evidence: ["packages/convex/convex/schema.ts"] }], risk_lines: { schema: "The schema changed; deploy convex before web." } };
    expect(riskText(s)).toBe("The schema changed; deploy convex before web.");
  });

  test("an unworded risk is its code with evidence: full hashes cut to seven, a repeated file name dropped", () => {
    const s = {
      risks: [
        { code: "skew" as const, evidence: [SHA, "backend deployed 2026-10-02T10:00:00Z", `web shipped 2026-10-02T11:00:00Z at ${SHA}`] },
        { code: "schema" as const, evidence: ["packages/convex/convex/schema.ts", "packages/old/schema.ts"] },
      ],
      risk_lines: {},
    };
    expect(riskText(s)).toBe([
      "skew (0123456, backend deployed 2026-10-02T10:00:00Z, web shipped 2026-10-02T11:00:00Z at 0123456)",
      "schema (packages/convex/convex/schema.ts)",
    ].join("\n"));
    // One line for a tooltip that lists several stories.
    expect(riskText(s, "; ")).toContain(")\u003b schema (");
  });

  test("worded and unworded risks mix, and at most four evidence items show", () => {
    const s = {
      risks: [{ code: "bulk" as const, evidence: ["4200 lines", "a1", "a2", "a3", "a4"] }, { code: "revert" as const, evidence: [] }],
      risk_lines: { revert: "A revert of yesterday's import." },
    };
    expect(riskText(s)).toBe("bulk (4200 lines, a1, a2, a3, ...)\nA revert of yesterday's import.");
  });
});
