import { describe, expect, test } from "bun:test";
import { EMPTY_URL, type ChangesUrl } from "../useChangesUrlState";
import { buildWeek, weekNotes } from "../weekModel";
import { provenanceText } from "../ChangesFooter";
import { changesDayLabel } from "../../../lib/changesDay";
import { edition, story } from "./fixtures";

const MON = "2026-09-28";
const TUE = "2026-09-29";
const WED = "2026-09-30";

const url = (over: Partial<ChangesUrl> = {}): ChangesUrl => ({ ...EMPTY_URL, ...over });
const stats = (commits: number, stories: number, releases = 0) => ({ commits, stories, releases, people: 1, sessions: 1, private_sessions: 0 });

function fixture() {
  const stories = [
    story("a", { date: MON, importance: 4, insertions: 400, author_names: ["Ada"] }),
    story("b", { date: MON, importance: 1, kind: "docs", area: "docs", area_counts: { docs: 3 }, author_names: ["Ada"] }),
    story("c", { date: TUE, importance: 3, area: "cli", area_counts: { cli: 2 }, author_names: ["Ben"] }),
    story("x", { date: TUE, on_default_branch: false, importance: 5, branch: "ben/wip" }),
  ];
  const editions = [
    edition({ _id: "d1" as any, date: MON, status: "final", headline: "Line pages land", stats: stats(5, 2, 1), releases: [{ surface: "cli", version: "1.1.157", sha: "c1", at: 1 }] }),
    edition({ _id: "d2" as any, date: TUE, status: "facts", headline: "3 commits, 1 story", stats: stats(3, 1, 1), releases: [{ surface: "cli", version: "1.1.158", sha: "c2", at: 2 }] }),
  ];
  return { stories, editions };
}

describe("buildWeek", () => {
  test("before the week edition arrives, facts come from the days: stats line, heaviest five, ledger, areas", () => {
    const { stories, editions } = fixture();
    const w = buildWeek({ days: [MON, TUE, WED], stories, editions, week: undefined, url: url() });
    expect(w.prose).toBe(false);
    expect(w.headline).toBe("8 commits, 2 releases, 3 stories");
    expect(w.standfirst).toBeNull();
    expect(w.stats).toMatchObject({ commits: 8, stories: 3, releases: 2, people: 2 });
    expect(w.top.map((s) => s.story_key)).toEqual(["a", "c", "b"]);
    expect(w.ledger).toEqual([{ surface: "cli", count: 2, first: "1.1.157", last: "1.1.158", at: 2 }]);
    expect(w.areas.map((a) => a.area)).toEqual(["docs", "cli", "web"]);
    expect(w.days).toEqual([
      { date: MON, headline: "Line pages land", prose: true, commits: 5, stories: 2, quiet: false },
      { date: TUE, headline: "3 commits, 1 release, 1 story", prose: false, commits: 3, stories: 1, quiet: false },
      { date: WED, headline: "0 commits, 0 stories", prose: false, commits: 0, stories: 0, quiet: true },
    ]);
  });

  test("the week edition's prose and pick lead; picks missing from the store fall back to the heaviest", () => {
    const { stories, editions } = fixture();
    const week = edition({ scope: "week", date: "2026-W40", status: "written", headline: "A CLI week", narrative: "One. Two. Three.", top_story_keys: ["c", "gone", "b"] });
    const w = buildWeek({ days: [MON, TUE], stories, editions, week, url: url() });
    expect(w).toMatchObject({ prose: true, headline: "A CLI week", standfirst: "One. Two. Three." });
    expect(w.top.map((s) => s.story_key)).toEqual(["c", "b", "a"]);
  });

  test("a week edition without prose keeps the stats line; all branches brings branch stories in", () => {
    const { stories, editions } = fixture();
    const week = edition({ scope: "week", date: "2026-W40", status: "facts", headline: "8 commits, 2 releases, 3 stories" });
    const w = buildWeek({ days: [MON, TUE], stories, editions, week, url: url({ branches: "all" }) });
    expect(w.prose).toBe(false);
    expect(w.top[0].story_key).toBe("x");
    expect(w.stories).toHaveLength(4);
  });

  test("filters narrow the biggest stories and say so, but never touch the head, the days or the areas", () => {
    const { stories, editions } = fixture();
    const week = edition({ scope: "week", date: "2026-W40", status: "written", headline: "A CLI week", narrative: "One. Two. Three.", top_story_keys: ["c", "a"] });
    const all = buildWeek({ days: [MON, TUE], stories, editions, week, url: url() });
    expect(all.order).toEqual(["c", "a", "b"]);
    expect(all.filterLine).toBeNull();
    expect(all.matching).toBe(3);

    const web = buildWeek({ days: [MON, TUE], stories, editions, week, url: url({ areas: ["web"] }) });
    expect(web.top.map((s) => s.story_key)).toEqual(["a"]);
    expect(web.order).toEqual(["a"]);
    expect(web.filterLine).toBe("Showing 1 of 3 stories (web)");
    expect(web).toMatchObject({ headline: "A CLI week", standfirst: "One. Two. Three." });
    expect(web.days).toEqual(all.days);
    expect(web.areas).toEqual(all.areas);

    const ben = buildWeek({ days: [MON, TUE], stories, editions, week, url: url({ person: "Ben" }), personName: (id) => id });
    expect(ben.order).toEqual(["c"]);
    const none = buildWeek({ days: [MON, TUE], stories, editions, week, url: url({ risk: true }) });
    expect(none).toMatchObject({ matching: 0, top: [], order: [], filterLine: "Showing 0 of 3 stories (risks)" });
  });
});

describe("the week's live count on main", () => {
  test("sums the day editions' counts, else the days' main stories, whatever the branch toggle shows", () => {
    const { stories, editions } = fixture();
    // Monday 5 and Tuesday 3 from their editions; Wednesday has one main story and no edition.
    const all = [...stories, story("w", { date: WED, commit_shas: ["w1", "w2"] })];
    const main = buildWeek({ days: [MON, TUE, WED], stories: all, editions, week: undefined, url: url() });
    const every = buildWeek({ days: [MON, TUE, WED], stories: all, editions, week: undefined, url: url({ branches: "all" }) });
    expect(main.mainCommits).toBe(10);
    expect(every.mainCommits).toBe(10);
    // With every branch the header counts Tuesday's branch story too.
    expect(every.stats.stories).toBe(main.stats.stories + 1);
  });
});

describe("weekNotes: what the week's notes stand on", () => {
  const SAT = "2026-10-03";
  const FRI = "2026-10-02";
  const T = (iso: string) => Date.parse(iso);
  const WRITTEN = T("2026-10-03T10:29:00");
  const days = (main: Record<string, number>) => ({ days: Object.keys(main).map((date) => ({ date, headline: "", prose: true, commits: main[date], quiet: false })), mainByDay: main });
  const row = edition({ scope: "week", date: "2026-W40", status: "written", generated_at: WRITTEN, stats: { commits: 128, stories: 20, releases: 2, people: 3, sessions: 6, private_sessions: 0 } });
  const fri = edition({ date: FRI, generated_at: T("2026-10-03T00:20:00") });

  test("today's commits never make the current week's notes stale, and the notes say how much of today they hold", () => {
    // Built after Friday ended, before anything landed today.
    expect(weekNotes(days({ [FRI]: 128, [SAT]: 33 }), row, [fri], SAT)).toEqual({ written: 128, sessions: 6, ended: 128, today: 33, todayIn: 0, staleSince: null });
    // Built mid-morning: the build read today's first 6 commits too.
    expect(weekNotes(days({ [FRI]: 122, [SAT]: 43 }), row, [fri], SAT)).toMatchObject({ ended: 122, today: 43, todayIn: 6, staleSince: null });
  });

  test("an ended day that moved after the notes, with the week's count moved too, makes them stale since that move", () => {
    const moved = edition({ date: FRI, generated_at: T("2026-10-03T12:00:00"), dirty_since: T("2026-10-03T11:15:00") });
    const n = weekNotes(days({ [FRI]: 131, [SAT]: 33 }), row, [moved], SAT)!;
    expect(n.staleSince).toBe(T("2026-10-03T11:15:00"));
    // Once an ended day moved, today's share of the notes is no longer known.
    expect(n.todayIn).toBeNull();
    // A rebuild that found nothing new (the count is the notes' own), or a day that has not moved: not stale.
    expect(weekNotes(days({ [FRI]: 100, [SAT]: 28 }), row, [moved], SAT)!.staleSince).toBeNull();
    expect(weekNotes(days({ [FRI]: 131, [SAT]: 33 }), row, [fri], SAT)!.staleSince).toBeNull();
  });

  test("no written notes, no basis", () => {
    expect(weekNotes(days({ [FRI]: 1 }), { ...row, status: "facts" }, [], SAT)).toBeNull();
    expect(weekNotes(days({ [FRI]: 1 }), undefined, [], SAT)).toBeNull();
  });

  test("the footer says it in one sentence: when, through which day, from what, and what joins later", () => {
    const stats = { commits: 161, stories: 24, releases: 2, people: 3, sessions: 6, private_sessions: 0 };
    const current = weekNotes(days({ [FRI]: 128, [SAT]: 33 }), row, [fri], SAT);
    const text = provenanceText({ stats, edition: row, week: current, date: "", today: SAT });
    expect(text).toMatch(/^Notes written .*, 10:29, through .* from 128 commits and 6 team sessions; today's 33 commits join when the day ends\.$/);
    expect(text).toContain(` through ${changesDayLabel(FRI)} `);
    // Notes that read part of today say so, and count only the rest as still to join.
    const partial = weekNotes(days({ [FRI]: 122, [SAT]: 43 }), row, [fri], SAT);
    expect(provenanceText({ stats, edition: row, week: partial, date: "", today: SAT })).toMatch(/ from 128 commits \(6 of them today's\) and 6 team sessions; today's 37 later commits join when the day ends\.$/);
    // A past week whose days moved says how much of them the notes cover.
    const past = weekNotes(days({ [FRI]: 161 }), row, [fri], "2026-10-12");
    expect(provenanceText({ stats, edition: row, week: past, date: "", today: "2026-10-12" })).toMatch(/from 128 of 161 commits and 6 team sessions\.$/);
    // A day: no "through", no pending commits.
    expect(provenanceText({ stats: { ...stats, sessions: 0 }, edition: edition({ status: "final", generated_at: T("2026-10-02T16:08:00") }), date: FRI, today: SAT })).toMatch(/^Notes written \d\d:\d\d from 161 commits\.$/);
  });
});
