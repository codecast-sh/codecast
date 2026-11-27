// Session blame's model: hunks placed on the document, carried through edits
// (vim's dd, o, J, typing inside a line, Enter mid-line), the runs the gutter
// draws, and the labels on them.
import { describe, expect, test } from "bun:test";
import { EditorState, type TransactionSpec } from "@codemirror/state";
import type { CodeBlameHunk } from "@codecast/shared/contracts";
import {
  NEUTRAL_HUE,
  SESSION_BLAME_HUES,
  UNCOMMITTED_LABEL,
  blameRuns,
  hueOf,
  inlineText,
  mapHunks,
  originAt,
  placeHunks,
  runAtLine,
  runLabel,
  sessionHues,
  touchedSpans,
  updateEdits,
  type LineSpan,
  type PlacedHunk,
} from "../model";

const A: CodeBlameHunk = { start: 1, end: 2, sha: "a".repeat(40), author: "Ada", summary: "first", time: 1_000, session: { id: "jx7aaaa", conversation_id: "conv-a", title: "Fix the auth race" } };
const B: CodeBlameHunk = { start: 3, end: 3, sha: "b".repeat(40), author: "Lin", summary: "second", time: 2_000 };
const C: CodeBlameHunk = { start: 4, end: 5, uncommitted: true, time: 3_000 };

const TEXT = "one\ntwo\nthree\nfour\nfive\n";

/** Apply edits to a blamed document and return what the gutter would draw. */
function edit(text: string, hunks: CodeBlameHunk[], ...specs: ((s: EditorState) => TransactionSpec)[]) {
  let state = EditorState.create({ doc: text });
  let placed: PlacedHunk[] = placeHunks(hunks, state.doc);
  let edits: LineSpan[] = [];
  for (const spec of specs) {
    const tr = state.update(spec(state));
    placed = mapHunks(placed, tr.changes);
    edits = updateEdits(edits, tr.changes, tr.startState.doc, tr.state.doc);
    state = tr.state;
  }
  const runs = blameRuns(placed, edits, state.doc);
  return { state, placed, edits, runs, view: runs.map((r) => [r.fromLine, r.toLine, r.kind, r.hunk?.start ?? null]) };
}

const lineStart = (s: EditorState, n: number) => s.doc.line(n).from;

describe("placing", () => {
  test("hunks become runs over the lines git named; the trailing empty line has none", () => {
    expect(edit(TEXT, [A, B, C]).view).toEqual([
      [1, 2, "session", 1],
      [3, 3, "commit", 3],
      [4, 5, "uncommitted", 4],
    ]);
  });

  test("hunks past the end of a shorter document are dropped or cut", () => {
    expect(edit("one\ntwo\nthree", [A, B, { ...C, start: 3, end: 9 }, { ...C, start: 7, end: 8 }]).view).toEqual([
      [1, 2, "session", 1],
      [3, 3, "uncommitted", 3],
    ]);
  });
});

describe("hunks through edits", () => {
  test("typing inside a line marks that line uncommitted and moves nothing", () => {
    expect(edit(TEXT, [A, B, C], (s) => ({ changes: { from: lineStart(s, 2) + 1, insert: "X" } })).view).toEqual([
      [1, 1, "session", 1],
      [2, 2, "edited", null],
      [3, 3, "commit", 3],
      [4, 5, "uncommitted", 4],
    ]);
  });

  test("dd removes a line without touching its neighbours", () => {
    expect(edit(TEXT, [A, B, C], (s) => ({ changes: { from: lineStart(s, 2), to: lineStart(s, 3) } })).view).toEqual([
      [1, 1, "session", 1],
      [2, 2, "commit", 3],
      [3, 4, "uncommitted", 4],
    ]);
  });

  test("deleting a whole hunk drops it", () => {
    expect(edit(TEXT, [A, B, C], (s) => ({ changes: { from: lineStart(s, 3), to: lineStart(s, 4) } })).view).toEqual([
      [1, 2, "session", 1],
      [3, 4, "uncommitted", 4],
    ]);
  });

  test("o (a new line below) touches only the new line, and the hunks below shift", () => {
    const r = edit(TEXT, [A, B, C], (s) => ({ changes: { from: s.doc.line(1).to, insert: "\n  new" } }));
    expect(r.view).toEqual([
      [1, 1, "session", 1],
      [2, 2, "edited", null],
      [3, 3, "session", 1],
      [4, 4, "commit", 3],
      [5, 6, "uncommitted", 4],
    ]);
  });

  test("O (a new line above) touches only the new line", () => {
    expect(edit(TEXT, [A, B, C], (s) => ({ changes: { from: lineStart(s, 3), insert: "new\n" } })).view).toEqual([
      [1, 2, "session", 1],
      [3, 3, "edited", null],
      [4, 4, "commit", 3],
      [5, 6, "uncommitted", 4],
    ]);
  });

  test("Enter mid-line touches both halves", () => {
    expect(edit(TEXT, [A, B, C], (s) => ({ changes: { from: lineStart(s, 3) + 2, insert: "\n" } })).view).toEqual([
      [1, 2, "session", 1],
      [3, 4, "edited", null],
      [5, 6, "uncommitted", 4],
    ]);
  });

  test("J (join) touches the joined line; the next hunk keeps its lines", () => {
    const r = edit(TEXT, [A, B, C], (s) => ({ changes: { from: s.doc.line(2).to, to: lineStart(s, 3), insert: " " } }));
    expect(r.state.doc.line(2).text).toBe("two three");
    expect(r.view).toEqual([
      [1, 1, "session", 1],
      [2, 2, "edited", null],
      [3, 4, "uncommitted", 4],
    ]);
  });

  test("edits accumulate and follow later edits above them", () => {
    const r = edit(
      TEXT,
      [A, B, C],
      (s) => ({ changes: { from: lineStart(s, 4), insert: "x" } }),
      (s) => ({ changes: { from: lineStart(s, 1), insert: "zero\n" } }),
      (s) => ({ changes: { from: lineStart(s, 2), to: lineStart(s, 3) } }),
    );
    expect(r.state.doc.toString()).toBe("zero\ntwo\nthree\nxfour\nfive\n");
    expect(r.view).toEqual([
      [1, 1, "edited", null],
      [2, 2, "session", 1],
      [3, 3, "commit", 3],
      [4, 4, "edited", null],
      [5, 5, "uncommitted", 4],
    ]);
  });

  test("undoing to the same text keeps the touched line uncommitted until the next fetch", () => {
    const r = edit(
      TEXT,
      [A, B, C],
      (s) => ({ changes: { from: lineStart(s, 3), insert: "x" } }),
      (s) => ({ changes: { from: lineStart(s, 3), to: lineStart(s, 3) + 1 } }),
    );
    expect(r.view[1]).toEqual([3, 3, "edited", null]);
  });

  test("a deleted edited line takes its mark with it", () => {
    const r = edit(
      TEXT,
      [A, B, C],
      (s) => ({ changes: { from: lineStart(s, 2), insert: "x" } }),
      (s) => ({ changes: { from: lineStart(s, 2), to: lineStart(s, 3) } }),
    );
    expect(r.view).toEqual([
      [1, 1, "session", 1],
      [2, 2, "commit", 3],
      [3, 4, "uncommitted", 4],
    ]);
  });
});

describe("touched lines", () => {
  test("a pure line deletion and a pure line insertion at a line start", () => {
    const s = EditorState.create({ doc: TEXT });
    const del = s.update({ changes: { from: lineStart(s, 2), to: lineStart(s, 4) } });
    expect(touchedSpans(del.changes, s.doc, del.state.doc)).toEqual([]);
    const ins = s.update({ changes: { from: lineStart(s, 2), insert: "a\nb\n" } });
    const spans = touchedSpans(ins.changes, s.doc, ins.state.doc);
    expect(spans.map((x) => ins.state.doc.sliceString(x.from, x.to))).toEqual(["a\nb\n"]);
  });
});

describe("lookups", () => {
  test("runAtLine and originAt agree", () => {
    const r = edit(TEXT, [A, B, C], (s) => ({ changes: { from: lineStart(s, 3), insert: "x" } }));
    expect(runAtLine(r.runs, 2)?.hunk).toBe(A);
    expect(runAtLine(r.runs, 3)?.kind).toBe("edited");
    expect(runAtLine(r.runs, 6)).toBeNull();
    expect(originAt(r.placed, r.edits, lineStart(r.state, 2))?.hunk).toBe(A);
    expect(originAt(r.placed, r.edits, lineStart(r.state, 3))?.kind).toBe("edited");
    expect(originAt(r.placed, r.edits, lineStart(r.state, 5))?.hunk).toBe(C);
  });
});

describe("labels", () => {
  const now = 3 * 3_600_000 + 60_000;
  test("a session's title, a commit's author, uncommitted lines, and the age", () => {
    expect(runLabel("session", A, now)).toEqual({ name: "Fix the auth race", age: "3h" });
    expect(runLabel("commit", B, now)).toEqual({ name: "Lin", age: "3h" });
    expect(runLabel("uncommitted", C, now)).toEqual({ name: UNCOMMITTED_LABEL, age: "3h" });
    expect(runLabel("edited", null, now)).toEqual({ name: UNCOMMITTED_LABEL, age: "now" });
  });

  test("fallbacks: an untitled session, a commit with no author, no time", () => {
    expect(runLabel("session", { ...A, session: { id: "jx7bbbb" }, time: undefined }, now)).toEqual({ name: "Session jx7bbbb", age: "" });
    expect(runLabel("commit", { ...B, author: "" }, now).name).toBe("bbbbbbb");
    // A clock behind the commit never shows a negative age.
    expect(runLabel("commit", { ...B, time: now + 60_000 }, now).age).toBe("now");
  });

  test("an uncommitted line a session wrote is labelled with the session", () => {
    expect(runLabel("uncommitted", { ...C, session: A.session }, now).name).toBe("Fix the auth race");
  });

  test("inline text", () => {
    expect(inlineText("session", A, now)).toBe("Fix the auth race, 3h ago");
    expect(inlineText("commit", B, now)).toBe("Lin, 3h ago · second");
    expect(inlineText("edited", null, now)).toBe(UNCOMMITTED_LABEL);
  });

  test("colors rank sessions by lines written; lines without one are neutral", () => {
    const big = { ...B, start: 6, end: 20, session: { id: "jx7cccc", conversation_id: "conv-c", title: "Big" } };
    const hues = sessionHues([A, B, C, big]);
    expect(hueOf(big, hues)).toBe(SESSION_BLAME_HUES[0]);
    expect(hueOf(A, hues)).toBe(SESSION_BLAME_HUES[1]);
    expect(hueOf(B, hues)).toBe(NEUTRAL_HUE);
    expect(hueOf(null, hues)).toBe(NEUTRAL_HUE);
  });
});

describe("label grouping", () => {
  test("back-to-back runs of one session or one author share the first label", async () => {
    const { buildMarkers } = await import("../gutter");
    const doc = EditorState.create({ doc: "a\nb\nc\nd\ne\nf\n" }).doc;
    const A2: CodeBlameHunk = { ...A, start: 3, end: 3, sha: "c".repeat(40), summary: "again" };
    const L1: CodeBlameHunk = { start: 4, end: 4, sha: "d".repeat(40), author: "Lin", time: 1 };
    const L2: CodeBlameHunk = { start: 5, end: 5, sha: "e".repeat(40), author: "Lin", time: 2 };
    const M: CodeBlameHunk = { start: 6, end: 6, sha: "f".repeat(40), author: "Max", time: 3 };
    const hunks = [A, A2, L1, L2, M];
    const runs = blameRuns(placeHunks(hunks, doc), [], doc);
    expect(runs.length).toBe(5);
    const labels: (string | null)[] = [];
    buildMarkers(runs, sessionHues(hunks), doc, 10_000).between(0, doc.length, (_f, _t, m) => {
      labels.push((m as unknown as { label: { name: string } | null }).label?.name ?? null);
    });
    expect(labels).toEqual(["Fix the auth race", null, null, "Lin", null, "Max"]);
  });
});

describe("cache", () => {
  test("an answer that may still gain sessions is provisional", async () => {
    const { isProvisional } = await import("../data");
    expect(isProvisional({ path: "x", hunks: [A, B] })).toBe(false);
    expect(isProvisional({ path: "x", hunks: [A, C] })).toBe(true);
    expect(isProvisional({ path: "x", hunks: [B] })).toBe(true);
  });
});
