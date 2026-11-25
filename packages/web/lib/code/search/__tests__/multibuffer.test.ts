import { describe, expect, test } from "bun:test";
import { EditorState, Text } from "@codemirror/state";
import { history, undo } from "@codemirror/commands";
import { applyEdits } from "../replace";
import { changedExcerpts, excerptRanges, layoutMultibuffer, sourceEdits, sourceLineAt, type ExcerptSource } from "../excerpts";
import { locationAt, multibufferCore, regionsField } from "../multibuffer";

const file = (n: number, prefix = "l") => Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`).join("\n");

const A: ExcerptSource = { path: "src/a.ts", text: file(20, "a"), lines: [3, 15] };
const B: ExcerptSource = { path: "b.ts", text: file(4, "b"), lines: [1, 2] };

function setup(sources = [A, B], context = 2) {
  const layout = layoutMultibuffer(sources, context);
  const state = EditorState.create({ doc: layout.doc, extensions: [multibufferCore(layout), history()] });
  return { layout, state };
}

const lineStart = (s: EditorState, n: number) => s.doc.line(n).from;
const lineEnd = (s: EditorState, n: number) => s.doc.line(n).to;

/** What each file would hold after a save, from the document as it stands. */
function saved(state: EditorState, sources: ExcerptSource[]): Record<string, string> {
  const regions = state.field(regionsField);
  const out: Record<string, string> = {};
  const paths = layoutMultibuffer(sources).paths;
  for (const [f, changes] of changedExcerpts(regions, state.doc)) {
    const src = sources.find((s) => s.path === paths[f])!;
    const edits = sourceEdits(src.text, changes);
    if (!Array.isArray(edits)) throw new Error(edits.refuse);
    out[src.path] = applyEdits(src.text, edits);
  }
  return out;
}

describe("layout", () => {
  test("ranges take context and merge where they touch", () => {
    expect(excerptRanges([3, 15], 20, 2)).toEqual([
      [1, 5],
      [13, 17],
    ]);
    expect(excerptRanges([3, 8], 20, 2)).toEqual([[1, 10]]); // 5 and 6 touch
    expect(excerptRanges([3, 9], 20, 2)).toEqual([
      [1, 5],
      [7, 11],
    ]);
    expect(excerptRanges([20, 20, 99], 20, 2)).toEqual([[18, 20]]);
  });

  test("headers, excerpts and gaps", () => {
    const { layout } = setup();
    expect(layout.doc.split("\n")).toEqual([
      "src/a.ts",
      "a1", "a2", "a3", "a4", "a5",
      "⋯",
      "a13", "a14", "a15", "a16", "a17",
      "b.ts",
      "b1", "b2", "b3", "b4",
    ]);
    expect(layout.regions.map((r) => r.kind)).toEqual(["header", "excerpt", "gap", "excerpt", "header", "excerpt"]);
  });

  test("line numbers and locations follow the file", () => {
    const { state } = setup();
    const regions = state.field(regionsField);
    expect(sourceLineAt(regions, state.doc, lineStart(state, 9))).toEqual({ file: 0, line: 14 });
    expect(sourceLineAt(regions, state.doc, lineStart(state, 1))).toBeNull();
    expect(locationAt(state, lineStart(state, 9) + 1)).toEqual({ path: "src/a.ts", line: 14, column: 2 });
    expect(locationAt(state, lineStart(state, 13))).toEqual({ path: "b.ts", line: 1, column: 1 }); // header: its first excerpt
  });
});

describe("the guard", () => {
  test("typing inside an excerpt passes and maps back", () => {
    let { state } = setup();
    state = state.update({ changes: { from: lineEnd(state, 4), insert: "!" } }).state; // a3
    expect(saved(state, [A, B])).toEqual({ "src/a.ts": A.text.replace("a3", "a3!") });
  });

  test("a header and a gap cannot be edited", () => {
    let { state } = setup();
    const before = state.doc.toString();
    state = state.update({ changes: { from: 2, insert: "x" } }).state;
    state = state.update({ changes: { from: lineStart(state, 7), to: lineEnd(state, 7) } }).state;
    expect(state.doc.toString()).toBe(before);
  });

  test("typing at both edges of an excerpt stays in it", () => {
    let { state } = setup();
    state = state.update({ changes: { from: lineStart(state, 2), insert: "<" } }).state; // start of a1
    state = state.update({ changes: { from: lineEnd(state, 6), insert: ">" } }).state; // end of a5
    expect(saved(state, [A, B])["src/a.ts"].split("\n").slice(0, 5)).toEqual(["<a1", "a2", "a3", "a4", "a5>"]);
  });

  test("new lines at the edges (vim o and O) join the excerpt and shift later ones", () => {
    let { state } = setup();
    state = state.update({ changes: { from: lineEnd(state, 6), insert: "\nnew-after-a5" } }).state;
    state = state.update({ changes: { from: lineStart(state, 2), insert: "new-before-a1\n" } }).state;
    const regions = state.field(regionsField);
    // a13 is now line 10 of the document and still line 13 of the file.
    expect(sourceLineAt(regions, state.doc, lineStart(state, 10))).toEqual({ file: 0, line: 13 });
    const out = saved(state, [A, B])["src/a.ts"].split("\n");
    expect(out.slice(0, 7)).toEqual(["new-before-a1", "a1", "a2", "a3", "a4", "a5", "new-after-a5"]);
    expect(out.length).toBe(22);
  });

  test("deleting a line inside (vim dd) removes it from the file", () => {
    let { state } = setup();
    state = state.update({ changes: { from: lineEnd(state, 2), to: lineEnd(state, 3) } }).state; // a2
    expect(saved(state, [A, B])["src/a.ts"].split("\n").slice(0, 3)).toEqual(["a1", "a3", "a4"]);
  });

  test("a delete across files is cut to the excerpts and keeps every header", () => {
    let { state } = setup();
    // From the middle of a16 to the middle of b2: crosses a17, the b.ts header, b1.
    const from = lineStart(state, 11) + 1;
    const to = lineStart(state, 15) + 1;
    state = state.update({ changes: { from, to } }).state;
    const lines = state.doc.toString().split("\n");
    expect(lines).toContain("b.ts");
    const out = saved(state, [A, B]);
    // a.ts loses the end of a16 and all of a17; b.ts loses b1 and the start of b2.
    expect(out["src/a.ts"].split("\n").slice(12, 17)).toEqual(["a13", "a14", "a15", "a", "a18"]);
    expect(out["b.ts"]).toBe("2\nb3\nb4");
  });

  test("a replacement that starts in an excerpt keeps its text there only", () => {
    let { state } = setup();
    state = state.update({ changes: { from: lineStart(state, 17), to: state.doc.length, insert: "X" } }).state; // b4 to end
    expect(saved(state, [A, B])["b.ts"]).toBe("b1\nb2\nb3\nX");
  });

  test("undo goes back through the guard and leaves nothing to save", () => {
    let { state } = setup();
    state = state.update({ changes: { from: lineEnd(state, 4), insert: "!" } }).state;
    let undone = state;
    undo({ state, dispatch: (tr) => (undone = tr.state) });
    expect(changedExcerpts(undone.field(regionsField), undone.doc).size).toBe(0);
  });
});

describe("source edits", () => {
  test("a CRLF file keeps CRLF, new lines included", () => {
    const src: ExcerptSource = { path: "w.txt", text: "one\r\ntwo\r\nthree\r\n", lines: [2] };
    let { state } = setup([src], 0);
    state = state.update({ changes: { from: state.doc.line(2).to, insert: "\ntwo-and-a-half" } }).state;
    expect(saved(state, [src])["w.txt"]).toBe("one\r\ntwo\r\ntwo-and-a-half\r\nthree\r\n");
  });

  test("a file that changed under an excerpt is refused", () => {
    let { state } = setup();
    state = state.update({ changes: { from: lineEnd(state, 4), insert: "!" } }).state;
    const changes = changedExcerpts(state.field(regionsField), state.doc).get(0)!;
    expect(sourceEdits(A.text.replace("a2", "A2"), changes)).toEqual({ refuse: "Line 2 changed on disk" });
    expect(sourceEdits("a1\na2", changes)).toEqual({ refuse: "Lines 1-5 are gone" });
  });

  test("two excerpts of one file apply against the same snapshot", () => {
    let { state } = setup();
    state = state.update({ changes: [{ from: lineEnd(state, 3), insert: "\nX\nY" }] }).state; // after a2
    state = state.update({ changes: [{ from: lineStart(state, 12), to: lineEnd(state, 12), insert: "A15" }] }).state; // a15
    const out = saved(state, [A, B])["src/a.ts"].split("\n");
    expect(out.slice(0, 4)).toEqual(["a1", "a2", "X", "Y"]);
    expect(out[16]).toBe("A15");
  });

  test("a file with mixed endings keeps each line's own separator", () => {
    const src: ExcerptSource = { path: "m.txt", text: "a\r\nb\nc\r\nd\r\n", lines: [2] };
    let { state } = setup([src], 1);
    // Excerpt is lines 1-3 (a, b, c): edit only "b".
    state = state.update({ changes: { from: state.doc.line(3).from, to: state.doc.line(3).to, insert: "B" } }).state;
    expect(saved(state, [src])["m.txt"]).toBe("a\r\nB\nc\r\nd\r\n");
    // A new line past the original count takes the dominant separator.
    state = state.update({ changes: { from: state.doc.line(4).to, insert: "\nc2" } }).state;
    expect(saved(state, [src])["m.txt"]).toBe("a\r\nB\nc\r\nc2\r\nd\r\n");
  });

  test("a final newline adds no empty line to the last excerpt", () => {
    const layout = layoutMultibuffer([{ path: "t.ts", text: "x\nneedle\n", lines: [2] }], 2);
    expect(layout.doc).toBe("t.ts\nx\nneedle");
    const crlf = layoutMultibuffer([{ path: "c.txt", text: "needle\r\n", lines: [1] }], 2);
    expect(crlf.doc).toBe("c.txt\nneedle");
  });

  test("an excerpt's text maps back exactly, Text and all", () => {
    const { state } = setup();
    expect(changedExcerpts(state.field(regionsField), Text.of(state.doc.toString().split("\n"))).size).toBe(0);
  });
});
