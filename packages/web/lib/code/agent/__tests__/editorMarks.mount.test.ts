// Agent edit marks as CodeMirror state: an external change is marked in the
// writer's color, marks map through later typing, moving the cursor into one
// dismisses it, ]a / [a visit them without dismissing, and the Cmd-K "sent"
// marker ends when the file changes under it.
import { installEditorDom } from "../../../../components/code/__tests__/editorDom";

installEditorDom();

const { afterAll, describe, expect, it } = await import("bun:test");
const { EditorSelection, EditorState } = await import("@codemirror/state");
const { EditorView } = await import("@codemirror/view");
const { featureBase } = await import("../../features");
const { externalChange } = await import("../../fileSync");
const marks = await import("../editorMarks");
const { addSentMark, agentMarks, agentMarksExtension, clearSentMarks, dismissAgentEdits, dropFlashes, setAgentMarkHooks, stepAgentEdit } = marks;

const writers: Record<string, string | null> = { "src/a.ts": "s1" };
const restore = setAgentMarkHooks({
  writerOf: (_vault, path) => writers[path] ?? null,
  colorOf: (id) => (id ? `c-${id}` : "neutral"),
  labelOf: (id) => id ?? "unknown",
});
afterAll(() => restore());

const ctx = (path = "src/a.ts") => ({ vaultId: "v", path, languageId: "typescript", languageName: "TypeScript", sizeBytes: 1, largeFile: false });
const DOC = ["one", "two", "three", "four", "five", "six", "seven"].join("\n");

function mount(doc = DOC, path = "src/a.ts") {
  const parent = document.createElement("div");
  document.body.append(parent);
  return new EditorView({ parent, state: EditorState.create({ doc, extensions: [featureBase(ctx(path)), agentMarksExtension()] }) });
}

/** Disk text adopted into the buffer, as fileSync does. */
function adopt(view: InstanceType<typeof EditorView>, from: number, to: number, insert: string) {
  view.dispatch({ changes: { from, to, insert }, annotations: externalChange.of({ etag: "e2" }) });
}

const lineOf = (view: InstanceType<typeof EditorView>, pos: number) => view.state.doc.lineAt(pos).number;
const editLines = (view: InstanceType<typeof EditorView>) => agentMarks(view.state).edits.map((e) => [lineOf(view, e.from), lineOf(view, e.to)]);

describe("external changes", () => {
  it("are marked in the color of the session that wrote them, with a fading flash", () => {
    const view = mount();
    const two = view.state.doc.line(2);
    adopt(view, two.from, two.to, "TWO\nTWO-b");
    const st = agentMarks(view.state);
    expect(st.edits).toHaveLength(1);
    expect(st.edits[0]).toMatchObject({ sessionId: "s1", color: "c-s1" });
    expect(editLines(view)).toEqual([[2, 3]]);
    expect(st.flashes[0]).toMatchObject({ kind: "edit", color: "c-s1" });
    expect(view.dom.querySelector(".cm-agentFlash")).not.toBeNull();
    expect(view.dom.querySelector(".cm-agentBar")).not.toBeNull();
    // Flashes drop once faded; the gutter mark stays.
    view.dispatch({ effects: dropFlashes.of(Date.now() + 10_000) });
    expect(agentMarks(view.state).flashes).toEqual([]);
    expect(agentMarks(view.state).edits).toHaveLength(1);
    view.destroy();
  });

  // A disk write diffs as whole lines with their newlines, so the change ends
  // at the next line's start: that unchanged line gets no bar or flash.
  it("a change ending at a line's start marks only the lines it wrote", () => {
    const view = mount();
    adopt(view, view.state.doc.line(2).from, view.state.doc.line(3).from, "TWO\nTWO-b\n");
    const marked = (cls: string) => [...view.dom.querySelectorAll(".cm-line")].map((l, i) => (l.classList.contains(cls) ? i + 1 : 0)).filter(Boolean);
    expect(marked("cm-agentFlash")).toEqual([2, 3]);
    const bars = [...view.dom.querySelectorAll(".cm-agentGutter .cm-gutterElement")].filter((g) => g.querySelector(".cm-agentBar"));
    expect(bars).toHaveLength(2);
    view.destroy();
  });

  it("an unknown writer gets the neutral color and no session", () => {
    const view = mount(DOC, "src/other.ts");
    adopt(view, 0, 3, "ONE");
    expect(agentMarks(view.state).edits[0]).toMatchObject({ sessionId: null, color: "neutral" });
    view.destroy();
  });

  it("the person's own typing is never marked", () => {
    const view = mount();
    view.dispatch({ changes: { from: 0, insert: "x" } });
    expect(agentMarks(view.state).edits).toEqual([]);
    view.destroy();
  });

  it("separate changed runs become separate edits", () => {
    const view = mount();
    const l2 = view.state.doc.line(2);
    const l6 = view.state.doc.line(6);
    view.dispatch({
      changes: [
        { from: l2.from, to: l2.to, insert: "TWO" },
        { from: l6.from, to: l6.to, insert: "SIX" },
      ],
      annotations: externalChange.of({ etag: "e" }),
    });
    expect(editLines(view)).toEqual([
      [2, 2],
      [6, 6],
    ]);
    view.destroy();
  });
});

describe("mapping and dismissal", () => {
  it("marks stay on their text while the person types above them", () => {
    const view = mount();
    const five = view.state.doc.line(5);
    adopt(view, five.from, five.to, "FIVE");
    // Cursor stays on line 1 (outside the edit) while two lines go in above.
    view.dispatch({ changes: { from: 0, insert: "a\nb\n" }, selection: EditorSelection.cursor(0) });
    expect(editLines(view)).toEqual([[7, 7]]);
    expect(view.state.doc.line(7).text).toBe("FIVE");
    view.destroy();
  });

  it("moving the cursor into an edit dismisses it; moving elsewhere does not", () => {
    const view = mount();
    const l4 = view.state.doc.line(4);
    adopt(view, l4.from, l4.to, "FOUR");
    view.dispatch({ selection: EditorSelection.cursor(view.state.doc.line(2).from) });
    expect(agentMarks(view.state).edits).toHaveLength(1);
    view.dispatch({ selection: EditorSelection.cursor(view.state.doc.line(4).from + 1) });
    expect(agentMarks(view.state).edits).toEqual([]);
    view.destroy();
  });

  it("dismiss all clears every edit", () => {
    const view = mount();
    adopt(view, 0, 3, "ONE");
    adopt(view, view.state.doc.line(6).from, view.state.doc.line(6).to, "SIX");
    expect(agentMarks(view.state).edits).toHaveLength(2);
    view.dispatch({ effects: dismissAgentEdits.of("all") });
    expect(agentMarks(view.state).edits).toEqual([]);
    view.destroy();
  });

  it("Escape dismisses all edits", () => {
    const view = mount();
    adopt(view, 0, 3, "ONE");
    view.contentDOM.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(agentMarks(view.state).edits).toEqual([]);
    view.destroy();
  });
});

describe("]a / [a", () => {
  it("step between edits, wrap, and do not dismiss what they visit", () => {
    const view = mount();
    for (const n of [6, 2, 4]) {
      const l = view.state.doc.line(n);
      adopt(view, l.from, l.to, l.text.toUpperCase());
    }
    view.dispatch({ selection: EditorSelection.cursor(0) });
    const at = () => lineOf(view, view.state.selection.main.head);
    expect(stepAgentEdit(view, 1)).toBe(true);
    expect(at()).toBe(2);
    stepAgentEdit(view, 1);
    expect(at()).toBe(4);
    stepAgentEdit(view, 1);
    expect(at()).toBe(6);
    stepAgentEdit(view, 1);
    expect(at()).toBe(2);
    stepAgentEdit(view, -1);
    expect(at()).toBe(6);
    expect(agentMarks(view.state).edits).toHaveLength(3);
    view.destroy();
  });

  it("with no edits they do nothing", () => {
    const view = mount();
    expect(stepAgentEdit(view, 1)).toBe(false);
    view.destroy();
  });
});

describe("sent marker", () => {
  const sent = (view: InstanceType<typeof EditorView>, line: number, key = "c1") => {
    const l = view.state.doc.line(line);
    view.dispatch({ effects: addSentMark.of({ from: l.from, to: l.to, key, sessionId: "s1", color: "c-s1", label: "Fix math" }) });
  };

  it("shows 'sent to <session>' and maps through typing elsewhere", () => {
    const view = mount();
    sent(view, 3);
    expect(view.dom.querySelector(".cm-agentSentNote")?.textContent).toBe("sent to Fix math");
    view.dispatch({ changes: { from: 0, insert: "z\n" } });
    const s = agentMarks(view.state).sent[0];
    expect(view.state.sliceDoc(s.from, s.to)).toBe("three");
    view.destroy();
  });

  it("ends when the file changes on disk, or the person edits the quoted text", () => {
    const view = mount();
    sent(view, 3);
    adopt(view, 0, 3, "ONE");
    expect(agentMarks(view.state).sent).toEqual([]);
    sent(view, 3);
    view.dispatch({ changes: { from: view.state.doc.line(3).from, insert: "x" } });
    expect(agentMarks(view.state).sent).toEqual([]);
    view.destroy();
  });

  it("clears one sent message's marker, leaving another to the same session", () => {
    const view = mount();
    sent(view, 2, "c1");
    sent(view, 5, "c2");
    view.dispatch({ effects: clearSentMarks.of("c1") });
    expect(agentMarks(view.state).sent.map((x) => x.key)).toEqual(["c2"]);
    view.destroy();
  });
});

describe("the agent gutter", () => {
  it("is there only while the buffer has agent edits", async () => {
    const view = mount();
    expect(view.dom.querySelector(".cm-agentGutter")).toBeNull();
    adopt(view, 0, 3, "ONE");
    expect(view.dom.querySelector(".cm-agentGutter")).not.toBeNull();
    view.dispatch({ effects: dismissAgentEdits.of("all") });
    await Promise.resolve();
    expect(view.dom.querySelector(".cm-agentGutter")).toBeNull();
    view.destroy();
  });
});
