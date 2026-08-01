import { describe, expect, test } from "bun:test";
import {
  classifyDocContent,
  extractTitleFromContent,
  inlineDocSnapshotRelation,
  inlineDocSourceKey,
  shouldUseInlineDocSnapshotFallback,
} from "./docExtraction";

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
    const a = inlineDocSourceKey("user1", 1780722790076, "msg-1");
    const b = inlineDocSourceKey("user1", 1780722799999, "msg-1");
    expect(a).toBe(b);
    expect(a).toBe("inline://user1/uuid/msg-1");
  });

  test("is user-scoped, not conversation-scoped — forks of the same transcript share keys", () => {
    // The same message re-synced into two forked conversations must produce
    // the same key; conversation identity must not appear in it.
    const inForkA = inlineDocSourceKey("user1", 1780722790076, "msg-1");
    const inForkB = inlineDocSourceKey("user1", 1780722799999, "msg-1");
    expect(inForkA).toBe(inForkB);
    expect(inForkA.includes("conv")).toBe(false);
  });

  test("missing timestamp degrades to a stable 0 key", () => {
    expect(inlineDocSourceKey("user1", undefined)).toBe("inline://user1/0");
  });

  test("escapes message ids used in source paths", () => {
    expect(inlineDocSourceKey("user1", 1, "agent/message 1")).toBe(
      "inline://user1/uuid/agent%2Fmessage%201",
    );
  });
});

describe("inlineDocSnapshotRelation", () => {
  test("recognizes identical and progressively streamed content", () => {
    expect(inlineDocSnapshotRelation("abc", "abc")).toBe("same");
    expect(inlineDocSnapshotRelation("abc", "abcdef")).toBe("incoming_longer");
    expect(inlineDocSnapshotRelation("abcdef", "abc")).toBe("existing_longer");
  });

  test("does not merge responses that merely share a title or opening", () => {
    expect(inlineDocSnapshotRelation("abc-one", "abc-two")).toBe("different");
  });
});

describe("shouldUseInlineDocSnapshotFallback", () => {
  test("only permits fuzzy snapshot matching for timestamp-only senders", () => {
    expect(shouldUseInlineDocSnapshotFallback(undefined)).toBe(true);
    expect(shouldUseInlineDocSnapshotFallback("msg-1")).toBe(false);
  });
});

describe("classifyDocContent", () => {
  test("keeps the richer patterns from the backfill variant", () => {
    expect(classifyDocContent("here is what's happening with the bug")).toBe("investigation");
    expect(classifyDocContent("picking up from the last session")).toBe("handoff");
    expect(classifyDocContent("## phases\n1. do it")).toBe("plan");
  });
});
