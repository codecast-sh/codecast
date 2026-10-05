import assert from "node:assert/strict";
import { afterAll, describe, it } from "bun:test";
import { replaceGlobals } from "../../test-helpers/globals";

// The vault's CodeMirror deletes a selection without an input event. Its
// guard tells the undo walk about the edit and answers "is a step left" from
// CodeMirror's own history, so ⌘Z over a cleared note brings the text back
// instead of taking back an unrelated app entry.
const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!doctype html><html><body><div id='host'></div></body></html>", { pretendToBeVisual: true });
const restore = replaceGlobals({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element,
  Node: dom.window.Node,
  MutationObserver: dom.window.MutationObserver,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
  cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
});

const { EditorState } = await import("@codemirror/state");
const { EditorView } = await import("@codemirror/view");
const { history, undo } = await import("@codemirror/commands");
const { codeMirrorUndoGuard } = await import("./codeMirrorUndo");
const { createFieldUndoGuard, richEditorCanStep, richEditorOf } = await import("../../lib/undoWalk");

afterAll(() => {
  dom.window.close();
  restore();
});

describe("codeMirrorUndoGuard", () => {
  it("makes a cleared note's ⌘Z the editor's: the edit is heard and the editor has the step", () => {
    const guard = codeMirrorUndoGuard();
    const view = new EditorView({
      parent: document.getElementById("host")!,
      state: EditorState.create({ doc: "my note", extensions: [history(), guard.extension] }),
    });
    const unregister = guard.register(view);
    const editor = richEditorOf(view.contentDOM);
    assert.ok(editor, "the editable element is known as an editor with its own history");
    assert.equal(richEditorCanStep(editor!, "undo"), false);

    // The walk's field guard, wired as useUndoWalk wires it on first focus.
    const fields = createFieldUndoGuard({ now: () => 10, defer: () => {} });
    editor!.on("update", () => fields.edited(view.contentDOM));
    // Select all, Backspace: a transaction, no input event.
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "" }, userEvent: "delete.backward" });
    assert.equal(view.state.doc.toString(), "");

    const history0 = { items: [{ id: "e1", ts: 1 }], undoOrder: ["e1"], redoOrder: [] };
    const fellBack: string[] = [];
    const declined = fields.declines("undo", view.contentDOM, history0, () => fellBack.push("app"), richEditorCanStep(editor!, "undo"));
    assert.equal(declined, true, "the press is the editor's, not the app's");
    undo(view);
    assert.equal(view.state.doc.toString(), "my note");
    assert.equal(richEditorCanStep(editor!, "undo"), false);
    assert.deepEqual(fellBack, []);

    unregister();
    assert.equal(richEditorOf(view.contentDOM), null);
    view.destroy();
  });
});
