// CodeMirror keeps its own history and deletes a selection (Backspace over
// select-all, Cut) without an input event. The app's undo chord would read
// the emptied field as having no edits and take back an app entry instead,
// and the note would stay empty. So the editor declares itself to the undo
// walk's field guard (lib/undoWalk registerRichEditor): it reports its
// changes, and answers from its own history whether a step is left.
import { redoDepth, undoDepth } from "@codemirror/commands";
import { EditorView } from "@codemirror/view";
import type { Extension } from "@codemirror/state";
import { registerRichEditor } from "../../lib/undoWalk";

/** The extension to install, and the call that registers a view built with it. */
export function codeMirrorUndoGuard(): { extension: Extension; register: (view: EditorView) => () => void } {
  const listeners = new Set<() => void>();
  return {
    extension: EditorView.updateListener.of((update) => {
      if (update.docChanged) for (const fn of listeners) fn();
    }),
    register: (view) =>
      registerRichEditor(view.contentDOM, {
        on: (_event, fn) => listeners.add(fn),
        can: () => ({ undo: () => undoDepth(view.state) > 0, redo: () => redoDepth(view.state) > 0 }),
      }),
  };
}
