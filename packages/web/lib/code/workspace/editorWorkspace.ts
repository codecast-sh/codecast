// What the workspace shell adds inside every editor, registered once with the
// editor core when the editor chunk loads: the symbol path for the
// breadcrumbs, the cursor history (nav.back / nav.forward), the editor-local
// keys that reach workspace commands, the cursor reader persistence uses, and
// vim's share (Ctrl-O / Ctrl-I across files, undo in a mirrored split).

import { Prec } from "@codemirror/state";
import { EditorView, ViewPlugin, keymap, type KeyBinding, type ViewUpdate } from "@codemirror/view";
import { bufferKey, codeBuffers, currentState } from "../buffers";
import { runCodeCommand, type CodeCommandId } from "../commands";
import { featureContext, registerEditorFeature } from "../features";
import { noteLocation } from "./navHistory";
import { setCursorReader } from "./persist";
import { primaryOf, runHistory } from "./splitSync";
import { symbolPathPlugin } from "./symbolPath";

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

function where(view: EditorView) {
  const ctx = view.state.facet(featureContext);
  if (!ctx) return null;
  const head = view.state.selection.main.head;
  const line = view.state.doc.lineAt(head);
  return { vaultId: ctx.vaultId, path: ctx.path, line: line.number, col: head - line.from + 1 };
}

/** Record the cursor in the history while this editor has focus. */
const navRecorder = [
  EditorView.domEventHandlers({
    focus: (_e, view) => {
      const loc = where(view);
      if (loc) noteLocation(loc);
      return false;
    },
  }),
  EditorView.updateListener.of((u: ViewUpdate) => {
    if (!u.selectionSet || !u.view.hasFocus) return;
    const loc = where(u.view);
    if (loc) noteLocation(loc);
  }),
];

const command =
  (id: CodeCommandId, args?: Record<string, unknown>) =>
  (view: EditorView): boolean =>
    runCodeCommand(id, args, { view, source: "keymap" });

const keys: KeyBinding[] = [
  ...Array.from({ length: 9 }, (_, i): KeyBinding => ({ key: `Mod-${i + 1}`, run: command("tabs.goto", { index: i === 8 ? Number.MAX_SAFE_INTEGER : i }), preventDefault: true })),
  { key: "Ctrl-g", run: command("goto.line") },
  { key: "Mod-Alt-ArrowLeft", run: command("focus.left"), preventDefault: true },
  { key: "Mod-Alt-ArrowRight", run: command("focus.right"), preventDefault: true },
  { key: "Mod-Alt-ArrowUp", run: command("focus.up"), preventDefault: true },
  { key: "Mod-Alt-ArrowDown", run: command("focus.down"), preventDefault: true },
  ...(isMac
    ? [
        { key: "Ctrl--", run: command("nav.back"), preventDefault: true },
        { key: "Ctrl-_", run: command("nav.forward"), preventDefault: true },
        { key: "Ctrl-Shift--", run: command("nav.forward"), preventDefault: true },
      ]
    : [
        { key: "Alt-ArrowLeft", run: command("nav.back"), preventDefault: true },
        { key: "Alt-ArrowRight", run: command("nav.forward"), preventDefault: true },
      ]),
];

// ── vim ──────────────────────────────────────────────────────────────────────

let vimTweaks: Promise<void> | null = null;

/** Once vim runs anywhere: its jumps reach across files through the cursor
 *  history, and its undo in a mirrored split runs on the primary's history. */
function installVimTweaks(): void {
  vimTweaks ??= import("@replit/codemirror-vim").then(({ CodeMirror, Vim }) => {
    const commands = CodeMirror.commands as unknown as Record<string, (cm: { cm6: EditorView }) => void>;
    for (const side of ["undo", "redo"] as const) {
      const original = commands[side];
      commands[side] = (cm) => {
        if (primaryOf(cm.cm6)) runHistory(cm.cm6, side);
        else original(cm);
      };
    }
    // codecastCommand (vim/plugins.ts) runs a workspace command by id.
    Vim.mapCommand("<C-o>", "action", "codecastCommand", { command: "nav.back" }, { context: "normal" });
    Vim.mapCommand("<C-i>", "action", "codecastCommand", { command: "nav.forward" }, { context: "normal" });
  });
}

const vimWatcher = ViewPlugin.fromClass(
  class {
    constructor(view: EditorView) {
      this.check(view);
    }
    update(u: ViewUpdate) {
      if (!vimTweaks && u.transactions.some((tr) => tr.reconfigured)) this.check(u.view);
    }
    check(view: EditorView) {
      if (view.scrollDOM.classList.contains("cm-vimMode")) installVimTweaks();
      else if (!vimTweaks) queueMicrotask(() => view.scrollDOM.classList.contains("cm-vimMode") && installVimTweaks());
    }
  },
);

let registered = false;

export function registerWorkspaceEditorFeatures(): void {
  if (registered) return;
  registered = true;
  registerEditorFeature("workspace.shell", () => [symbolPathPlugin, navRecorder, Prec.high(keymap.of(keys)), vimWatcher]);
  setCursorReader((vaultId, path) => {
    const b = codeBuffers.get(bufferKey(vaultId, path));
    if (!b) return null;
    const state = currentState(b);
    const head = state.selection.main.head;
    const line = state.doc.lineAt(head);
    return { line: line.number, col: head - line.from + 1 };
  });
}
