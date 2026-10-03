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

// Filters narrow the week's biggest stories, so "N more" counts the stories
// the filters match past them, not the whole week's. A filter that matches
// none leaves no stories for the summary to close: the head keeps all of it,
// above the No-match card. With every branch shown an empty week is not "on main".
test("the week's 'more' and its summary follow the filters", () => {
  const MON = "2026-09-28";
  const stories = [
    ...Array.from({ length: 7 }, (_, i) => story(`c${i}`, { date: MON, area: "cli", area_counts: { cli: 1 }, insertions: 100 - i, headline: `Cli story ${i}` })),
    ...Array.from({ length: 3 }, (_, i) => story(`w${i}`, { date: MON, area: "web", insertions: 50 - i, headline: `Web story ${i}` })),
  ];
  const first = "The week turned the CLI into the place the team works from, with seven changes to how sessions start, stop and report what they did, and a quieter web view that reads the same facts.";
  const second = "Three web changes followed the CLI work and closed the gaps it opened.";
  const week = edition({ scope: "week", date: "2026-W40", status: "written", headline: "The CLI week", narrative: `${first} ${second}` });
  const paint = (url: typeof EMPTY_URL, branches?: string, s = stories) => renderToStaticMarkup(
    <TooltipProvider>
      <WeekView week={buildWeek({ days: [MON], stories: s, editions: [], week, url })} works={[]} today={MON} branches={branches} reserve={false} animate={false} onDay={() => {}} onStory={() => {}} onClearFilters={() => {}} />
    </TooltipProvider>,
  );
  const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

  expect(text(paint(EMPTY_URL))).toContain("5 more stories, by day");
  const cli = paint({ ...EMPTY_URL, areas: ["cli"] });
  expect(text(cli)).toContain("2 more stories, by day");

  const none = paint({ ...EMPTY_URL, areas: ["docs"] });
  expect(none).toContain("No stories this week match these filters.");
  const standfirst = /<p class="[^"]*chg-standfirst[^"]*">(.*?)<\/p>/.exec(none)?.[1] ?? "";
  expect(text(standfirst).trim()).toBe(`${first} ${second}`);
  expect(none.indexOf(second)).toBeLessThan(none.indexOf("No stories this week match"));
  expect(none.split(second).length).toBe(2);

  expect(text(paint(EMPTY_URL, "main", []))).toContain("Nothing landed on main this week yet.");
  expect(text(paint(EMPTY_URL, "all", []))).toContain("Nothing landed this week yet.");
});
