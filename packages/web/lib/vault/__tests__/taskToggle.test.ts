// Checkbox clicks in the reading view rewrite the note on disk. These pin the
// two things that make that safe: the click lands on the line the user meant
// (frontmatter offset), and nothing but the one bracket character changes.

import { test, expect, describe } from "bun:test";
import { toggleTaskInContent } from "../taskToggle";
import { frontmatterLineOffset, splitFrontmatter } from "../frontmatter";

const NOTE = [
  "---",
  "title: Plans",
  "---",
  "# Heading",
  "",
  "- [ ] open one",
  "- [x] done one",
  "  * [ ] nested",
  "1. [ ] ordered",
  "- not a task",
].join("\n");

describe("toggleTaskInContent", () => {
  test("checks an open task and leaves every other byte alone", () => {
    const next = toggleTaskInContent(NOTE, 6, true)!;
    expect(next.split("\n")[5]).toBe("- [x] open one");
    const before = NOTE.split("\n");
    next.split("\n").forEach((line, i) => {
      if (i !== 5) expect(line).toBe(before[i]);
    });
  });

  test("unchecks a done task", () => {
    expect(toggleTaskInContent(NOTE, 7, false)!.split("\n")[6]).toBe("- [ ] done one");
  });

  test("flips when no target state is given", () => {
    expect(toggleTaskInContent(NOTE, 6)!.split("\n")[5]).toBe("- [x] open one");
    expect(toggleTaskInContent(NOTE, 7)!.split("\n")[6]).toBe("- [ ] done one");
  });

  test("keeps indentation and the list marker", () => {
    expect(toggleTaskInContent(NOTE, 8, true)!.split("\n")[7]).toBe("  * [x] nested");
    expect(toggleTaskInContent(NOTE, 9, true)!.split("\n")[8]).toBe("1. [x] ordered");
  });

  test("preserves CRLF line endings", () => {
    const crlf = "- [ ] a\r\n- [ ] b\r\n";
    expect(toggleTaskInContent(crlf, 1, true)).toBe("- [x] a\r\n- [ ] b\r\n");
  });

  test("writes nothing when the line is not a task, is off the end, or already matches", () => {
    expect(toggleTaskInContent(NOTE, 10, true)).toBeNull();
    expect(toggleTaskInContent(NOTE, 4, true)).toBeNull();
    expect(toggleTaskInContent(NOTE, 99, true)).toBeNull();
    expect(toggleTaskInContent(NOTE, 6, false)).toBeNull();
  });

  test("a custom state character reads as open and checks to x", () => {
    expect(toggleTaskInContent("- [/] doing", 1, true)).toBe("- [x] doing");
  });
});

describe("frontmatterLineOffset", () => {
  test("body line N is file line N + offset", () => {
    const offset = frontmatterLineOffset(NOTE);
    const [, body] = splitFrontmatter(NOTE);
    // "- [ ] open one" is body line 3 and file line 6.
    expect(body.split("\n")[2]).toBe("- [ ] open one");
    expect(3 + offset).toBe(6);
  });

  test("an empty frontmatter block still counts its two fences", () => {
    const note = "---\n---\nbody";
    expect(frontmatterLineOffset(note)).toBe(2);
    expect(splitFrontmatter(note)).toEqual(["", "body"]);
  });

  test("no frontmatter means no offset", () => {
    expect(frontmatterLineOffset("# Just a note\n")).toBe(0);
    expect(frontmatterLineOffset("---")).toBe(0);
  });

  test("an unterminated block is body, not frontmatter", () => {
    expect(frontmatterLineOffset("---\ntitle: x\nstill body")).toBe(0);
  });
});
