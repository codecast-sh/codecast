// clipboard=unnamed / unnamedplus: the unnamed register is the system clipboard.
//
// Yanks and deletes write through to navigator.clipboard. Reading is async
// and the engine pastes synchronously, so text copied elsewhere is picked up
// ahead of time (on any copy, cut or paste in the page, and when the editor
// gains focus once reading is allowed) and handed to the unnamed register the
// next time `p` reads it. Reading asks the browser for a permission, so it is
// asked for only when `p` wants the clipboard, never on focus.

import { Vim } from "@replit/codemirror-vim";
import { EditorView } from "@codemirror/view";

let enabled = false;
let lastWritten: string | null = null;
let incoming: string | null = null;
let readState: PermissionState | "unknown" = "unknown";
let asked = false;
const patched = new WeakSet<object>();

const same = (a: string, b: string | null) => b !== null && (a === b || a === `${b}\n` || `${a}\n` === b);

export function setClipboardSync(on: boolean): void {
  enabled = on;
  if (on) {
    patchRegisters();
    if (typeof navigator !== "undefined") void permission();
  }
  else incoming = null;
}

export function clipboardSyncEnabled(): boolean {
  return enabled;
}

/** Offer text the person copied outside the editor's registers. */
export function offerClipboardText(text: string): void {
  if (enabled && text && !same(text, lastWritten)) incoming = text;
}

function patchRegisters(): void {
  // resetVimGlobalState_ swaps the controller, so patch whichever is live.
  const rc = Vim.getRegisterController();
  if (patched.has(rc)) return;
  patched.add(rc);
  const pushText = rc.pushText.bind(rc);
  rc.pushText = (name, operator, text, linewise, blockwise) => {
    pushText(name, operator, text, linewise, blockwise);
    if (!enabled || (name && name !== '"' && name !== "*" && name !== "+")) return;
    const out = linewise && !text.endsWith("\n") ? `${text}\n` : text;
    lastWritten = out;
    incoming = null;
    navigator.clipboard?.writeText(out).catch(() => {});
  };
  const getRegister = rc.getRegister.bind(rc);
  rc.getRegister = (name) => {
    const unnamed = !name || name === '"' || name === "*" || name === "+";
    if (enabled && unnamed && incoming === null && readState === "prompt" && !asked) {
      // A paste is the moment the person wants the clipboard: ask now, so
      // the next paste and every focus after it can read it.
      asked = true;
      void readClipboard(true);
    }
    if (enabled && incoming !== null && unnamed) {
      const text = incoming;
      incoming = null;
      lastWritten = text;
      // Linewise registers keep their trailing newline: paste drops it.
      rc.unnamedRegister.setText(text, text.endsWith("\n"));
    }
    return getRegister(name);
  };
}

async function permission(): Promise<void> {
  if (readState !== "unknown") return;
  try {
    const status = await navigator.permissions?.query({ name: "clipboard-read" as PermissionName });
    if (!status) return;
    readState = status.state;
    status.onchange = () => {
      readState = status.state;
    };
  } catch {
    // Firefox and Safari have no clipboard-read permission: they ask on each read.
    readState = "denied";
  }
}

async function readClipboard(ask = false): Promise<void> {
  if (!enabled || !navigator.clipboard?.readText) return;
  await permission();
  if (readState !== "granted" && !ask) return;
  try {
    offerClipboardText(await navigator.clipboard.readText());
  } catch {
    // Refused or no focus: the registers keep what they have.
  }
}

/** What a copy the browser handles itself will take. */
function selectedText(): string {
  const el = document.activeElement;
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    return el.value.slice(el.selectionStart ?? 0, el.selectionEnd ?? 0);
  }
  return document.getSelection()?.toString() ?? "";
}

let pageListeners = false;

/** Keeps the registers fresh while clipboard sync is on. */
export function clipboardSync() {
  if (!pageListeners && typeof document !== "undefined") {
    pageListeners = true;
    // Bubble phase, after CodeMirror's handler filled clipboardData from the
    // state: the DOM holds only the viewport, so a long selection read from it
    // comes back with lines missing.
    // These run on every copy in the page: with sync off they read nothing
    // (a selection's text is a walk of the whole selected DOM).
    const onCopy = (e: ClipboardEvent) => {
      if (enabled) offerClipboardText(e.clipboardData?.getData("text/plain") || selectedText());
    };
    document.addEventListener("copy", onCopy);
    document.addEventListener("cut", onCopy);
    document.addEventListener(
      "paste",
      (e) => {
        if (enabled) offerClipboardText(e.clipboardData?.getData("text/plain") ?? "");
      },
      true,
    );
  }
  return EditorView.domEventHandlers({
    focus: () => {
      void readClipboard();
    },
  });
}
