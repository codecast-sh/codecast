import { describe, expect, test } from "bun:test";
import {
  addAlternatives,
  pickAlternative,
  settleAlternatives,
  ghostText,
  reviveText,
  makeCuts,
  flagText,
  clearFlags,
  stripDrafting,
  describeDrafts,
  agreeArticle,
  serializeDraftRuns,
  draftTextNodes,
  findDraftSpans,
  DraftTargetError,
  TRIM_REASON,
} from "./drafting";

const DOC = "Much of the tension in product design.\n\nLike a paperclip, for example.";

describe("alternatives", () => {
  test("wrap, list, cycle and settle", () => {
    let md = addAlternatives(DOC, "tension", ["pressure", "struggle"]);
    expect(md).toContain(`<span data-alts='[{"t":"pressure"},{"t":"struggle"}]' data-alt-at="0">tension</span>`);
    md = addAlternatives(md, "tension", ["difficulty", "pressure"], { ai: true });
    expect(describeDrafts(md)[0]).toMatchObject({
      kind: "alts",
      shown: "tension",
      at: 0,
      versions: [{ t: "tension" }, { t: "pressure" }, { t: "struggle" }, { t: "difficulty", ai: true }],
    });
    md = pickAlternative(md, "tension", 3);
    expect(stripDrafting(md)).toContain("Much of the difficulty in");
    const d = describeDrafts(md)[0] as any;
    expect(d.at).toBe(3);
    expect(d.versions.map((v: any) => v.t)).toEqual(["tension", "pressure", "struggle", "difficulty"]);
    expect(d.versions[3].ai).toBe(true);
    md = settleAlternatives(md, "difficulty");
    expect(md).toBe(DOC.replace("tension", "difficulty"));
  });

  test("a/an agrees with the swapped word", () => {
    let md = addAlternatives(DOC, "paperclip", ["eraser", "hour glass", "unicorn"]);
    md = pickAlternative(md, "paperclip", 1);
    expect(stripDrafting(md)).toContain("Like an eraser,");
    md = pickAlternative(md, "eraser", 3);
    expect(stripDrafting(md)).toContain("Like a unicorn,");
    md = pickAlternative(md, "unicorn", 2);
    expect(stripDrafting(md)).toContain("Like an hour glass,");
    expect(agreeArticle("An ", "tree")).toBe("A ");
    expect(agreeArticle("banana ", "egg")).toBe("banana ");
  });

  test("ambiguous and missing targets are refused with a reason", () => {
    expect(() => addAlternatives("a cat and a cat", "cat", ["dog"])).toThrow(DraftTargetError);
    expect(addAlternatives("a cat and a cat", "cat", ["dog"], { occurrence: 2 })).toContain(`a cat and a <span`);
    expect(() => ghostText(DOC, "nope")).toThrow(/not in the doc/);
  });
});

describe("ghosts and cuts", () => {
  test("ghost, revive, propose and make cuts", () => {
    let md = ghostText(DOC, ", for example");
    expect(md).toContain(`<span data-ghost="">, for example</span>`);
    expect(reviveText(md, ", for example")).toBe(DOC);
    md = ghostText(DOC, "Much of ", { reason: TRIM_REASON });
    md = ghostText(md, ", for example", {});
    expect(makeCuts(md)).toBe(`the tension in product design.\n\nLike a paperclip<span data-ghost="">, for example</span>.`);
    expect(stripDrafting(md, { dropGhosts: true })).toBe("the tension in product design.\n\nLike a paperclip.");
    expect(reviveText(md, undefined, { reason: TRIM_REASON })).toContain("Much of the");
  });

  test("flags", () => {
    const md = flagText(DOC, "Much of the tension in product design.", "convoluted", { note: "Two ideas, 'one' sentence" });
    const d = describeDrafts(md)[0] as any;
    expect(d).toMatchObject({ kind: "flag", flag: "convoluted", note: "Two ideas, 'one' sentence" });
    expect(clearFlags(md)).toBe(DOC);
  });
});

describe("editor JSON bridge", () => {
  test("markdown spans become marks and serialize back as one span per run", () => {
    const md = addAlternatives("Much of the tension here", "tension here", ["pressure there"]);
    const ghosted = ghostText(md, "Much ");
    const nodes = draftTextNodes(ghosted);
    expect(nodes.map((n) => n.text)).toEqual(["Much ", "of the ", "tension here"]);
    expect(nodes[2].marks?.[0]).toMatchObject({ type: "draftAlts", attrs: { at: 0 } });
    // Bold inside the span splits the run in the editor: still one span on save.
    const split = [
      nodes[0],
      nodes[1],
      { ...nodes[2], text: "tension", marks: [...nodes[2].marks!, { type: "bold" }] },
      { ...nodes[2], text: " here" },
    ];
    const out = serializeDraftRuns(split, (n) => (n.marks?.some((m) => m.type === "bold") ? `**${n.text}**` : n.text!));
    expect(out).toBe(ghosted.replace(">tension here<", ">**tension** here<"));
    expect(findDraftSpans(out)).toHaveLength(2);
  });
});

describe("Lab results in markdown", () => {
  const { applyLabResult, dropAlternative } = require("./drafting");
  test("a new trim replaces the last one; misses are reported", () => {
    let r = applyLabResult(DOC, { tool: "trim", level: "slight", cuts: ["Much of "] });
    r = applyLabResult(r.md, { tool: "trim", level: "tighten", cuts: [", for example", "not here"] });
    expect(r.applied).toBe(1);
    expect(r.missed).toEqual(["not here"]);
    expect(describeDrafts(r.md)).toEqual([{ kind: "ghost", text: ", for example", reason: "trim" }]);
  });
  test("typos become a version the writer can flip back", () => {
    const r = applyLabResult("Teh end.", { tool: "typos", fixes: [{ old: "Teh", new: "The" }] });
    expect(stripDrafting(r.md)).toBe("The end.");
    expect(stripDrafting(pickAlternative(r.md, "The", 0))).toBe("Teh end.");
  });
  test("dropping a version keeps the original first and the shown one showing", () => {
    let md = addAlternatives(DOC, "tension", ["pressure", "struggle"]);
    md = pickAlternative(md, "tension", 2);
    md = dropAlternative(md, "struggle", 1);
    const d = describeDrafts(md)[0] as any;
    expect(d.versions.map((v: any) => v.t)).toEqual(["tension", "struggle"]);
    expect(d.at).toBe(1);
    expect(() => dropAlternative(md, "struggle", 1)).toThrow(/showing/);
    expect(dropAlternative(md, "struggle", 0)).toBe(DOC.replace("tension", "struggle"));
  });
});
