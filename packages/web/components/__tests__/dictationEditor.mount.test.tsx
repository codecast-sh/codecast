import { dom, w, restoreGlobals } from "./fixtures/composeDom";
import { afterAll, afterEach, expect, test } from "bun:test";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { TextSelection } from "@tiptap/pm/state";
import { _resetDictationForTests, createDictation, type DictationPipeEvents } from "@codecast/shared/contracts";
import { closeDomWindow } from "../../test-helpers/domGlobals";
import { editorField } from "../../lib/dictation/editorField";

// Dictation into a rich editor (the create-task description): the words go in
// at the cursor without touching formatting around them, Cancel puts the
// selection back with its marks, and an edit in the paragraph stops it.
// Run: bun test components/__tests__/dictationEditor.mount.test.tsx

afterAll(() => {
  closeDomWindow(dom);
  restoreGlobals();
});
afterEach(() => _resetDictationForTests());

/** `at` gives text offsets into the first paragraph (position 1 is its start),
 *  or "end" for the end of the document. */
function setup(html: string, at: ((doc: string) => [number, number]) | "end") {
  const el = w.document.createElement("div");
  w.document.body.appendChild(el);
  const editor = new Editor({ element: el, extensions: [StarterKit], content: html });
  const end = editor.state.doc.content.size - 1;
  const [from, to] = at === "end" ? [end, end] : at(editor.state.doc.textContent).map((n) => n + 1);
  editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, from, to)));
  const field = editorField(() => editor as any);
  let events: DictationPipeEvents | null = null;
  let endFinish: (() => void) | null = null;
  const d = createDictation(field, {
    open: (e) => {
      events = e;
      return Promise.resolve({ finish: () => new Promise<void>((r) => (endFinish = r)), close() {} });
    },
  }, (s) => { if (s.phase === "idle") field.end?.(); });
  const start = async () => { field.begin?.(); d.start(); await Promise.resolve(); await Promise.resolve(); };
  return { editor, d, start, say: () => events!, endFinish: () => endFinish!() };
}

test("words go in at the cursor; bold elsewhere in the paragraph stays bold", async () => {
  const t = setup("<p><strong>Fix</strong> the bug</p>", (s) => [s.indexOf(" bug"), s.indexOf(" bug")]);
  await t.start();
  t.say().onPartial("login");
  expect(t.editor.state.doc.textContent).toBe("Fix the login bug");
  t.say().onUtterance({ text: "login page" });
  expect(t.editor.state.doc.textContent).toBe("Fix the login page bug");
  expect(t.editor.getHTML()).toBe("<p><strong>Fix</strong> the login page bug</p>");
  const done = t.d.finish();
  t.endFinish();
  await done;
  expect(t.editor.state.doc.textContent).toBe("Fix the login page bug");
  t.editor.destroy();
});

test("cancel puts a replaced selection back, marks and all", async () => {
  const t = setup("<p>use <em>OLD</em> here</p>", (s) => [s.indexOf("OLD"), s.indexOf("OLD") + 3]);
  await t.start();
  t.say().onPartial("new");
  expect(t.editor.state.doc.textContent).toBe("use new here");
  t.d.cancel();
  expect(t.editor.getHTML()).toBe("<p>use <em>OLD</em> here</p>");
  // ...and selected again, as it was at the press.
  const at = "use ".length + 1;
  expect([t.editor.state.selection.from, t.editor.state.selection.to]).toEqual([at, at + 3]);
  t.editor.destroy();
});

test("an edit in the paragraph mid-recording stops it and keeps the person's text", async () => {
  const t = setup("<p>hello</p>", (s) => [s.length, s.length]);
  await t.start();
  t.say().onPartial("world");
  expect(t.editor.state.doc.textContent).toBe("hello world");
  t.editor.view.dispatch(t.editor.state.tr.insertText("!", 1));
  t.say().onPartial("world again");
  expect(t.editor.state.doc.textContent).toBe("!hello world");
  expect(t.d.state).toMatchObject({ phase: "idle", stopped: "edited" });
  t.editor.destroy();
});

test("an edit in another paragraph moves the words with it and does not stop them", async () => {
  const t = setup("<p>first</p><p>second</p>", "end");
  await t.start();
  t.say().onPartial("line");
  expect(t.editor.getText({ blockSeparator: "|" })).toBe("first|second line");
  t.editor.view.dispatch(t.editor.state.tr.insertText("the ", 1));
  t.say().onPartial("line two");
  expect(t.editor.getText({ blockSeparator: "|" })).toBe("the first|second line two");
  expect(t.d.state.phase).toBe("listening");
  t.d.cancel();
  expect(t.editor.getText({ blockSeparator: "|" })).toBe("the first|second");
  t.editor.destroy();
});
