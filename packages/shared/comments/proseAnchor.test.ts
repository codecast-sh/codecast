import { describe, expect, test } from "bun:test";
import {
  captureProseAnchor,
  PROSE_ANCHOR_MAX_CHARS,
  prosePlacementLabel,
  proseSimilarity,
  resolveProseAnchor,
  type ProseAnchor,
} from "./proseAnchor";

const DOC = [
  "# Rollout plan",
  "First we add the optional field to the schema and deploy it alone.",
  "Then the client writes both copies behind a flag that defaults off.",
  "A parity sweep compares every old row with its new twin.",
  "Old writes stop only after the sweep is clean on prod.",
];

const at = (index: number) => captureProseAnchor(DOC, index)!;

describe("captureProseAnchor", () => {
  test("keeps the block, both neighbours and the index", () => {
    expect(at(2)).toEqual({ text: DOC[2], before: DOC[1], after: DOC[3], index: 2 });
  });

  test("the first and last blocks have one neighbour", () => {
    expect(at(0)).toEqual({ text: DOC[0], after: DOC[1], index: 0 });
    expect(at(4)).toEqual({ text: DOC[4], before: DOC[3], index: 4 });
  });

  test("a quoted selection replaces the block text", () => {
    expect(captureProseAnchor(DOC, 1, "optional field")!.text).toBe("optional field");
  });

  test("out of range is undefined", () => {
    expect(captureProseAnchor(DOC, 5)).toBeUndefined();
    expect(captureProseAnchor(DOC, -1)).toBeUndefined();
    expect(captureProseAnchor([], 0)).toBeUndefined();
  });

  test("long text is capped and still resolves", () => {
    const long = "word ".repeat(600);
    const blocks = ["intro paragraph here", long];
    const anchor = captureProseAnchor(blocks, 1)!;
    expect(anchor.text.length).toBe(PROSE_ANCHOR_MAX_CHARS);
    expect(resolveProseAnchor(anchor, ["new first block", ...blocks])).toMatchObject({ state: "moved", index: 2 });
  });

  test("the anchor is a plain JSON value", () => {
    expect(JSON.parse(JSON.stringify(at(2)))).toEqual(at(2));
  });
});

describe("resolveProseAnchor", () => {
  test("unchanged content is current", () => {
    for (let i = 0; i < DOC.length; i++) {
      expect(resolveProseAnchor(at(i), DOC)).toEqual({ state: "current", index: i, match: "exact" });
    }
  });

  test("an edit below leaves it current", () => {
    const next = [...DOC.slice(0, 3), "A brand new closing paragraph about something else entirely."];
    expect(resolveProseAnchor(at(2), next)).toEqual({ state: "current", index: 2, match: "exact" });
  });

  test("blocks added above move it", () => {
    const next = [DOC[0], "A new caveat paragraph.", "And another one.", ...DOC.slice(1)];
    expect(resolveProseAnchor(at(2), next)).toEqual({ state: "moved", index: 4, from: 2, match: "exact" });
  });

  test("a block removed above moves it up", () => {
    const next = [DOC[0], ...DOC.slice(2)];
    expect(resolveProseAnchor(at(3), next)).toEqual({ state: "moved", index: 2, from: 3, match: "exact" });
  });

  test("whitespace-only changes still match", () => {
    const next = [...DOC];
    next[2] = "  Then the client writes\nboth copies   behind a flag that defaults off.\n";
    expect(resolveProseAnchor(at(2), next)).toEqual({ state: "current", index: 2, match: "normalized" });
    expect(resolveProseAnchor(at(2), ["inserted", ...next])).toEqual({ state: "moved", index: 3, from: 2, match: "normalized" });
  });

  test("a light edit is a near match", () => {
    const next = [...DOC];
    next[3] = "A parity sweep compares each old row with its new twin.";
    expect(resolveProseAnchor(at(3), next)).toEqual({ state: "current", index: 3, match: "near" });
    expect(resolveProseAnchor(at(3), ["inserted", ...next])).toEqual({ state: "moved", index: 4, from: 3, match: "near" });
  });

  test("a rewrite below the threshold is outdated", () => {
    const next = [...DOC];
    next[3] = "We will skip verification and hope for the best.";
    expect(resolveProseAnchor(at(3), next)).toEqual({ state: "outdated", index: 2, from: 3, beside: "previous" });
  });

  test("a split block resolves to its first piece", () => {
    const next = [
      ...DOC.slice(0, 2),
      "Then the client writes both copies.",
      "Behind a flag that defaults off.",
      ...DOC.slice(3),
    ];
    const anchor = { ...at(2), text: "Then the client writes both copies. Behind a flag that defaults off." };
    expect(resolveProseAnchor(anchor, next)).toEqual({ state: "current", index: 2, match: "split" });
    expect(resolveProseAnchor(anchor, ["inserted", ...next])).toEqual({ state: "moved", index: 3, from: 2, match: "split" });
  });

  test("merged blocks both resolve to the merged block", () => {
    const next = [DOC[0], `${DOC[1]} ${DOC[2]}`, ...DOC.slice(3)];
    expect(resolveProseAnchor(at(1), next)).toEqual({ state: "current", index: 1, match: "contained" });
    expect(resolveProseAnchor(at(2), next)).toEqual({ state: "moved", index: 1, from: 2, match: "contained" });
  });

  test("a quoted selection is found inside its block, or across into the next", () => {
    expect(resolveProseAnchor({ text: "behind a flag", index: 2 }, DOC)).toEqual({ state: "current", index: 2, match: "contained" });
    expect(resolveProseAnchor({ text: "defaults off. A parity sweep", index: 2 }, DOC)).toEqual({ state: "current", index: 2, match: "contained" });
    expect(resolveProseAnchor({ text: "behind a flag", index: 2 }, ["inserted", ...DOC])).toEqual({ state: "moved", index: 3, from: 2, match: "contained" });
  });

  test("a short selection only confirms the block it was on", () => {
    expect(resolveProseAnchor({ text: "the", index: 1 }, DOC)).toEqual({ state: "current", index: 1, match: "contained" });
    expect(resolveProseAnchor({ text: "the", index: 1 }, ["inserted", ...DOC]).state).toBe("outdated");
  });

  describe("duplicates", () => {
    const blocks = ["Intro text here.", "Looks good to me.", "Middle section here.", "Looks good to me.", "Outro text here."];

    test("the copy at the old index wins", () => {
      expect(resolveProseAnchor(captureProseAnchor(blocks, 3)!, blocks)).toEqual({ state: "current", index: 3, match: "exact" });
    });

    test("neighbours pick the right copy after a move", () => {
      const anchor = captureProseAnchor(blocks, 3)!;
      expect(resolveProseAnchor(anchor, ["New top.", ...blocks])).toEqual({ state: "moved", index: 4, from: 3, match: "exact" });
    });

    test("copies with nothing to tell them apart are ambiguous", () => {
      const anchor: ProseAnchor = { text: "Looks good to me.", index: 3 };
      expect(resolveProseAnchor(anchor, ["New top.", ...blocks])).toEqual({ state: "ambiguous", index: 3, from: 3, candidates: [2, 4] });
    });

    test("copies with the same neighbours are ambiguous", () => {
      const twins = ["Heading", "Same body text.", "Footer", "Heading", "Same body text.", "Footer"];
      const anchor = captureProseAnchor(twins, 1)!;
      const placed = resolveProseAnchor(anchor, ["New top.", ...twins]);
      expect(placed).toEqual({ state: "ambiguous", index: 1, from: 1, candidates: [2, 5] });
    });
  });

  describe("deleted block", () => {
    test("drawn after the surviving previous neighbour", () => {
      const next = ["New top block.", ...DOC.slice(0, 2), ...DOC.slice(3)];
      expect(resolveProseAnchor(at(2), next)).toEqual({ state: "outdated", index: 2, from: 2, beside: "previous" });
    });

    test("drawn before the next neighbour when the previous one is gone too", () => {
      const next = [DOC[0], DOC[3], DOC[4]];
      expect(resolveProseAnchor(at(2), next)).toEqual({ state: "outdated", index: 1, from: 2, beside: "next" });
    });

    test("with no neighbour left it stays at its old index, clamped", () => {
      expect(resolveProseAnchor(at(3), ["Something", "Else"])).toEqual({ state: "outdated", index: 1, from: 3, beside: null });
      expect(resolveProseAnchor({ text: "gone forever and ever", index: 0 }, ["Other text entirely."])).toEqual({ state: "outdated", index: 0, from: 0, beside: null });
    });

    test("an empty document has nowhere to draw", () => {
      expect(resolveProseAnchor(at(2), [])).toEqual({ state: "outdated", index: null, from: 2, beside: null });
    });
  });

  test("an anchor without neighbours (an existing quote) resolves by text and index", () => {
    const legacy: ProseAnchor = { text: DOC[3], index: 3 };
    expect(resolveProseAnchor(legacy, DOC)).toEqual({ state: "current", index: 3, match: "exact" });
    expect(resolveProseAnchor(legacy, DOC.slice(1))).toEqual({ state: "moved", index: 2, from: 3, match: "exact" });
    expect(resolveProseAnchor(legacy, DOC.filter((_, i) => i !== 3))).toEqual({ state: "outdated", index: 3, from: 3, beside: null });
  });
});

describe("proseSimilarity", () => {
  test("bounds", () => {
    expect(proseSimilarity("same text", "same text")).toBe(1);
    expect(proseSimilarity("abc", "xyz")).toBe(0);
    expect(proseSimilarity("a", "abc")).toBe(0);
  });
});

describe("prosePlacementLabel", () => {
  test("names moved and outdated, nothing otherwise", () => {
    expect(prosePlacementLabel({ state: "current", index: 0, match: "exact" })).toBe("");
    expect(prosePlacementLabel({ state: "moved", index: 1, from: 0, match: "exact" })).toBe("moved");
    expect(prosePlacementLabel({ state: "outdated", index: 0, from: 0, beside: null })).toBe("outdated");
    expect(prosePlacementLabel({ state: "ambiguous", index: 0, from: 0, candidates: [1, 2] })).toBe("outdated");
    expect(prosePlacementLabel(null)).toBe("");
  });
});
