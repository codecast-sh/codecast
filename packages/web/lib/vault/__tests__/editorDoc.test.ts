// Source mode's contract is byte fidelity: the editor is a view over the file's
// exact bytes, and a note that is opened and saved unedited must write back what
// it read. These run the real CodeMirror document, which is where that promise
// either holds or quietly doesn't (line-ending normalization is the classic way
// an editor breaks it).

import { test, expect, describe } from "bun:test";
import { EditorState } from "@codemirror/state";
import { detectLineSeparator, docChange } from "../editorDoc";

const SAMPLE = [
  "---",
  "title: Round Trip",
  "tags: [a, b]",
  "---",
  "",
  "# Heading",
  "",
  "Body with a [[Wiki Link]] and a #tag.  ",
  "",
  "```js",
  "const x = 1;",
  "```",
  "",
  "- [ ] a task",
  "",
].join("\n");

describe("round trip", () => {
  test("frontmatter, trailing spaces and the final newline survive unedited", () => {
    const state = EditorState.create({ doc: SAMPLE });
    expect(state.doc.toString()).toBe(SAMPLE);
  });

  test("CRLF content survives when the separator is carried through both ends", () => {
    const crlf = "---\r\ntitle: x\r\n---\r\n\r\nbody\r\n";
    const sep = detectLineSeparator(crlf);
    expect(sep).toBe("\r\n");
    const doc = EditorState.create({ doc: crlf, extensions: EditorState.lineSeparator.of(sep) }).doc;
    // The naive serialization is exactly the trap: CodeMirror always joins with
    // "\n", so toString() silently rewrites every line ending in the file.
    expect(doc.toString()).not.toBe(crlf);
    expect(doc.sliceString(0, doc.length, sep)).toBe(crlf);
  });

  test("LF files, and files with no line breaks at all, stay LF", () => {
    expect(detectLineSeparator(SAMPLE)).toBe("\n");
    expect(detectLineSeparator("one line")).toBe("\n");
    expect(detectLineSeparator("a\r\nb\nc\n")).toBe("\n");
  });

  test("an empty note stays empty", () => {
    expect(EditorState.create({ doc: "" }).doc.toString()).toBe("");
  });
});

describe("docChange", () => {
  const apply = (from: string, to: string) => {
    const change = docChange(from, to);
    if (!change) return from;
    return EditorState.create({ doc: from }).update({ changes: change }).state.doc.toString();
  };

  test("identical documents produce no change at all", () => {
    expect(docChange(SAMPLE, SAMPLE)).toBeNull();
  });

  test("touches only the span that differs", () => {
    const edited = SAMPLE.replace("# Heading", "# Other");
    const change = docChange(SAMPLE, edited)!;
    expect(SAMPLE.slice(change.from, change.to)).toBe("Heading");
    expect(change.insert).toBe("Other");
  });

  test("applying it reproduces the target exactly", () => {
    const cases: [string, string][] = [
      [SAMPLE, SAMPLE.replace("a task", "another task")],
      [SAMPLE, `${SAMPLE}appended\n`],
      [SAMPLE, SAMPLE.slice(20)],
      ["aaa", "aaaa"],
      ["aaaa", "aaa"],
      ["", "hello"],
      ["hello", ""],
      ["abc", "xyz"],
    ];
    for (const [from, to] of cases) expect(apply(from, to)).toBe(to);
  });

  test("a repeated run does not let the prefix and suffix overlap", () => {
    const change = docChange("aaa", "aaaa")!;
    expect(change.to).toBeGreaterThanOrEqual(change.from);
    expect(change.from + change.insert.length - (change.to - change.from)).toBeLessThanOrEqual(4);
  });
});
