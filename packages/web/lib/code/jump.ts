// An explicit navigation inside one editor: go to definition, a symbol pick, a
// breadcrumb, quick open's `:line`, a search result, gd's word search. Each
// moves the cursor through `jumpTo`, which tags the transaction with
// JUMP_EVENT; the cursor history (workspace/editorWorkspace navRecorder)
// makes every such move a back/forward stop, however near and in either mode,
// the way Neovim's jumplist and VS Code's navigation history do.

import { EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

export const JUMP_EVENT = "select.jump";

/** Put the cursor at `pos` (or select `pos..head`) and center it, as a jump. */
export function jumpTo(view: EditorView, pos: number, opts: { head?: number; focus?: boolean; scrollTop?: number } = {}): void {
  const len = view.state.doc.length;
  const anchor = Math.max(0, Math.min(pos, len));
  const head = opts.head === undefined ? anchor : Math.max(0, Math.min(opts.head, len));
  // Focus first: the history records the stop for the editor the person is in.
  if (opts.focus) view.focus();
  view.dispatch({
    selection: EditorSelection.single(anchor, head),
    // The cursor's line centered, or a given position at the top of the view.
    effects: opts.scrollTop === undefined ? EditorView.scrollIntoView(head, { y: "center" }) : EditorView.scrollIntoView(opts.scrollTop, { y: "start" }),
    userEvent: JUMP_EVENT,
  });
}
