import { describe, expect, test } from "bun:test";
import { awaitsStories, buildEdition, dayVolumes, echoesHeadline, filterAreas, stepOrder } from "../editionModel";
import { EMPTY_URL, type ChangesUrl } from "../useChangesUrlState";
import { DAY, at, edition, liveRow, story } from "./fixtures";

const url = (over: Partial<ChangesUrl> = {}): ChangesUrl => ({ ...EMPTY_URL, ...over });
const build = (stories: ReturnType<typeof story>[], over: Partial<Parameters<typeof buildEdition>[0]> = {}) =>
  buildEdition({ stories, date: DAY, edition: undefined, live: [], url: url(), ...over });

describe("buildEdition", () => {
  test("before an edition: the heaviest main story leads and the headline is the day's counts", () => {
    const m = build([
      story("a", { insertions: 5 }),
      story("b", { insertions: 900, area: "cli" }),
      story("c", { kind: "docs", area: "docs" }),
    ]);
    expect(m.lead?.story_key).toBe("b");
    expect(m.brief.map((s) => s.story_key)).toEqual(["c"]);
    expect(m.sections.map((s) => s.area)).toEqual(["web"]);
    expect(m.prose).toBe(false);
    expect(m.headline).toBe("3 commits, 3 stories");
    expect(m.standfirst).toBeNull();
  });

  test("the edition's lead, section order, brief and prose win once written", () => {
    const m = build(
      [story("a"), story("b", { area: "cli" }), story("c", { area: "convex" }), story("d", { area: "web" })],
      {
        edition: edition({
          status: "written",
          headline: "Agent helpers stop starving",
          narrative: "A big day for reliability.",
          lead_story_key: "a",
          section_order: ["convex", "cli"],
          brief_story_keys: ["d"],
        }),
      },
    );
    expect(m.lead?.story_key).toBe("a");
    expect(m.sections.map((s) => s.area)).toEqual(["convex", "cli"]);
    expect(m.brief.map((s) => s.story_key)).toEqual(["d"]);
    expect(m.headline).toBe("Agent helpers stop starving");
    expect(m.standfirst).toBe("A big day for reliability.");
  });

  test("a failed edition keeps the counts headline", () => {
    const m = build([story("a")], { edition: edition({ status: "failed", headline: "Not shown" }) });
    expect(m.prose).toBe(false);
    expect(m.headline).toBe("1 commit, 1 story");
  });

  test("branch stories appear only with all branches", () => {
    const stories = [story("a"), story("b", { on_default_branch: false, branch: "feat/x" })];
    expect(build(stories).day.map((s) => s.story_key)).toEqual(["a"]);
    expect(build(stories, { url: url({ branches: "all" }) }).day).toHaveLength(2);
  });

  test("a release stamp sits between the rows that landed before and after it", () => {
    const stories = [
      story("lead", { insertions: 5000, area: "convex" }),
      story("early", { last_at: at("09:00"), area: "cli" }),
      story("late", { last_at: at("17:00"), area: "cli" }),
    ];
    const m = build(stories, {
      edition: edition({ releases: [{ surface: "cli", version: "1.1.163", sha: "rel1", at: at("15:27") }] }),
    });
    const cli = m.sections.find((s) => s.area === "cli")!;
    expect(cli.items.map((i) => (i.kind === "story" ? i.story.story_key : `stamp:${i.ship.version}`))).toEqual(["early", "stamp:1.1.163", "late"]);
    expect(cli.count).toBe(2);
  });

  test("a ship before every row of a section is earlier work and gets no stamp; one after them all closes the block", () => {
    const stories = [story("lead", { insertions: 5000, area: "convex" }), story("x", { last_at: at("12:00"), area: "cli" })];
    const before = build(stories, { edition: edition({ releases: [{ surface: "cli", sha: "r0", at: at("08:00") }] }) });
    expect(before.sections.find((s) => s.area === "cli")!.items.map((i) => i.kind)).toEqual(["story"]);
    const after = build(stories, { edition: edition({ releases: [{ surface: "cli", sha: "r1", at: at("18:00") }] }) });
    expect(after.sections.find((s) => s.area === "cli")!.items.map((i) => i.kind)).toEqual(["story", "stamp"]);
  });

  test("an area filter dims what it misses and drops it from the reading order", () => {
    const stories = [story("lead", { insertions: 5000 }), story("w2"), story("c1", { area: "cli" })];
    const m = build(stories, { url: url({ areas: ["cli"] }) });
    expect(m.sections.find((s) => s.area === "web")!.dimmed).toBe(true);
    expect(m.sections.find((s) => s.area === "cli")!.dimmed).toBe(false);
    expect(m.dimmed.has("lead")).toBe(true);
    expect(m.order).toEqual(["c1"]);
    expect(m.matching).toBe(1);
    expect(m.filterLine).toBe("Showing 1 of 3 stories (cli)");
  });

  test("a surface filter dims the areas its surface does not ship", () => {
    const m = build([story("a", { insertions: 5000, area: "convex" }), story("b", { area: "cli" })], { url: url({ surface: "cli" }) });
    expect(m.dimmed.has("a")).toBe(true);
    expect(m.order).toEqual(["b"]);
  });

  test("risk, person, waiting and text filters hide what they miss", () => {
    const stories = [
      story("a", { insertions: 5000, risks: [{ code: "schema", evidence: ["sha1"] }] }),
      story("b", { author_names: ["Grace"], last_at: at("16:00") }),
      story("c", { headline: "Spelling suggestions", actor_user_ids: ["u9" as any] }),
    ];
    expect(build(stories, { url: url({ risk: true }) }).order).toEqual(["a"]);
    expect(build(stories, { url: url({ person: "Grace" }) }).order).toEqual(["b"]);
    expect(build(stories, { url: url({ person: "u9" }) }).order).toEqual(["c"]);
    expect(build(stories, { url: url({ q: "spelling" }) }).order).toEqual(["c"]);
    const waiting = build(stories, { url: url({ waiting: true }), live: [liveRow("web", { at: at("15:00") })] });
    expect(waiting.order).toEqual(["b"]);
    expect(waiting.waiting.has("b")).toBe(true);
  });

  test("no match leaves an empty reading order and a zero count", () => {
    const m = build([story("a")], { url: url({ q: "nothing like this" }) });
    expect(m.matching).toBe(0);
    expect(m.order).toEqual([]);
    expect(m.lead).toBeNull();
  });

  test("reading order: lead, then each section's rows in grid order, then In brief", () => {
    const m = build([
      story("lead", { insertions: 5000, area: "convex" }),
      story("w1", { last_at: at("09:00") }),
      story("w2", { last_at: at("11:00") }),
      story("c1", { area: "cli" }),
      story("d1", { kind: "docs", area: "docs" }),
    ]);
    expect(m.order).toEqual(["lead", ...m.sections.flatMap((s) => s.items.flatMap((i) => (i.kind === "story" ? [i.story.story_key] : []))), "d1"]);
    expect(m.order.indexOf("w1")).toBeLessThan(m.order.indexOf("w2"));
  });

  test("stats come from the stories until the edition has its own", () => {
    const stories = [
      story("a", { commit_shas: ["s1", "s2"], author_names: ["Ada"], conversation_ids: ["c1" as any], private_session_count: 1 }),
      story("b", { commit_shas: ["s2", "s3"], author_names: ["Grace"], conversation_ids: ["c1" as any] }),
    ];
    expect(build(stories).stats).toEqual({ commits: 3, stories: 2, releases: 0, people: 2, sessions: 1, private_sessions: 1 });
    const stats = { commits: 16, stories: 9, releases: 3, people: 4, sessions: 11, private_sessions: 4 };
    expect(build(stories, { edition: edition({ stats }) }).stats).toEqual(stats);
  });

  test("areas today sum file touches and count distinct commits", () => {
    const m = build([
      story("a", { area_counts: { web: 3, shared: 1 }, commit_shas: ["s1"] }),
      story("b", { area_counts: { web: 2 }, commit_shas: ["s1", "s2"] }),
    ]);
    expect(m.areas).toEqual([
      { area: "web", touches: 5, commits: 2, stories: 2 },
      { area: "shared", touches: 1, commits: 1, stories: 0 },
    ]);
  });

  test("a commit is credited to an area only as far as its touches prove it", () => {
    const shas = Array.from({ length: 30 }, (_, i) => `c${i}`);
    const m = build([story("a", { area_counts: { web: 120, github: 1 }, commit_shas: shas })]);
    expect(m.areas).toEqual([
      { area: "web", touches: 120, commits: 30, stories: 1 },
      { area: "github", touches: 1, commits: 1, stories: 0 },
    ]);
  });

  test("the area filter offers the stories' own areas, never an area touched only inside them", () => {
    const stories = [
      story("a", { area: "web", area_counts: { web: 9, github: 2 } }),
      story("b", { area: "cli", area_counts: { cli: 3, github: 1 } }),
      story("c", { area: "cli", area_counts: { cli: 1 } }),
      story("d", { area: "release", area_counts: {} }),
    ];
    const m = build(stories);
    expect(m.areas.map((a) => a.area)).toEqual(["web", "cli", "github"]);
    expect(filterAreas(m.day, m.areas)).toEqual(["web", "cli", "release"]);
  });
});

describe("dayVolumes", () => {
  test("the edition's count, else main-branch commits, else unknown", () => {
    const v = dayVolumes(
      [story("a", { commit_shas: ["s1", "s2"] }), story("b", { date: "2026-10-01", on_default_branch: false })],
      [edition({ date: "2026-09-30", stats: { commits: 7, stories: 1, releases: 0, people: 1, sessions: 0, private_sessions: 0 } })],
      ["2026-09-29", "2026-09-30", "2026-10-01", DAY],
    );
    expect(v).toEqual({ "2026-09-29": null, "2026-09-30": 7, "2026-10-01": null, [DAY]: 2 });
  });
});

describe("stepOrder", () => {
  test("starts at the ends, clamps at both", () => {
    expect(stepOrder(["a", "b", "c"], null, 1)).toBe("a");
    expect(stepOrder(["a", "b", "c"], null, -1)).toBe("c");
    expect(stepOrder(["a", "b", "c"], "b", 1)).toBe("c");
    expect(stepOrder(["a", "b", "c"], "c", 1)).toBe("c");
    expect(stepOrder(["a", "b", "c"], "a", -1)).toBe("a");
    expect(stepOrder(["a"], "gone", 1)).toBe("a");
    expect(stepOrder([], "a", 1)).toBeNull();
  });
});

describe("awaitsStories", () => {
  const stats = (stories: number) => ({ commits: stories, stories, releases: 0, people: 1, sessions: 0, private_sessions: 0 });

  test("a cached edition that counts stories waits for them instead of saying nothing landed", () => {
    expect(awaitsStories(0, false, [edition({ stats: stats(4) })])).toBe(true);
    expect(awaitsStories(0, false, [undefined])).toBe(true);
  });

  test("cached stories, an answered feed, or editions that say nothing landed paint at once", () => {
    expect(awaitsStories(3, false, [undefined])).toBe(false);
    expect(awaitsStories(0, true, [edition({ stats: stats(4) })])).toBe(false);
    expect(awaitsStories(0, false, [edition({ stats: stats(0) })])).toBe(false);
  });

  test("a week is quiet from cache only when every day so far says so", () => {
    expect(awaitsStories(0, false, [edition({ stats: stats(0) }), edition({ stats: stats(2) })])).toBe(true);
    expect(awaitsStories(0, false, [edition({ stats: stats(0) }), undefined])).toBe(true);
    expect(awaitsStories(0, false, [edition({ stats: stats(0) }), edition({ stats: stats(0) })])).toBe(false);
  });
});

describe("echoesHeadline", () => {
  // The shape of the 2 Oct pair, reworded: the edition headline restates its lead story and adds a clause.
  const EDITION = "Outreach now holds a three-touch cadence, and the tip engine stops repeating itself";
  const LEAD = "Outreach holds a three-touch cadence";

  test("a lead that the edition headline restates is an echo", () => {
    expect(echoesHeadline(LEAD, EDITION)).toBe(true);
    // Its words open the edition headline, whatever the case and punctuation.
    expect(echoesHeadline("Outreach now holds a three-touch cadence.", EDITION)).toBe(true);
    expect(echoesHeadline("outreach now holds", `"Outreach" now holds: a cadence`)).toBe(true);
  });

  test("an unrelated lead, or one too short to compare, is not", () => {
    expect(echoesHeadline("Mobile sign-in survives a cold start on Android", EDITION)).toBe(false);
    expect(echoesHeadline("The tip engine caches its scores for a day", EDITION)).toBe(false);
    expect(echoesHeadline("Outreach now", EDITION)).toBe(false);
    expect(echoesHeadline(LEAD, "")).toBe(false);
  });

  test("the model flags it only against prose: the counts headline never repeats a story", () => {
    const stories = [story("a", { headline: LEAD, insertions: 900 }), story("b", { area: "cli" })];
    expect(build(stories).leadEchoesHeadline).toBe(false);
    const written = build(stories, { edition: edition({ status: "written", headline: EDITION, lead_story_key: "a" }) });
    expect(written.leadEchoesHeadline).toBe(true);
    const other = build(stories, { edition: edition({ status: "written", headline: EDITION, lead_story_key: "b" }) });
    expect(other.leadEchoesHeadline).toBe(false);
  });
});
