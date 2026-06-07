import { describe, expect, test } from "bun:test";
import { classifyDocContent, extractTitleFromContent, inlineDocSourceKey } from "./docExtraction";

describe("extractTitleFromContent", () => {
  test("uses frontmatter name: value, not the raw line", () => {
    const md = `---
name: counterparty-search-redesign
description: "June 2026 decision to replace the agentic loop"
metadata:
  type: project
---

June 2026. Two sessions converged on replacing the loop.`;
    expect(extractTitleFromContent(md)).toBe("counterparty-search-redesign");
  });

  test("prefers frontmatter title: and strips quotes", () => {
    const md = `---
title: "My Real Title"
---
body text here that is long enough`;
    expect(extractTitleFromContent(md)).toBe("My Real Title");
  });

  test("frontmatter without name/title falls through to body H1", () => {
    const md = `---
metadata:
  type: project
---
# Actual Heading

body`;
    expect(extractTitleFromContent(md)).toBe("Actual Heading");
  });

  test("frontmatter line never becomes the title even without headings", () => {
    const md = `---
description: something descriptive and long
---
A first body line that is plenty long.`;
    expect(extractTitleFromContent(md)).toBe("A first body line that is plenty long.");
  });

  test("plain H1 doc unchanged", () => {
    expect(extractTitleFromContent("# Hello World\n\nbody")).toBe("Hello World");
  });

  test("falls back to first long line, stripping list markers", () => {
    expect(extractTitleFromContent("- The key insight: runners exist\nmore")).toBe(
      "The key insight: runners exist",
    );
  });
});

describe("inlineDocSourceKey", () => {
  test("is stable for the same message (no wall-clock)", () => {
    const a = inlineDocSourceKey("conv1", 1780722790076);
    const b = inlineDocSourceKey("conv1", 1780722790076);
    expect(a).toBe(b);
    expect(a).toBe("inline://conv1/1780722790076");
  });

  test("missing timestamp degrades to a stable 0 key", () => {
    expect(inlineDocSourceKey("conv1", undefined)).toBe("inline://conv1/0");
  });
});

describe("classifyDocContent", () => {
  test("keeps the richer patterns from the backfill variant", () => {
    expect(classifyDocContent("here is what's happening with the bug")).toBe("investigation");
    expect(classifyDocContent("picking up from the last session")).toBe("handoff");
    expect(classifyDocContent("## phases\n1. do it")).toBe("plan");
  });
});
