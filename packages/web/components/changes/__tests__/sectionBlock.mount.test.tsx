import { expect, test } from "bun:test";
import * as Accordion from "@radix-ui/react-accordion";
import { renderToStaticMarkup } from "react-dom/server";
import { TooltipProvider } from "../../ui/tooltip";
import { buildEdition, notesCanArrive } from "../editionModel";
import { SectionBlock } from "../SectionBlock";
import { StoryCtx, createFocusStore } from "../storyContext";
import { EMPTY_URL } from "../useChangesUrlState";
import { DAY, at, edition, story } from "./fixtures";

// A section block as the page paints it: rows in landing order with the
// release stamp between them, every row's dek rendered whether or not it is
// focused (so focus and hover never shift the page), and the risk texture on
// a flagged row.
const RELEASES = [{ surface: "cli", version: "1.1.163", sha: "rel1", at: at("15:27") }];
const STORIES = [
  story("lead", { insertions: 5000, area: "convex" }),
  story("early", { area: "cli", last_at: at("09:00"), dek: "", prose_status: "pending" }),
  story("late", { area: "cli", last_at: at("17:00"), risks: [{ code: "schema", evidence: ["abc1234"] }] }),
];

/** The cli block of a day, its stories' notes live as the page decides them for that day's edition. */
function renderCli(over: Parameters<typeof edition>[0] = {}, stories = STORIES, open = "") {
  const ed = edition({ releases: RELEASES, ...over });
  const model = buildEdition({ stories, date: DAY, edition: ed, live: [], url: EMPTY_URL });
  const cli = model.sections.find((s) => s.area === "cli")!;
  const focus = createFocusStore();
  return renderToStaticMarkup(
    <TooltipProvider>
      <StoryCtx.Provider value={{ focus, waiting: new Set(), dimmed: new Set(), pick: focus.set, proseLive: notesCanArrive(DAY, DAY, ed) }}>
        <Accordion.Root type="single" collapsible value={open}>
          <SectionBlock section={cli} />
        </Accordion.Root>
      </StoryCtx.Provider>
    </TooltipProvider>,
  );
}

test("a section block renders its rows, the stamp between them, and reserved deks", () => {
  const html = renderCli();
  const early = html.indexOf("Headline early");
  const stamp = html.indexOf("cli 1.1.163,");
  const late = html.indexOf("Headline late");
  expect(early).toBeGreaterThan(-1);
  expect(stamp).toBeGreaterThan(early);
  expect(late).toBeGreaterThan(stamp);
  // A pending dek holds its line with a shimmer; a written one is plain text.
  expect(html).toContain('aria-label="Notes pending"');
  expect(html).toContain("Dek late");
  // The risk is said once, in words, inside the row's trigger; the tick itself is decoration.
  expect(html).toMatch(/<span class="sr-only">Risk: schema \(abc1234\)<\/span>/);
  expect(html).not.toContain('aria-label="Risk"');
  // Accents are theme variables, never Solarized hex.
  expect(html).not.toMatch(/#[0-9a-f]{6}/i);
});

// A capped day's notes never come: a dek-less pending story shows no shimmer
// and no empty dek line, for good. A failed edition or a day older than
// yesterday reads the same.
test("a capped edition's pending story renders no pending bar", () => {
  for (const over of [{ capped_at: at("12:00") }, { status: "failed" as const }]) {
    const html = renderCli(over);
    expect(html).toContain("Headline early");
    expect(html).not.toContain('aria-label="Notes pending"');
    expect(html).not.toContain("chg-pending-bar");
  }
  expect(notesCanArrive("2026-09-29", DAY, edition())).toBe(false);
  expect(notesCanArrive("2026-10-01", DAY, edition())).toBe(true);
});

// A row's risks in words: one line each, a size note after every hazard, the
// first two clamped, then "+N more"; a stored ellipsis reads as a full stop.
test("a flagged row shows one line per risk, hazards first, then how many more", () => {
  const risky = story("risky", {
    area: "cli",
    last_at: at("17:30"),
    risks: [{ code: "bulk", evidence: [] }, { code: "schema", evidence: [] }, { code: "skew", evidence: [] }],
    risk_lines: { bulk: "Nobody reviewed 4,000 lines.", schema: "Run the migration before the web deploy …", skew: "Old CLIs call the new route." },
  } as any);
  const html = renderCli({}, [...STORIES, risky]).split("Headline risky")[1];
  const lines = [...html.matchAll(/<span class="block [^"]*chg-risk-clamp[^"]*"[^>]*>([^<]*)<\/span>/g)].map((m) => m[1]);
  expect(lines).toEqual(["Run the migration before the web deploy.", "Old CLIs call the new route.", "Nobody reviewed 4,000 lines."]);
  expect(html).toMatch(/chg-risk-clamp line-clamp-2 chg-risk-extra"[^>]*>Nobody reviewed/);
  expect(html).toContain(">+1 more</span>");
});
