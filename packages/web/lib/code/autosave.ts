// Autosave, per Settings > Editor (off by default for code: a half-typed file
// on disk reaches watchers, typecheckers and agents; docs/architecture/code-editor.md).
//
//   delay   a second after the last edit
//   focus   when focus leaves the editor (a click elsewhere, another window;
//           vim's `:` and `/` prompt sit inside it and do not count) or the
//           file leaves the editor (a tab switch swaps the state,
//           which ends this plugin's instance for that buffer)
//
// It saves through fileSync.saveBuffer, the same compare-and-swap path as
// Cmd-S. A buffer with a question pending (disk moved under it, a merge open,
// a failed save) is left for the person: autosave never opens a merge, and
// never writes edits a revert is throwing away.
//
// One plugin instance per shown state, reading the mode live, so changing the
// setting never reconfigures (and never saves through a teardown). The cost
// per keystroke is a timer reset when the mode is "delay", nothing otherwise.

import { ViewPlugin, type EditorView, type ViewUpdate } from "@codemirror/view";
import { bufferKey, codeBuffers, currentState, isDirty, type CodeBuffer } from "./buffers";
import { AUTOSAVE_DELAY_MS, editorSetting } from "./editorSettings";
import { featureContext, registerEditorFeature } from "./features";
import { discardInFlight, saveBuffer } from "./fileSync";
import { useCodeStore } from "../../store/codeStore";

/** Vaults whose buffers save some other way (the vimrc overlay on the
 *  settings page saves through the daemon's overlay route). */
const exempt = new Set<string>();

export function exemptFromAutosave(vaultId: string): () => void {
  exempt.add(vaultId);
  return () => exempt.delete(vaultId);
}

/** Whether autosave may write this buffer now. */
export function autosaveReady(b: CodeBuffer): boolean {
  if (exempt.has(b.vaultId) || b.stale || b.merging || discardInFlight(b)) return false;
  const state = currentState(b);
  if (state.readOnly || !isDirty(state)) return false;
  return !useCodeStore.getState().conflicts[b.key];
}

function save(key: string | null): void {
  const b = key ? codeBuffers.get(key) : undefined;
  if (b && autosaveReady(b)) void saveBuffer(b);
}

const autosavePlugin = ViewPlugin.define((view: EditorView) => {
  const ctx = view.state.facet(featureContext);
  const key = ctx ? bufferKey(ctx.vaultId, ctx.path) : null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const clear = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  // Focus leaving anything inside the editor (its text, vim's prompt), read
  // once the move settles: a move that stays inside is not a focus change.
  // Switching to another window or app keeps activeElement on the editor, so
  // a document that lost focus counts as the editor losing it.
  const onFocusOut = () => {
    if (editorSetting("autosave") !== "focus") return;
    setTimeout(() => {
      const doc = view.dom.ownerDocument;
      const active = doc.activeElement;
      if (!doc.hasFocus() || !(active && view.dom.contains(active))) save(key);
    }, 0);
  };
  view.dom.addEventListener("focusout", onFocusOut);
  return {
    update(u: ViewUpdate) {
      if (u.docChanged && editorSetting("autosave") === "delay") {
        clear();
        timer = setTimeout(() => {
          timer = null;
          save(key);
        }, AUTOSAVE_DELAY_MS);
      }
    },
    destroy() {
      view.dom.removeEventListener("focusout", onFocusOut);
      // The file left this editor (a tab switch, a closed pane): an edit
      // waiting on the delay is written now rather than dropped, and "focus"
      // counts leaving as losing focus.
      const pending = timer !== null;
      clear();
      const mode = editorSetting("autosave");
      if (mode === "focus" || (mode === "delay" && pending)) save(key);
    },
  };
});

let registered = false;

export function registerAutosaveFeature(): void {
  if (registered) return;
  registered = true;
  registerEditorFeature("core.autosave", () => autosavePlugin);
}
