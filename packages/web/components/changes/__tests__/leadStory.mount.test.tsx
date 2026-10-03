import { describe, expect, test } from "bun:test";
import * as Accordion from "@radix-ui/react-accordion";
import { renderToStaticMarkup } from "react-dom/server";
import { TooltipProvider } from "../../ui/tooltip";
import { LeadStory } from "../LeadStory";
import { story } from "./fixtures";

// The lead card under an edition headline that already says its headline
// (editionModel.echoesHeadline) opens with the first sentences of its body,
// since its dek mostly says the headline again; with no body it opens with
// the dek. The headline stays in the document for the heading outline, and
// comes back whenever the card has nothing to open with.

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

  test("an echo with no body opens with the dek in the dek's type and keeps the headline for the outline only", () => {
    const html = render(lead, true);
    expect(h2(html)).toBe("sr-only");
    expect(html).toContain("Outreach holds a three-touch cadence");
    expect(html).toMatch(/<p class="[^"]*text-\[15px\] leading-\[1\.6\][^"]*"><span[^>]*>Follow-ups stop after the third touch\./);
  });

  test("an echo with a body opens with its first sentences instead of the dek, and the rest follows", () => {
    // The opener keeps whole sentences within 40 words; the second would pass them, so it opens the next paragraph.
    const first = "Each lead now gets a first email and two follow-ups spaced a week apart, after which the sequence ends for good and the lead moves to the quarterly digest list instead.";
    const second = "Replies at any step stop the sequence for that lead at once, and a bounce removes the address from every list the team sends from.";
    const html = render({ ...lead, body: `${first} ${second}` }, true);
    expect(html).not.toContain("Follow-ups stop after the third touch.");
    const paras = [...html.matchAll(/<p class="[^"]*">(.*?)<\/p>/g)].map((m) => m[1].replace(/<[^>]+>/g, ""));
    expect(paras).toEqual([first, second]);
  });

  test("an echo with no dek, written or pending, keeps the headline", () => {
    expect(h2(render({ ...lead, dek: "" }, true))).toContain("text-[22px]");
    const pending = render({ ...lead, dek: "", prose_status: "pending" }, true);
    expect(h2(pending)).toContain("text-[22px]");
    expect(pending).toContain("Notes pending");
  });

  test("the worded risks share a line clamped at four, never cut short of the clamp; the whole of them on hover", () => {
    const html = render({ ...lead, risks: [{ code: "schema", evidence: [] }, { code: "bulk", evidence: [] }], risk_lines: { schema: "Run the migration first.", bulk: "Nobody reviewed 4,000 lines." } } as any, false);
    expect(html).toMatch(/<span class="line-clamp-4[^"]*"[^>]*>Run the migration first\. Nobody reviewed 4,000 lines\.<\/span>/);
  });

  test("a long file path in a risk shows as its file name", () => {
    const line = "Ship packages/convex/convex/migrations/20261001215647_flawless_sersi.sql before the web deploy, see convex/schema.ts.";
    const html = render({ ...lead, risks: [{ code: "schema", evidence: [] }], risk_lines: { schema: line } } as any, false);
    expect(html).toContain("Ship 20261001215647_flawless_sersi.sql before the web deploy, see convex/schema.ts.");
    expect(html).not.toContain("packages/convex/convex/migrations/");
  });
});
