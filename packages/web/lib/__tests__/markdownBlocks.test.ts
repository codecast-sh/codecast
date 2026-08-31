import { describe, expect, it } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { splitMarkdownBlocks } from "../markdownBlocks";

// Regression for a stack overflow in ConversationView's block-split render
// path: a giant assistant body with no blank lines outside fences splits
// into ONE block equal to the input, and the renderer recursed on it with
// the identical string forever (RangeError: Maximum call stack size
// exceeded). The contract is now: callers recurse only when the split made
// progress, which requires every block to be strictly shorter than the
// input whenever there is more than one.

describe("splitMarkdownBlocks", () => {
  it("returns a giant single fence as one block equal to the input", () => {
    const body = "```\n" + "line of output with no blank lines\n".repeat(400) + "```";
    expect(body.length).toBeGreaterThan(8000);
    const blocks = splitMarkdownBlocks(body);
    expect(blocks).toEqual([body]);
  });

  it("returns a giant no-blank-line paste as one block equal to the input", () => {
    const body = "at renderMessageMarkdownCached (ConversationView.tsx:341)\n".repeat(300).trimEnd();
    const blocks = splitMarkdownBlocks(body);
    expect(blocks).toEqual([body]);
  });

  it("every block is strictly shorter than the input when the split makes progress", () => {
    const body = ["# a", "", "para one", "", "```", "", "blank inside fence stays", "", "```", "", "tail"].join("\n");
    const blocks = splitMarkdownBlocks(body);
    expect(blocks.length).toBeGreaterThan(1);
    for (const b of blocks) expect(b.length).toBeLessThan(body.length);
  });

  it("does not split on blank lines inside a fence", () => {
    const body = "```\ncode\n\nmore code\n```";
    expect(splitMarkdownBlocks(body)).toEqual([body]);
  });

  it("splits paragraphs at blank lines", () => {
    expect(splitMarkdownBlocks("one\n\ntwo\n\nthree")).toEqual(["one", "two", "three"]);
  });

  // The teeth: the renderer must only recurse when the split made progress.
  // Without this gate a single-block result re-enters with the same string
  // and overflows the stack, so losing the gate reintroduces the crash.
  it("ConversationView gates block recursion on the split making progress", () => {
    const src = readFileSync(join(import.meta.dir, "..", "..", "components", "ConversationView.tsx"), "utf-8");
    const idx = src.indexOf("splitMarkdownBlocks(content)");
    expect(idx).toBeGreaterThan(-1);
    expect(src.slice(idx, idx + 500)).toContain("blocks.length > 1");
  });
});
