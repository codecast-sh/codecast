import { describe, expect, test } from "bun:test";
import { diffTrees, filterTree, formatDiff, parseTree, resolveElement } from "./tree.js";
import { ComputerError } from "./errors.js";

const tree = (lines: string[], focus = "No UI element is currently focused.") =>
  ['App=com.apple.Preview (pid 1)', 'Window: "W", App: Preview.', "", ...lines, "", focus].join("\n");

// The Preview window from the session that motivated this module, trimmed.
const BEFORE = tree([
  "0 standard window cc-sign.pdf",
  "\t29 edit toolbar",
  "\t\t42 button Sign",
  "\t\t45 button Shape Style",
  "\t50 text Signed: ______",
]);
const POPOVER = tree([
  "0 standard window cc-sign.pdf",
  "\t29 edit toolbar",
  "\t\t42 button Sign",
  "\t\t45 button Shape Style",
  "\t\t53 popover, Secondary Actions: cancel",
  "\t\t\t55 table Signatures",
  "\t\t\t\t57 cell, Secondary Actions: Insert signature, Remove signature",
  "\t\t\t\t\t58 image Created January 27, 2025",
  "\t\t\t\t60 cell, Secondary Actions: Insert signature, Remove signature",
  "\t\t\t\t\t61 image Created May 14, 2024",
  "\t61 text Signed: ______",
]);

describe("parseTree", () => {
  test("reads index, depth and body, and the focus sentence", () => {
    const parsed = parseTree(tree(["0 window W", "\t3 button Save"], "The focused UI element is 3 button Save."));
    expect(parsed.lines.map((l) => [l.index, l.depth, l.body])).toEqual([
      [0, 0, "window W"],
      [3, 1, "button Save"],
    ]);
    expect(parsed.focus).toBe("The focused UI element is 3 button Save.");
  });

  test("keeps a line that names no element, such as an omission note", () => {
    const parsed = parseTree(tree(["0 window W", "\t... 12 inactive browser tabs omitted"]));
    expect(parsed.lines[1]).toMatchObject({ index: null, depth: 1, body: "... 12 inactive browser tabs omitted" });
  });
});

describe("diffTrees", () => {
  test("an element that only renumbered is not a change", () => {
    const diff = diffTrees(BEFORE, POPOVER);
    expect(diff.removed).toEqual([]);
    expect(diff.added.map((l) => l.index)).toEqual([53, 55, 57, 58, 60, 61]);
  });

  test("a closed popover reads as its root and a count, not every line in it", () => {
    const out = formatDiff(diffTrees(POPOVER, BEFORE))!;
    expect(out).toContain("Changes: 0 added, 6 removed");
    expect(out).toContain("-     53 popover, Secondary Actions: cancel  (and 5 lines under it)");
    expect(out.split("\n")).toHaveLength(2);
  });

  test("no change says so, in the words that fit how the action was delivered", () => {
    expect(formatDiff(diffTrees(BEFORE, BEFORE))).toContain("it was probably ignored");
    expect(formatDiff(diffTrees(BEFORE, BEFORE), { synthetic: true })).toContain("take a screenshot to be sure");
  });

  test("a focus that moved is named, and a focused field whose value changed is not repeated", () => {
    const a = tree(["0 window W", "\t1 text field a"], "The focused UI element is 1 text field a.");
    const b = tree(["0 window W", "\t1 text field ab"], "The focused UI element is 1 text field ab.");
    expect(formatDiff(diffTrees(a, b))).not.toContain("The focused UI element");
    const c = tree(["0 window W", "\t1 text field a", "\t2 button Go"], "The focused UI element is 2 button Go.");
    expect(formatDiff(diffTrees(a, c))).toContain("The focused UI element is 2 button Go.");
  });

  test("a change too large to read as a diff hands back null, so the caller prints the tree", () => {
    const big = tree(["0 window W", ...Array.from({ length: 80 }, (_, i) => `\t${i + 1} text row ${i}`)]);
    expect(formatDiff(diffTrees(BEFORE, big))).toBeNull();
  });
});

describe("filterTree", () => {
  test("find keeps matches and their ancestors", () => {
    expect(filterTree(POPOVER, { find: "Created May" })).toBe(
      ["0 standard window cc-sign.pdf", "  29 edit toolbar", "    53 popover, Secondary Actions: cancel", "      55 table Signatures", "        60 cell, Secondary Actions: Insert signature, Remove signature", "          61 image Created May 14, 2024"].join("\n"),
    );
  });

  test("a /regex/ query matches case insensitively", () => {
    expect(filterTree(POPOVER, { find: "/button (sign|shape)/" })).toContain("45 button Shape Style");
  });

  test("under prints one subtree, re-indented from its root", () => {
    expect(filterTree(POPOVER, { under: 55 })!.split("\n")[0]).toBe("55 table Signatures");
    expect(filterTree(POPOVER, { under: 999 })).toBeNull();
  });

  test("nothing matched is null, not an empty tree", () => {
    expect(filterTree(POPOVER, { find: "nowhere" })).toBeNull();
  });
});

describe("resolveElement", () => {
  test("an index passes through, with or without #", () => {
    expect(resolveElement(POPOVER, "#57")).toBe(57);
    expect(resolveElement(POPOVER, "57")).toBe(57);
  });

  test("an exact name beats every line that merely mentions it", () => {
    expect(resolveElement(POPOVER, "Sign")).toBe(42);
    expect(resolveElement(POPOVER, "button Sign")).toBe(42);
  });

  test("several equally good matches are listed, never guessed", () => {
    let error: unknown;
    try {
      resolveElement(POPOVER, "Insert signature");
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(ComputerError);
    expect((error as ComputerError).code).toBe("invalid_argument");
    expect((error as Error).message).toContain("matches 2 elements");
    expect((error as Error).message).toContain("  57 cell");
    expect(resolveElement(POPOVER, "Insert signature", 2)).toBe(60);
  });

  test("an action climbs from the label that matched to the cell that offers it", () => {
    expect(resolveElement(POPOVER, "Created May", undefined, { action: "insert signature" })).toBe(60);
    expect(() => resolveElement(POPOVER, "Created May", undefined, { action: "delete" })).toThrow("and offers 'delete'");
  });

  test("no match names the way to look", () => {
    expect(() => resolveElement(POPOVER, "Export")).toThrow("get-app-state --find");
  });
});
