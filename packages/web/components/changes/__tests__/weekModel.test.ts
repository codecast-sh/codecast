import { describe, expect, test } from "bun:test";
import { EMPTY_URL, type ChangesUrl } from "../useChangesUrlState";
import { buildWeek } from "../weekModel";
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
      { date: MON, headline: "Line pages land", prose: true, commits: 5, quiet: false },
      { date: TUE, headline: "3 commits, 1 release, 1 story", prose: false, commits: 3, quiet: false },
      { date: WED, headline: "0 commits, 0 stories", prose: false, commits: 0, quiet: true },
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
