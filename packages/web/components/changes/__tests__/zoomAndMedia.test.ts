import { describe, expect, test } from "bun:test";
import { mediaOf, pickMedia } from "../storyMedia";
import { buildTimeline, dayZoom, groupWeeks, weekFolds } from "../timelineModel";
import { EMPTY_URL, parseChangesUrl, serializeChangesUrl } from "../useChangesUrlState";
import { edition, story } from "./fixtures";

const shot = (n: number) => `![shot ${n}](https://convex.example/s${n}.png)`;

describe("mediaOf", () => {
  test("reads screenshots, published pages and canvases in article order", () => {
    const body = [
      "The lead.",
      shot(1),
      "https://codecast.sh/a/fee-report",
      "```cast-canvas\n<div>flow</div>\n```",
      "A link inside a sentence https://codecast.sh/a/inline stays prose.",
    ].join("\n\n");
    expect(mediaOf(body)).toEqual([
      { kind: "image", src: "https://convex.example/s1.png", alt: "shot 1" },
      { kind: "page", slug: "fee-report", url: "https://codecast.sh/a/fee-report" },
      { kind: "canvas", block: "```cast-canvas\n<div>flow</div>\n```" },
    ]);
  });
});

describe("pickMedia", () => {
  test("takes each story's first piece before any story's second, and a repeated picture once", () => {
    const a = story("a", { body: `${shot(1)}\n${shot(2)}\n${shot(3)}` });
    const b = story("b", { body: `${shot(1)}\n${shot(4)}` });
    const c = story("c", { body: "No pictures." });
    expect(pickMedia([a, b, c], 3).map((p) => [p.story.story_key, p.media.kind === "image" && p.media.src.slice(-6)])).toEqual([
      ["a", "s1.png"],
      ["a", "s2.png"],
      ["b", "s4.png"],
    ]);
  });
});

describe("zoom", () => {
  test("round-trips through the URL and drops an unknown level", () => {
    expect(serializeChangesUrl({ ...EMPTY_URL, zoom: "weeks" })).toBe("?zoom=weeks");
    expect(parseChangesUrl(new URLSearchParams("zoom=months")).zoom).toBeUndefined();
  });

  test("by age, the last two days read story by story, the past week a day at a time, older days by week", () => {
    const today = "2026-10-06";
    expect(dayZoom("2026-10-06", today, undefined)).toBe("changes");
    expect(dayZoom("2026-10-05", today, undefined)).toBe("changes");
    expect(dayZoom("2026-10-02", today, undefined)).toBe("days");
    expect(dayZoom("2026-09-29", today, undefined)).toBe("weeks");
    expect(dayZoom("2026-09-29", today, "changes")).toBe("changes");
  });

  test("today leads the timeline, and an older week folds only when its notes are written", () => {
    const stories = [story("t", { date: "2026-10-06" }), story("o", { date: "2026-09-29" }), story("n", { date: "2026-09-22" })];
    const weeks = [edition({ scope: "week", date: "2026-W40", headline: "Week forty", status: "written" })];
    const groups = groupWeeks(buildTimeline({ stories, editions: [], weeks, url: EMPTY_URL, person: null, today: "2026-10-06" }));
    expect(groups.map((g) => [g.week, g.days.map((d) => d.date), !!g.notes])).toEqual([
      ["2026-W41", ["2026-10-06"], false],
      ["2026-W40", ["2026-09-29"], true],
      ["2026-W39", ["2026-09-22"], false],
    ]);
    expect(groups.map((g) => weekFolds(g, "2026-10-06", undefined))).toEqual([false, true, false]);
  });

  test("a day carries its edition's few sentences", () => {
    const items = buildTimeline({
      stories: [story("a")],
      editions: [edition({ headline: "Fees split by market", narrative: "Brokers in regulated markets now see the regulated fee.", status: "written" })],
      weeks: [],
      url: EMPTY_URL,
      person: null,
      today: "2026-10-02",
    });
    expect(items[0]).toMatchObject({ kind: "day", summary: "Fees split by market", standfirst: "Brokers in regulated markets now see the regulated fee." });
  });
});
