import { describe, expect, test } from "bun:test";
import * as Accordion from "@radix-ui/react-accordion";
import { renderToStaticMarkup } from "react-dom/server";
import { TooltipProvider } from "../../ui/tooltip";
import { LeadStory } from "../LeadStory";
import { CARD_LEDE } from "../StoryParts";
import { StoryCtx, createFocusStore } from "../storyContext";
import { changesCss } from "./pageSources";
import { story } from "./fixtures";

// The lead card under an edition headline that already says its headline
// (editionModel.echoesHeadline) opens with the first sentences of its body,
// since its dek mostly says the headline again; with no body it opens with
// the dek. The headline stays in the document for the heading outline, and
// comes back whenever the card has nothing to open with.

/** The card as the page mounts it: `focused` puts the page's cursor on it, `proseLive` says its notes can still come. */
const render = (s: ReturnType<typeof story>, echo: boolean, { focused = false, proseLive = true } = {}) => {
  const focus = createFocusStore(focused ? s.story_key : null);
  return renderToStaticMarkup(
    <TooltipProvider>
      <StoryCtx.Provider value={{ focus, waiting: new Set(), dimmed: new Set(), pick: focus.set, proseLive }}>
        <Accordion.Root type="single" collapsible value="">
          <LeadStory story={s} open={false} echo={echo} />
        </Accordion.Root>
      </StoryCtx.Provider>
    </TooltipProvider>,
  );
};
const h2 = (html: string) => /<h2 class="([^"]*)">/.exec(html)?.[1] ?? "";

describe("the lead card", () => {
  const lead = story("lead", { headline: "Outreach holds a three-touch cadence", dek: "Follow-ups stop after the third touch.", prose_status: "written" });

  test("shows its headline when the edition headline says something else", () => {
    const html = render(lead, false);
    expect(h2(html)).toContain("text-[22px]");
    expect(html).toContain("text-[15px]");
  });

  test("an echo with no body opens with the dek as a lede a step above body text, and keeps the headline for the outline only", () => {
    const html = render(lead, true);
    expect(h2(html)).toBe("sr-only");
    expect(html).toContain("Outreach holds a three-touch cadence");
    expect(html).toContain(`<p class="chg-lead-prose ${CARD_LEDE}">`);
    expect(html).toMatch(/<p class="[^"]*text-\[17px\] font-medium leading-\[1\.5\] text-sol-text [^"]*"><span[^>]*>Follow-ups stop after the third touch\./);
  });

  test("a shown headline keeps the dek in body type under it", () => {
    expect(render(lead, false)).toMatch(/<p class="[^"]*text-\[15px\] leading-\[1\.6\] text-sol-text\/80[^"]*"><span[^>]*>Follow-ups stop after the third touch\./);
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

  test("a pending card whose notes can no longer come shows no pending bar and says it was written from commit subjects", () => {
    const html = render({ ...lead, dek: "", prose_status: "pending", why_source: undefined, pr_ids: ["pr1" as any] }, false, { proseLive: false });
    expect(html).not.toContain("Notes pending");
    expect(html).not.toContain("chg-pending-bar");
    expect(html).not.toContain("notes pending");
    expect(html).toContain("written from commit subjects");
  });

  test("the cursor on the card keeps its fill: the row tint is for rows, the card takes a hairline", async () => {
    const html = render(lead, false, { focused: true });
    const { JSDOM } = await import("jsdom");
    const doc = new JSDOM(html).window.document;
    const card = doc.querySelector<HTMLElement>('[data-story-key="lead"]')!;
    expect(card.getAttribute("data-focused")).toBe("true");
    expect(card.className).toContain("bg-sol-card");
    expect(card.classList.contains("chg-row")).toBe(false);
    // Every rule that paints the cursor, its :has() guard set aside (it only spares an open drawer).
    const rules = [...changesCss.matchAll(/([^{}]*\[data-focused="true"\][^{}]*)\{([^}]*)\}/g)].map((m) => ({ sel: m[1].trim().replace(/:not\(:has\([^)]*\)\)\)/g, ""), body: m[2] }));
    const tint = rules.filter((r) => /\bbackground\b/.test(r.body) && !r.sel.includes(":not([data-focused"));
    expect(tint.length).toBeGreaterThan(0);
    for (const r of tint) expect(card.matches(r.sel)).toBe(false);
    expect(rules.some((r) => /box-shadow/.test(r.body) && card.matches(r.sel))).toBe(true);
    // A focused row still takes the tint.
    const row = doc.createElement("div");
    row.className = "chg-story chg-row";
    row.setAttribute("data-focused", "true");
    expect(tint.some((r) => row.matches(r.sel))).toBe(true);
  });

  test("every worded risk shows whole on its own line, hazards before the size note", () => {
    const risks = [{ code: "bulk", evidence: [] }, { code: "schema", evidence: [] }, { code: "skew", evidence: [] }];
    const html = render({ ...lead, risks, risk_lines: { bulk: "Nobody reviewed 4,000 lines.", schema: "Run the migration first …", skew: "Old CLIs call the new route." } } as any, false);
    const lines = [...html.matchAll(/<span class="block \[overflow-wrap:anywhere\][^"]*"[^>]*>([^<]*)<\/span>/g)].map((m) => m[1]);
    expect(lines).toEqual(["Run the migration first.", "Old CLIs call the new route.", "Nobody reviewed 4,000 lines."]);
    expect(html).not.toContain("line-clamp");
    expect(html).not.toContain("more</span>");
  });

  test("a long file path in a risk shows as its file name", () => {
    const line = "Ship packages/convex/convex/migrations/20261001215647_flawless_sersi.sql before the web deploy, see convex/schema.ts.";
    const html = render({ ...lead, risks: [{ code: "schema", evidence: [] }], risk_lines: { schema: line } } as any, false);
    expect(html).toContain("Ship 20261001215647_flawless_sersi.sql before the web deploy, see convex/schema.ts.");
    expect(html).not.toContain("packages/convex/convex/migrations/");
  });
});
