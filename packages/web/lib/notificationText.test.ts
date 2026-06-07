import { test, expect, describe } from "bun:test";
import { docContentPreview, stripMarkdown } from "./notificationText";

describe("docContentPreview", () => {
  test("drops frontmatter and the leading H1, keeps body prose", () => {
    const out = docContentPreview(
      "---\nname: some-doc\ntype: note\n---\n# The Title\n\nFirst paragraph here.\n\nSecond paragraph.",
    );
    expect(out).not.toContain("name: some-doc");
    expect(out).not.toContain("The Title");
    expect(out).toContain("First paragraph here.");
    expect(out).toContain("Second paragraph.");
  });

  test("keeps paragraph breaks instead of flattening to one line", () => {
    const out = docContentPreview("para one\n\n\n\npara two");
    expect(out).toBe("para one\n\npara two");
  });

  test("drops code fences and resolves entity mentions to display text", () => {
    const out = docContentPreview(
      "Intro text.\n\n```ts\nconst secret = 1;\n```\n\nSee @[My Design doc:jh7d8k2m9n4p6q1r3s5t7v9w0] and @[Fix bug ct-1234].",
    );
    expect(out).not.toContain("const secret");
    expect(out).toContain("See My Design and Fix bug.");
  });

  test("truncates long content with an ellipsis", () => {
    const out = docContentPreview("word ".repeat(500), 100);
    expect(out.length).toBeLessThanOrEqual(101);
    expect(out.endsWith("…")).toBe(true);
  });

  test("empty/missing content yields empty string", () => {
    expect(docContentPreview(undefined)).toBe("");
    expect(docContentPreview("")).toBe("");
  });
});

describe("stripMarkdown keepNewlines option", () => {
  test("default flattens newlines (notification behavior unchanged)", () => {
    expect(stripMarkdown("a\nb\n\nc")).toBe("a b c");
  });

  test("keepNewlines preserves breaks, collapsing 3+ to a paragraph break", () => {
    expect(stripMarkdown("a\nb\n\n\n\nc", { keepNewlines: true })).toBe("a\nb\n\nc");
  });
});
