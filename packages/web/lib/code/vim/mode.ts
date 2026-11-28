// The vim mode and the keys vim is holding (showcmd), for the status bar,
// from the engine's own events.

import type { EditorView } from "@codemirror/view";
import { getCM, Vim } from "@replit/codemirror-vim";
import { asVimCM } from "./engine";
import { hasPendingKeys, onHeldKeysSettled } from "./keyLayer";
import type { VimMode } from "./types";

export function currentVimMode(view: EditorView): VimMode | null {
  const cm = getCM(view);
  const vim = cm?.state.vim;
  if (!vim) return null;
  if (vim.insertMode) return cm!.state.overwrite ? "replace" : "insert";
  if (vim.visualMode) return vim.visualBlock ? "visual block" : vim.visualLine ? "visual line" : "visual";
  return vim.inputState?.operator ? "op-pending" : "normal";
}

/** Call `cb` with `compute()` now and whenever it changes, re-reading it on
 *  each engine event that can move it (a key, a mode change, a finished
 *  command) and when the mapping layer's held keys run out. Returns the
 *  unsubscribe. */
function onVimEngineChange<T>(view: EditorView, compute: () => T, cb: (value: T) => void): () => void {
  const cm = getCM(view);
  if (!cm) return () => {};
  let last: T | undefined;
  let first = true;
  const check = () => {
    const value = compute();
    if (first || value !== last) {
      first = false;
      last = value;
      cb(value);
    }
  };
  const events = ["vim-mode-change", "vim-keypress", "vim-command-done"];
  for (const e of events) cm.on(e, check);
  const offHeld = onHeldKeysSettled((held) => {
    if (held === asVimCM(cm)) check();
  });
  check();
  return () => {
    for (const e of events) cm.off(e, check);
    offHeld();
  };
}

/** Call `cb` with the mode now and on every change. Returns the unsubscribe. */
export function onVimModeChange(view: EditorView, cb: (mode: VimMode) => void): () => void {
  return onVimEngineChange(view, () => currentVimMode(view), (mode) => mode && cb(mode));
}

/** Neovim's showcmd column is 10 wide; the newest keys are the ones kept. */
const SHOWCMD_WIDTH = 10;

/**
 * The keys typed toward a command that has not run yet: a count, a register,
 * an operator waiting for its motion, `g` or `z` waiting for the next key, a
 * leader prefix held for a mapping. Empty when nothing is pending, and in
 * insert mode, as in Neovim.
 *
 * The engine's `status` is exactly those keys: it gains each key as it is
 * pressed and is cleared when a command completes, the input state resets
 * (Escape) or the mode changes. It is shown only while the engine or the
 * mapping layer says something is pending, so a key the engine ignored never
 * lingers.
 */
export function pendingVimKeys(view: EditorView): string {
  const cm = getCM(view);
  const vim = cm?.state.vim;
  if (!cm || !vim || vim.insertMode) return "";
  const input = vim.inputState;
  const pending =
    !!input &&
    (!!input.operator || !!input.registerName || input.prefixRepeat.length > 0 || input.motionRepeat.length > 0 || input.keyBuffer.length > 0);
  if (!pending && !hasPendingKeys(asVimCM(cm))) return "";
  const keys = ((vim as { status?: string }).status ?? "").replace(/<Space>/g, "␣");
  return keys.length > SHOWCMD_WIDTH ? keys.slice(-SHOWCMD_WIDTH) : keys;
}

/** Call `cb` with the pending keys now and whenever they change. Returns the
 *  unsubscribe. */
export function onPendingVimKeysChange(view: EditorView, cb: (keys: string) => void): () => void {
  return onVimEngineChange(view, () => pendingVimKeys(view), cb);
}

/** The register a macro is being recorded into (`qa` → "a"), or "". */
export function recordingRegister(): string {
  const macro = (Vim.getVimGlobalState_() as { macroModeState?: { isRecording?: boolean; latestRegister?: string } }).macroModeState;
  return macro?.isRecording ? (macro.latestRegister ?? "") : "";
}

/** Call `cb` with the recording register now and whenever it changes.
 *  Returns the unsubscribe. */
export function onVimRecordingChange(view: EditorView, cb: (register: string) => void): () => void {
  return onVimEngineChange(view, recordingRegister, cb);
}
