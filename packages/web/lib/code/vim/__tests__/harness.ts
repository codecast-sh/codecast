// Mount an editor with vim in jsdom and drive it the way keypresses do.
// jsdom has no layout, so j/k (which measure lines) land anywhere: tests move
// between lines with counts and G instead.

// Import it after installDom(), and call installHarness() in the test file.

import { afterEach } from "bun:test";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { getCM, Vim } from "@replit/codemirror-vim";
import { registerCodeCommands, type CodeCommandId } from "../../commands";
import { createVimExtension } from "../index";
import { splitEngineKeys } from "../keys";

const views: EditorView[] = [];
const offs: Array<() => void> = [];

export function installHarness(): void {
  afterEach(() => {
    for (const v of views.splice(0)) v.destroy();
    for (const off of offs.splice(0)) off();
  });
}

/** A language with `//` line comments, standing in for a real one. */
export const slashComments: Extension = EditorState.languageData.of(() => [{ commentTokens: { line: "//" } }]);

export function mount(doc: string, extensions: Extension[] = []) {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const view = new EditorView({ parent, state: EditorState.create({ doc, extensions: [createVimExtension(), slashComments, ...extensions] }) });
  views.push(view);
  const cm = getCM(view)!;
  return {
    view,
    cm,
    /** Keys in vim notation, one engine key each: "ysiw)", "<C-w>h". */
    keys(seq: string) {
      for (const k of splitEngineKeys(seq)) Vim.handleKey(cm as never, k, "user");
    },
    /** Each character as its own keypress, the way `<em>` is typed. */
    type(chars: string) {
      for (const ch of chars) Vim.handleKey(cm as never, ch, "user");
    },
    /** A real keydown, through the vim plugin's own handler. */
    press(key: string, init: KeyboardEventInit = {}) {
      view.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));
    },
    insert(text: string) {
      view.dispatch(view.state.replaceSelection(text));
    },
    ex(input: string) {
      Vim.handleEx(cm as never, input);
    },
    get doc() {
      return view.state.doc.toString();
    },
    get head() {
      return view.state.selection.main.head;
    },
    cursorTo(pos: number) {
      view.dispatch({ selection: { anchor: pos } });
    },
  };
}

/** Record every run of the given workspace commands. */
export function recordCommands(ids: CodeCommandId[]) {
  const calls: Array<{ id: CodeCommandId; args: Record<string, unknown> | undefined }> = [];
  offs.push(registerCodeCommands(Object.fromEntries(ids.map((id) => [id, (args: Record<string, unknown> | undefined) => void calls.push({ id, args })]))));
  return calls;
}
