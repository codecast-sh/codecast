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
import { noteJump, noteLocation } from "./navHistory";
import { JUMP_EVENT } from "../jump";
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
    if (!u.selectionSet) return;
    // An explicit jump (jumpTo) is a stop wherever focus is: quick open and
    // the pickers move an editor they are drawn over.
    const jump = u.transactions.some((tr) => tr.isUserEvent(JUMP_EVENT));
    if (!jump && !u.view.hasFocus) return;
    const loc = where(u.view);
    if (!loc) return;
    if (jump) noteJump();
    // Vim's own jumps mark the stops (installVimTweaks), never the distance.
    noteLocation(loc, undefined, { byDistance: !u.view.scrollDOM.classList.contains("cm-vimMode") });
  }),
];

const command =
  (id: CodeCommandId, args?: Record<string, unknown>) =>
  (view: EditorView): boolean =>
    runCodeCommand(id, args, { view, source: "keymap" });

const keys: KeyBinding[] = [
  ...Array.from({ length: 9 }, (_, i): KeyBinding => ({ key: `Mod-${i + 1}`, run: command("tabs.goto", { index: i === 8 ? Number.MAX_SAFE_INTEGER : i }), preventDefault: true })),
  { key: "Ctrl-g", run: command("goto.line") },
  // The finders, in every editor: the outline needs no server, and the rest
  // say so in a file without one.
  { key: "Mod-Shift-o", run: command("goto.symbol"), preventDefault: true },
  { key: "Mod-Alt-o", run: command("goto.workspaceSymbol"), preventDefault: true },
  { key: "Mod-Shift-.", run: command("breadcrumbs.focus"), preventDefault: true },
  { key: "F12", run: command("lsp.definition"), preventDefault: true },
  { key: "Shift-F12", run: command("lsp.references"), preventDefault: true },
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
    // Every jump the engine records (G, gg, /, n, *, %, ', `) starts a stop.
    const jumps = (Vim.getVimGlobalState_() as { jumpList?: { add: (...args: unknown[]) => unknown } }).jumpList;
    if (jumps) {
      const add = jumps.add;
      jumps.add = function (...args) {
        noteJump();
        return add.apply(this, args);
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
    // Where it was scrolled: the line at the top of the view, from the same
    // snapshot a tab switch restores (shown: taken now; off screen: kept).
    const snapshot = (b.view?.scrollSnapshot() ?? b.scroll)?.value as { range?: { from: number } } | undefined;
    const from = snapshot?.range?.from;
    const top = typeof from === "number" && from <= state.doc.length ? state.doc.lineAt(from).number : undefined;
    return { line: line.number, col: head - line.from + 1, ...(top ? { top } : {}) };
  });
}
