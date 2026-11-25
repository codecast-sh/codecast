import { describe, expect, test } from "bun:test";
import { buildTimeline, groupWeeks } from "../timelineModel";
import { EMPTY_URL } from "../useChangesUrlState";
import { edition, story } from "./fixtures";

describe("the feed", () => {
  test("today leads the feed, and a finished week carries its notes", () => {
    const stories = [story("t", { date: "2026-10-06" }), story("o", { date: "2026-09-29" }), story("n", { date: "2026-09-22" })];
    const weeks = [edition({ scope: "week", date: "2026-W40", headline: "Week forty", status: "written" })];
    const groups = groupWeeks(buildTimeline({ stories, editions: [], weeks, url: EMPTY_URL, person: null, today: "2026-10-06" }));
    expect(groups.map((g) => [g.week, g.days.map((d) => d.date), !!g.notes])).toEqual([
      ["2026-W41", ["2026-10-06"], false],
      ["2026-W40", ["2026-09-29"], true],
      ["2026-W39", ["2026-09-22"], false],
    ]);
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
