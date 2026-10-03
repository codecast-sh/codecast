import { expect, test } from "bun:test";
import * as Accordion from "@radix-ui/react-accordion";
import { renderToStaticMarkup } from "react-dom/server";
import { TooltipProvider } from "../../ui/tooltip";
import { buildEdition } from "../editionModel";
import { SectionBlock } from "../SectionBlock";
import { EMPTY_URL } from "../useChangesUrlState";
import { DAY, at, edition, story } from "./fixtures";

// A section block as the page paints it: rows in landing order with the
// release stamp between them, every row's dek rendered whether or not it is
// focused (so focus and hover never shift the page), and the risk texture on
// a flagged row.
test("a section block renders its rows, the stamp between them, and reserved deks", () => {
  const stories = [
    story("lead", { insertions: 5000, area: "convex" }),
    story("early", { area: "cli", last_at: at("09:00"), dek: "", prose_status: "pending" }),
    story("late", { area: "cli", last_at: at("17:00"), risks: [{ code: "schema", evidence: ["abc1234"] }] }),
  ];
  const model = buildEdition({
    stories,
    date: DAY,
    edition: edition({ releases: [{ surface: "cli", version: "1.1.163", sha: "rel1", at: at("15:27") }] }),
    live: [],
    url: EMPTY_URL,
  });
  const cli = model.sections.find((s) => s.area === "cli")!;
  const html = renderToStaticMarkup(
    <TooltipProvider>
      <Accordion.Root type="single" collapsible>
        <SectionBlock section={cli} stories={stories} />
      </Accordion.Root>
    </TooltipProvider>,
  );
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
