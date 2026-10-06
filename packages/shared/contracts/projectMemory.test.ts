import { describe, expect, test } from "bun:test";
import { projectMemoryBlock, REDIRECT_PATTERN, type ProjectMemoryItem } from "./projectMemory";

const item = (over: Partial<ProjectMemoryItem>): ProjectMemoryItem => ({
  id: "x",
  kind: "correction",
  text: "t",
  count: 3,
  sessions: 2,
  first_seen: 0,
  last_seen: 0,
  promoted: true,
  ...over,
});

describe("projectMemoryBlock", () => {
  test("renders promoted rows one line each, ten per kind, and nothing when none", () => {
    expect(projectMemoryBlock([])).toBe("");
    expect(projectMemoryBlock([item({ promoted: false })])).toBe("");
    const items = [
      ...Array.from({ length: 12 }, (_, i) => item({ id: `c${i}`, text: `correction ${i}`, detail: i === 0 ? "stop" : undefined })),
      item({ id: "d1", kind: "decision", text: "Keep history flat", detail: "rebase never merge" }),
    ];
    const block = projectMemoryBlock(items);
    expect(block.startsWith("<project-memory>\nThese are prior corrections and decisions for this project; honor them unless the human says otherwise.")).toBe(true);
    expect(block.endsWith("</project-memory>")).toBe(true);
    expect(block).toContain("- correction 0 (stop)");
    expect(block).toContain("- correction 9");
    expect(block).not.toContain("correction 10");
    expect(block).toContain("Decisions:\n- Keep history flat (rebase never merge)");
  });

  test("the redirect pattern matches the cast-lessons words, case insensitively", () => {
    expect(REDIRECT_PATTERN.test("No, DON'T do that")).toBe(true);
    expect(REDIRECT_PATTERN.test("not like that, revert it")).toBe(true);
    expect(REDIRECT_PATTERN.test("looks good, ship it")).toBe(false);
  });
});
