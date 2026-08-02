// What an embed card shows for `![[Note#Heading]]` / `![[Note#^id]]`.
// The pins that matter are the boundaries: where a section ends, what a block
// drags along with it, and what happens when the subpath names something that
// isn't there.

import { test, expect, describe } from "bun:test";
import { extractEmbedSection } from "../embedSection";
import { parseNote } from "../parseNote";

const NOTE = [
  "---",
  "title: Release",
  "---",
  "",
  "Intro paragraph.",
  "",
  "## Plan",
  "",
  "First step.",
  "",
  "### Details",
  "",
  "- item one ^one",
  "  continued under the item",
  "  - nested item",
  "",
  "Outside the item.",
  "",
  "## Risks",
  "",
  "A risky paragraph.",
  "",
  "^risk",
  "",
  "## Ship",
].join("\n");

const section = (subpath: string, type: "heading" | "block" = "heading") =>
  extractEmbedSection(NOTE, { subpath, subpathType: type }, parseNote(NOTE));

describe("whole note", () => {
  test("no subpath strips frontmatter and keeps the body", () => {
    const out = extractEmbedSection(NOTE, {}, parseNote(NOTE));
    expect(out.kind).toBe("note");
    expect(out.missing).toBe(false);
    expect(out.content.startsWith("Intro paragraph.")).toBe(true);
    expect(out.content).not.toContain("title: Release");
  });
});

describe("heading sections", () => {
  test("a section runs to the next same-or-higher heading and includes its subheadings", () => {
    const out = section("Plan");
    expect(out.kind).toBe("heading");
    expect(out.missing).toBe(false);
    expect(out.content).toContain("## Plan");
    expect(out.content).toContain("### Details");
    expect(out.content).toContain("nested item");
    expect(out.content).not.toContain("## Risks");
  });

  test("a subheading stops at the next heading of its own level or above", () => {
    const out = section("Details");
    expect(out.content).toContain("### Details");
    expect(out.content).toContain("- item one ^one");
    expect(out.content).not.toContain("## Risks");
  });

  test("the last heading in the file runs to EOF", () => {
    const out = section("Ship");
    expect(out.content).toBe("## Ship");
  });

  test("a nested heading path resolves each segment inside the previous one", () => {
    expect(section("Plan#Details").content).toContain("### Details");
    // "Details" does not live under "Risks", so the path fails rather than
    // falling through to the first heading with that name anywhere.
    expect(section("Risks#Details").missing).toBe(true);
  });

  test("a heading written in slug form still lands", () => {
    expect(section("a-risky-heading").missing).toBe(true);
    expect(extractEmbedSection("# Café Réunion\n\nbody", { subpath: "café-réunion", subpathType: "heading" })
      .content).toContain("# Café Réunion");
  });

  test("case is ignored", () => {
    expect(section("pLaN").content).toContain("## Plan");
  });

  test("a missing heading falls back to the whole note and says so", () => {
    const out = section("Nowhere");
    expect(out.missing).toBe(true);
    expect(out.kind).toBe("note");
    expect(out.content).toContain("Intro paragraph.");
    expect(out.content).toContain("## Ship");
  });
});

describe("block ids", () => {
  test("a list item carries its indented continuation and nested items", () => {
    const out = section("one", "block");
    expect(out.kind).toBe("block");
    expect(out.content).toBe(["- item one ^one", "  continued under the item", "  - nested item"].join("\n"));
    expect(out.content).not.toContain("Outside the item.");
  });

  test("a bare `^id` line embeds the paragraph it labels, not the id line", () => {
    const out = section("risk", "block");
    expect(out.content).toBe("A risky paragraph.");
  });

  test("an id on a plain paragraph line embeds that line", () => {
    const src = "Intro.\n\nThe claim itself. ^claim\n\nAfter.";
    const out = extractEmbedSection(src, { subpath: "claim", subpathType: "block" }, parseNote(src));
    expect(out.content).toBe("The claim itself. ^claim");
  });

  test("a multi-line paragraph above a bare id comes along whole", () => {
    const src = "# H\n\nline one\nline two\n\n^p\n";
    const out = extractEmbedSection(src, { subpath: "p", subpathType: "block" }, parseNote(src));
    expect(out.content).toBe("line one\nline two");
  });

  test("a missing block id falls back to the whole note and says so", () => {
    const out = section("nope", "block");
    expect(out.missing).toBe(true);
    expect(out.kind).toBe("note");
  });

  test("ids match case-insensitively", () => {
    expect(section("ONE", "block").content).toContain("item one");
  });
});

describe("line endings", () => {
  const CRLF = NOTE.replace(/\n/g, "\r\n");

  test("CRLF content slices on the same lines and renders without stray returns", () => {
    const out = extractEmbedSection(CRLF, { subpath: "Plan", subpathType: "heading" }, parseNote(CRLF));
    expect(out.content).toContain("## Plan");
    expect(out.content).toContain("### Details");
    expect(out.content).not.toContain("\r");
    expect(out.content).not.toContain("## Risks");
  });

  test("CRLF whole-note embeds still drop the frontmatter", () => {
    const out = extractEmbedSection(CRLF, {}, parseNote(CRLF));
    expect(out.content).not.toContain("title: Release");
    expect(out.content.trimStart().startsWith("Intro paragraph.")).toBe(true);
  });
});

describe("without a prebuilt parse", () => {
  test("the helper parses the content itself when the index has nothing", () => {
    const out = extractEmbedSection(NOTE, { subpath: "Risks", subpathType: "heading" });
    expect(out.content).toContain("## Risks");
    expect(out.content).toContain("A risky paragraph.");
  });
});

// A tab-indented continuation under a space-indented parent must not read as a
// dedent — raw character counts made one tab look shallower than two spaces
// and silently dropped the continuation (review finding, R12).
test("block embed keeps continuations when tabs and spaces mix", () => {
  const mixed = "  - Parent item ^blk1\n\tChild continuation\n- Sibling\n";
  const out = extractEmbedSection(mixed, { subpath: "blk1", subpathType: "block" });
  expect(out.content).toContain("Parent item");
  expect(out.content).toContain("Child continuation");
  expect(out.content).not.toContain("Sibling");

  const allTabs = "\t- Parent item ^blk2\n\t\tChild continuation\n";
  const out2 = extractEmbedSection(allTabs, { subpath: "blk2", subpathType: "block" });
  expect(out2.content).toContain("Child continuation");
});
