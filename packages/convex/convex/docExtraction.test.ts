import { describe, expect, test } from "bun:test";
import { classifyDocContent, extractTitleFromContent, findSameInlineDoc, inlineDocSourceKey } from "./docExtraction";

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
    const a = inlineDocSourceKey("user1", 1780722790076);
    const b = inlineDocSourceKey("user1", 1780722790076);
    expect(a).toBe(b);
    expect(a).toBe("inline://user1/1780722790076");
  });

  test("is user-scoped, not conversation-scoped — forks of the same transcript share keys", () => {
    // The same message re-synced into two forked conversations must produce
    // the same key; conversation identity must not appear in it.
    const inForkA = inlineDocSourceKey("user1", 1780722790076);
    const inForkB = inlineDocSourceKey("user1", 1780722790076);
    expect(inForkA).toBe(inForkB);
    expect(inForkA.includes("conv")).toBe(false);
  });

  test("missing timestamp degrades to a stable 0 key", () => {
    expect(inlineDocSourceKey("user1", undefined)).toBe("inline://user1/0");
  });

  test("message uuid wins over timestamp — a re-parse that restamps the clock keeps the key", () => {
    // The CLI stamps Date.now() on transcript entries without their own
    // timestamp, so the same message re-synced twice arrives with two
    // different timestamps. The uuid is what survives the re-parse.
    const first = inlineDocSourceKey("user1", 1785599268092, "uuid-abc");
    const retry = inlineDocSourceKey("user1", 1785605328380, "uuid-abc");
    expect(first).toBe(retry);
    expect(first).toBe("inline://user1/uuid-abc");
  });
});

describe("findSameInlineDoc", () => {
  const base = "# Stage 1: Starting with an idea\n\n" + "x".repeat(6000);

  test("matches by stable source key", () => {
    const doc = { source_file: "inline://u/uuid-abc", source: "inline_extract", content: base };
    expect(findSameInlineDoc([doc], "inline://u/uuid-abc", base + "more")).toBe(doc);
  });

  test("matches a streaming snapshot: existing content is a prefix of the longer re-sync", () => {
    // Regression: a still-streaming message re-synced at growing lengths with
    // restamped timestamps inserted one doc per snapshot (12 copies in prod).
    const doc = { source_file: "inline://u/1785599268092", source: "inline_extract", content: base };
    expect(findSameInlineDoc([doc], "inline://u/1785605328380", base + "\n\nnew tail")).toBe(doc);
  });

  test("matches a replayed shorter snapshot of an already-complete doc", () => {
    const doc = { source_file: "inline://u/1785599268092", source: "inline_extract", content: base + "\n\ntail" };
    expect(findSameInlineDoc([doc], "inline://u/1785605328380", base)).toBe(doc);
  });

  test("does not prefix-match docs that are not inline extracts", () => {
    const fileDoc = { source_file: "/repo/notes.md", source: "file_sync", content: base };
    expect(findSameInlineDoc([fileDoc], "inline://u/1", base + "extended")).toBeUndefined();
  });

  test("does not match unrelated content", () => {
    const doc = { source_file: "inline://u/1", source: "inline_extract", content: base };
    expect(findSameInlineDoc([doc], "inline://u/2", "# Different doc\n\n" + "y".repeat(6000))).toBeUndefined();
  });
});

describe("classifyDocContent", () => {
  test("keeps the richer patterns from the backfill variant", () => {
    expect(classifyDocContent("here is what's happening with the bug")).toBe("investigation");
    expect(classifyDocContent("picking up from the last session")).toBe("handoff");
    expect(classifyDocContent("## phases\n1. do it")).toBe("plan");
  });
});
