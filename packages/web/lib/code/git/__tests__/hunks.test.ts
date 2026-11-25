import { describe, expect, it } from "bun:test";
import { ChangeSet, Text } from "@codemirror/state";
import * as kit from "@codemirror/merge";
import { buildChunks, hunkAtLine, hunkLines, hunkOldText, liveHunks, revertChange, stepHunk, updateChunks, type Hunk } from "../hunks";

const L = (...ls: string[]) => ls.map((l) => `${l}\n`).join("");
const T = (s: string) => Text.of(s.split("\n"));

function hunks(base: string, doc: string): Hunk[] {
  const b = T(doc);
  return liveHunks(buildChunks(kit, T(base), b), null, b.length);
}

function apply(doc: string, spec: { from: number; to?: number; insert?: string }): string {
  return doc.slice(0, spec.from) + (spec.insert ?? "") + doc.slice(spec.to ?? spec.from);
}

describe("chunk mapping", () => {
  it("classifies added, modified and deleted runs of lines", () => {
    const base = L("a", "b", "c", "d", "e");
    const doc = L("a", "B", "c", "new", "d");
    const hs = hunks(base, doc);
    expect(hs.map((h) => h.kind)).toEqual(["modified", "added", "deleted"]);
    const d = T(doc);
    expect(hs.map((h) => hunkLines(h, d))).toEqual([
      { first: 2, last: 2 },
      { first: 4, last: 4 },
      // "e" was removed after the last line: the mark sits on the empty line below it.
      { first: 6, last: 6 },
    ]);
  });

  it("finds no hunks in an unchanged file", () => {
    expect(hunks(L("a", "b"), L("a", "b"))).toEqual([]);
  });

  it("treats an unterminated last line as a line", () => {
    const hs = hunks("a\nb", "a\nX");
    expect(hs).toHaveLength(1);
    expect(hs[0].kind).toBe("modified");
    expect(hunkOldText(hs[0], T("a\nb"))).toBe("b");
  });

  it("updates incrementally to the same hunks a full diff finds", () => {
    const base = T(L(...Array.from({ length: 200 }, (_, i) => `line ${i}`)));
    let docText = base.toString();
    let doc = base;
    let chunks = buildChunks(kit, base, doc);
    for (const edit of [
      { from: doc.line(10).from, insert: "inserted\n" },
      { from: doc.line(50).from, to: doc.line(51).from, insert: "" },
      { from: doc.line(120).from + 2, insert: "XX" },
    ]) {
      const changes = ChangeSet.of([edit], doc.length);
      doc = changes.apply(doc);
      docText = apply(docText, edit);
      chunks = updateChunks(kit, chunks, base, doc, changes);
    }
    expect(doc.toString()).toBe(docText);
    const full = liveHunks(buildChunks(kit, base, doc), null, doc.length);
    const inc = liveHunks(chunks, null, doc.length);
    expect(inc.map((h) => [h.kind, hunkLines(h, doc)])).toEqual(full.map((h) => [h.kind, hunkLines(h, doc)]));
  });

  it("shifts hunks through edits made since the last diff", () => {
    const base = T(L("a", "b", "c"));
    const doc = T(L("a", "B", "c"));
    const chunks = buildChunks(kit, base, doc);
    const pending = ChangeSet.of([{ from: 0, insert: "top\n" }], doc.length);
    const next = pending.apply(doc);
    const [h] = liveHunks(chunks, pending, next.length);
    expect(hunkLines(h, next)).toEqual({ first: 3, last: 3 });
  });
});

describe("navigation", () => {
  const base = L("a", "b", "c", "d", "e", "f", "g");
  const doc = L("a", "B", "c", "d", "E", "f", "g");
  const d = T(doc);
  const hs = hunks(base, doc);

  it("steps forward and back, wrapping at the ends", () => {
    expect(hunkLines(stepHunk(hs, d, 1, 1)!, d).first).toBe(2);
    expect(hunkLines(stepHunk(hs, d, 2, 1)!, d).first).toBe(5);
    expect(hunkLines(stepHunk(hs, d, 6, 1)!, d).first).toBe(2);
    expect(hunkLines(stepHunk(hs, d, 6, -1)!, d).first).toBe(5);
    expect(hunkLines(stepHunk(hs, d, 1, -1)!, d).first).toBe(5);
  });

  it("finds the hunk under a line", () => {
    expect(hunkAtLine(hs, d, 5)?.kind).toBe("modified");
    expect(hunkAtLine(hs, d, 4)).toBeNull();
  });
});

describe("revert", () => {
  const cases: [string, string, string][] = [
    ["modified middle", L("a", "b", "c"), L("a", "X", "Y", "c")],
    ["added lines", L("a", "c"), L("a", "b1", "b2", "c")],
    ["added at end", L("a"), L("a", "b")],
    ["deleted middle", L("a", "b", "c"), L("a", "c")],
    ["deleted at end", L("a", "b"), L("a")],
    ["deleted at start", L("a", "b"), L("b")],
    ["unterminated last line modified", "a\nb", "a\nX"],
    ["unterminated last line deleted", "a\nb", "a\n"],
  ];
  for (const [name, base, doc] of cases) {
    it(`puts the base back: ${name}`, () => {
      const b = T(base);
      let text = doc;
      // Revert from the last hunk up, so earlier positions stay valid.
      for (const h of hunks(base, doc).reverse()) {
        text = apply(text, revertChange(h, b, T(text)) as { from: number; to: number; insert: string });
      }
      expect(text).toBe(base);
    });
  }
});

it("diffs a 5,000-line file well inside a frame budget after an edit", () => {
  const lines = Array.from({ length: 5000 }, (_, i) => `const value${i} = compute(${i}, "text ${i % 17}");`);
  const base = Text.of(lines);
  const edited = lines.slice();
  for (let i = 0; i < 5000; i += 97) edited[i] += " // edited";
  edited.splice(2500, 3);
  edited.splice(100, 0, "added");
  const doc = Text.of(edited);
  let t = performance.now();
  const chunks = buildChunks(kit, base, doc);
  const full = performance.now() - t;
  const changes = ChangeSet.of([{ from: doc.line(3000).from, insert: "x" }], doc.length);
  t = performance.now();
  updateChunks(kit, chunks, base, changes.apply(doc), changes);
  const inc = performance.now() - t;
  console.log(`5k lines: full line diff ${full.toFixed(1)} ms (${chunks.length} hunks), incremental after a keystroke ${inc.toFixed(2)} ms`);
  expect(chunks.length).toBeGreaterThan(50);
  expect(inc).toBeLessThan(16);
});
