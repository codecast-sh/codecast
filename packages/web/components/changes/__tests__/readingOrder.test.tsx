import { describe, expect, test } from "bun:test";
import * as Accordion from "@radix-ui/react-accordion";
import postcss from "postcss";
import { renderToStaticMarkup } from "react-dom/server";
import { TooltipProvider } from "../../ui/tooltip";
import { buildEdition, stepOrder, type EditionModel } from "../editionModel";
import { InBrief } from "../InBrief";
import { LeadStory } from "../LeadStory";
import { SectionBlock } from "../SectionBlock";
import { StoryCtx } from "../storyContext";
import { EMPTY_URL, type ChangesUrl } from "../useChangesUrlState";
import { DAY, at, edition, story } from "./fixtures";
import { changesCss, pageSource } from "./pageSources";

// `j` and `k` walk the edition's reading order (changes-page.md 6.1): the lead,
// each section block's rows, then In brief. Sections sit in a two-column grid
// above 1100px, so the order is only right if the grid places blocks in DOM
// order, left to right and row by row, and the DOM puts the stories where
// the model says. These tests render the real story components in the page's
// arrangement and read the order back out of the markup, then check that no
// rule moves a block out of its DOM place.

// Four areas fill two rows of the two-column grid; each has two rows of its
// own, one area carries a release stamp, and docs land in In brief.
const STORIES = [
  story("lead", { area: "convex", insertions: 4000, importance: 3, last_at: at("12:00") }),
  story("cli-1", { area: "cli", insertions: 900, last_at: at("09:10"), area_counts: { cli: 9 } }),
  story("cli-2", { area: "cli", insertions: 300, last_at: at("16:40"), area_counts: { cli: 4 } }),
  story("web-1", { area: "web", insertions: 400, last_at: at("11:00"), area_counts: { web: 6 } }),
  story("web-2", { area: "web", insertions: 200, last_at: at("08:30"), area_counts: { web: 5 } }),
  story("convex-1", { area: "convex", insertions: 250, last_at: at("13:00"), area_counts: { convex: 4 } }),
  story("convex-2", { area: "convex", insertions: 150, last_at: at("14:00"), area_counts: { convex: 3 } }),
  story("desktop-1", { area: "desktop", insertions: 120, last_at: at("10:00"), area_counts: { desktop: 2 } }),
  story("desktop-2", { area: "desktop", insertions: 90, last_at: at("15:00"), area_counts: { desktop: 1 } }),
  story("docs-1", { area: "docs", kind: "docs", importance: 1, last_at: at("09:00"), area_counts: { docs: 1 } }),
  story("docs-2", { area: "docs", kind: "docs", importance: 1, last_at: at("17:00"), area_counts: { docs: 1 } }),
];
const RELEASE = edition({ releases: [{ surface: "cli", version: "1.1.163", sha: "rel1", at: at("15:27") }] });

const model = (url: ChangesUrl = EMPTY_URL) => buildEdition({ stories: STORIES, date: DAY, edition: RELEASE, live: [], url });

/** The page's day body in its DOM arrangement: main column (lead, then the section grid), In brief below. */
function render(m: EditionModel): string {
  return renderToStaticMarkup(
    <TooltipProvider>
      <StoryCtx.Provider value={{ focused: null, waiting: m.waiting, dimmed: m.dimmed, pick: () => {} }}>
        <Accordion.Root type="single" collapsible value="">
          <div className="chg-grid">
            <div className="chg-span-8">
              <div className="grid gap-7">
                {m.lead && <LeadStory story={m.lead} open={false} />}
                <div className="chg-sections">
                  {m.sections.map((sec) => <SectionBlock key={sec.area} section={sec} stories={STORIES} />)}
                </div>
              </div>
            </div>
            <div className="chg-span-12"><InBrief stories={m.brief} /></div>
          </div>
        </Accordion.Root>
      </StoryCtx.Provider>
    </TooltipProvider>,
  );
}

const domKeys = (html: string) => [...html.matchAll(/data-story-key="([^"]+)"/g)].map((m) => m[1]);

describe("j/k reading order is the DOM order", () => {
  test("a two-column section grid: lead, each block top to bottom in grid order, then In brief", () => {
    const m = model();
    expect(m.sections.map((s) => s.area)).toEqual(["cli", "web", "convex", "desktop"]);
    expect(m.brief.map((s) => s.story_key)).toEqual(["docs-1", "docs-2"]);
    const dom = domKeys(render(m));
    expect(dom).toEqual(m.order);
    // Every story on the page is reachable, each once.
    expect(new Set(dom).size).toBe(STORIES.length);
    // A block is read whole before the block beside it: cli's two rows, with
    // the release stamp between them, come before any web row.
    expect(dom.indexOf("cli-2")).toBeLessThan(dom.indexOf("web-1"));
    // Rows within a block read in the order they landed.
    expect(dom.indexOf("web-2")).toBeLessThan(dom.indexOf("web-1"));
  });

  test("stepping j from the top visits the DOM in order and stops at the end", () => {
    const m = model();
    const dom = domKeys(render(m));
    const walked: string[] = [];
    let at: string | null = null;
    for (let i = 0; i < dom.length + 2; i += 1) {
      at = stepOrder(m.order, at, 1);
      if (walked.at(-1) !== at) walked.push(at!);
    }
    expect(walked).toEqual(dom);
    expect(stepOrder(m.order, dom[0], -1)).toBe(dom[0]);
  });

  test("a dimmed story stays on the page but leaves the walk; the rest keep DOM order", () => {
    const m = model({ ...EMPTY_URL, areas: ["cli", "docs"] });
    const dom = domKeys(render(m));
    expect(dom.length).toBe(STORIES.length);
    expect(m.order).toEqual(dom.filter((k) => !m.dimmed.has(k)));
    expect(m.order).toEqual(["cli-1", "cli-2", "docs-1", "docs-2"]);
  });

  test("no rule moves a story block out of its DOM place", () => {
    // The section grid flows by row: no column flow, no dense packing, no
    // multi-column layout, and no `order` anywhere in the page's rules.
    const sections: string[] = [];
    postcss.parse(changesCss).walkRules((r) => {
      if (r.selectors.includes(".chg-sections")) sections.push(r.toString());
    });
    expect(sections.length).toBeGreaterThanOrEqual(2);
    for (const rule of sections) {
      expect(rule).toContain("grid-template-columns");
      expect(rule).not.toMatch(/grid-auto-flow:\s*(column|dense|row\s+dense)|(?<![\w-])columns:|direction:\s*rtl/);
    }
    expect(sections.join("\n")).toMatch(/repeat\(2,/);
    expect(changesCss).not.toMatch(/(^|[;{\s])order:/m);
    // Nor does a class on the blocks, the rows, or their containers.
    const placing = /\b(order-|flex-col-reverse|flex-row-reverse|columns-\d|grid-flow-col|grid-flow-dense|row-start-|row-end-|col-start-|col-end-)/;
    for (const file of ["SectionBlock.tsx", "StoryRow.tsx", "LeadStory.tsx", "InBrief.tsx"]) {
      expect({ file, placing: pageSource(file).match(placing)?.[0] ?? null }).toEqual({ file, placing: null });
    }
  });

  test("the page arranges the day as this test does: lead, then the section grid, then In brief", () => {
    const page = pageSource("ChangesPage.tsx");
    const lead = page.indexOf("<LeadStory");
    const grid = page.indexOf("chg-sections");
    const block = page.indexOf("<SectionBlock");
    const main = page.indexOf("{mainColumn &&");
    const briefRow = page.indexOf("{briefRow &&");
    for (const i of [lead, grid, block, main, briefRow]) expect(i).toBeGreaterThan(-1);
    expect(lead).toBeLessThan(grid);
    expect(grid).toBeLessThan(block);
    expect(main).toBeLessThan(briefRow);
  });
});
