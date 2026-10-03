import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { TooltipProvider } from "../../ui/tooltip";
import { EMPTY_URL } from "../useChangesUrlState";
import { buildWeek } from "../weekModel";
import { WeekView } from "../WeekView";
import { edition, story } from "./fixtures";

// The week as the page paints it: the week edition's headline and standfirst,
// the editor's biggest story as the one card and the next ones as rows, the
// release ledger, then a line per day, in that reading order.
test("the week view renders its head, biggest stories, ledger and days in reading order", () => {
  const MON = "2026-09-28";
  const TUE = "2026-09-29";
  const stories = [
    story("a", { date: MON, importance: 4, insertions: 400, headline: "Line pages land" }),
    story("c", { date: TUE, importance: 3, area: "cli", area_counts: { cli: 2 }, headline: "Helpers stop starving" }),
  ];
  const editions = [
    edition({ _id: "d1" as any, date: MON, status: "final", headline: "A web Monday", stats: { commits: 5, stories: 1, releases: 1, people: 1, sessions: 1, private_sessions: 0 }, releases: [{ surface: "cli", version: "1.1.157", sha: "c1", at: 1 }] }),
    edition({ _id: "d2" as any, date: TUE, status: "final", headline: "A CLI Tuesday", stats: { commits: 3, stories: 1, releases: 1, people: 1, sessions: 1, private_sessions: 0 }, releases: [{ surface: "cli", version: "1.1.160", sha: "c3", at: 3 }] }),
  ];
  const week = edition({ scope: "week", date: "2026-W40", status: "written", headline: "Two CLI releases and line pages", narrative: "One. Two. Three.", top_story_keys: ["c", "a"] });
  const model = buildWeek({ days: [MON, TUE], stories, editions, week, url: EMPTY_URL });
  const render = (today: string) => renderToStaticMarkup(
    <TooltipProvider>
      <WeekView week={model} works={[]} today={today} reserve={false} animate onDay={() => {}} onStory={() => {}} onClearFilters={() => {}} />
    </TooltipProvider>,
  );
  const html = render(TUE);
  const order = ["Two CLI releases and line pages", "One. Two. Three.", "Helpers stop starving", "Line pages land", "1.1.157", "1.1.160", "2 releases", "A web Monday", "A CLI Tuesday", "Areas this week"];
  const at = order.map((t) => html.indexOf(t));
  expect(at.every((i) => i > -1)).toBe(true);
  expect([...at].sort((x, y) => x - y)).toEqual(at);
  expect(html).not.toMatch(/#[0-9a-f]{6}/i);
  // j/k walks the biggest stories in the order they paint.
  expect([...html.matchAll(/data-story-key="([^"]+)"/g)].map((m) => m[1])).toEqual(model.order);
  expect(model.order).toEqual(["c", "a"]);

  // A past week says the rail is the state right now, and leads with the bars that are its own.
  const past = render("2026-10-12");
  expect(html).not.toContain("Live state");
  expect(past).toContain("Live state, not the week of Mon 28 Sep");
  expect(past.indexOf("Areas that week")).toBeGreaterThan(-1);
  expect(past.indexOf("Areas that week")).toBeLessThan(past.indexOf("In the works now"));
});
