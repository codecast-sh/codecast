import { describe, expect, test } from "bun:test";
import * as Accordion from "@radix-ui/react-accordion";
import { renderToStaticMarkup } from "react-dom/server";
import { TooltipProvider } from "../../ui/tooltip";
import { LeadStory } from "../LeadStory";
import { story } from "./fixtures";

// The lead card under an edition headline that already says its headline
// opens with the dek (editionModel.echoesHeadline). The headline stays in the
// document for the heading outline, and comes back whenever the card has no
// dek to open with.

const render = (s: ReturnType<typeof story>, echo: boolean) =>
  renderToStaticMarkup(
    <TooltipProvider>
      <Accordion.Root type="single" collapsible value="">
        <LeadStory story={s} open={false} echo={echo} />
      </Accordion.Root>
    </TooltipProvider>,
  );
const h2 = (html: string) => /<h2 class="([^"]*)">/.exec(html)?.[1] ?? "";

describe("the lead card", () => {
  const lead = story("lead", { headline: "Outreach holds a three-touch cadence", dek: "Follow-ups stop after the third touch.", prose_status: "written" });

  test("shows its headline when the edition headline says something else", () => {
    const html = render(lead, false);
    expect(h2(html)).toContain("text-[22px]");
    expect(html).toContain("text-[15px]");
  });

  test("an echo opens with the dek in larger type and keeps the headline for the outline only", () => {
    const html = render(lead, true);
    expect(h2(html)).toBe("sr-only");
    expect(html).toContain("Outreach holds a three-touch cadence");
    expect(html).toMatch(/<p class="[^"]*text-\[17px\][^"]*font-medium[^"]*">.*Follow-ups stop after the third touch\./);
  });

  test("an echo with no dek, written or pending, keeps the headline", () => {
    expect(h2(render({ ...lead, dek: "" }, true))).toContain("text-[22px]");
    const pending = render({ ...lead, dek: "", prose_status: "pending" }, true);
    expect(h2(pending)).toContain("text-[22px]");
    expect(pending).toContain("Notes pending");
  });

  test("each worded risk is its own line", () => {
    const html = render({ ...lead, risks: [{ code: "schema", evidence: [] }, { code: "bulk", evidence: [] }], risk_lines: { schema: "Run the migration first.", bulk: "Nobody reviewed 4,000 lines." } } as any, false);
    expect(html).toContain('<span class="block">Run the migration first.</span><span class="block">Nobody reviewed 4,000 lines.</span>');
  });
});
