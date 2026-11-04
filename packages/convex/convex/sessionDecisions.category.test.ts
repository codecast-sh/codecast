import { describe, expect, test } from "bun:test";
import { assignCategory, pinnedCategory } from "./lib/decisionCategory";

const twoOptions = [
  { label: "Keep vendored", description: "no change" },
  { label: "Switch to upstream", description: "one afternoon of work" },
];

describe("category assignment", () => {
  test("an option naming a deploy to production pins the protected category", () => {
    const { category, pinned } = assignCategory(
      { question: "How do we ship the fix?", options: [{ label: "Deploy to production now" }, { label: "Wait for the batch" }] },
      "approach",
    );
    expect(category).toBe("production");
    expect(pinned).toBe(true);
  });

  test("an open proposal stands when nothing pins", () => {
    expect(assignCategory({ question: "Which parser?", options: twoOptions }, "approach")).toEqual({ category: "approach", pinned: false });
  });

  test("no proposal and nothing pinned is unknown (human held)", () => {
    expect(assignCategory({ question: "Which parser?", options: twoOptions }, undefined).category).toBe("unknown");
  });

  test("a proposal outside the vocabulary is ignored", () => {
    expect(assignCategory({ question: "Which parser?", options: twoOptions }, "whatever").category).toBe("unknown");
  });

  test("option cost and risk strings are not scanned: a priced approach decision stays approach", () => {
    const r = assignCategory(
      {
        question: "Which parser?",
        options: [
          { label: "Keep vendored", cost: "$0", risk: "drift" },
          { label: "Switch to upstream", cost: "$2k and one afternoon", risk: "purchase a support plan later" },
        ],
      },
      "approach",
    );
    expect(r).toEqual({ category: "approach", pinned: false });
    // The same words in a label still pin.
    expect(pinnedCategory({ question: "Which parser?", options: [{ label: "Purchase the pro parser" }, { label: "Keep" }] })).toBe("billing");
  });

  test("deletion, purchase, access and external messages each pin their category", () => {
    expect(pinnedCategory({ question: "Clean up?", options: [{ label: "Delete the old rows" }, { label: "Keep" }] })).toBe("data");
    expect(pinnedCategory({ question: "Tooling?", options: [{ label: "Buy the pro plan" }, { label: "Stay free" }] })).toBe("billing");
    expect(pinnedCategory({ question: "Onboarding?", options: [{ label: "Grant access to the repo" }, { label: "Wait" }] })).toBe("access");
    expect(pinnedCategory({ question: "Customer?", options: [{ label: "Send the email today" }, { label: "Hold" }] })).toBe("external");
    expect(pinnedCategory({ question: "Cap?", options: [{ label: "Raise the limit to 500" }, { label: "Keep 100" }] })).toBe("limit");
  });
});
