// Vim mode for the code editor: the engine, the person's vimrc, ex adapters
// to workspace commands, and built-in plugins. Loaded lazily by the editor
// core; nothing here touches React or a store.
//
//   createVimExtension()          vim() plus our plugins and theme, ahead
//                                 of every keymap.
//   ensureVimConfig(fetchText)    the person's maps, from cache first.
//   vimOptionsExtension(report)   the CodeMirror side of their options.
//   onVimModeChange(view, cb)     the mode for the status bar.

import { Prec, type Extension } from "@codemirror/state";
import { ViewPlugin } from "@codemirror/view";
import { getCM, vim } from "@replit/codemirror-vim";
import type { CodeVimrcResponse } from "@codecast/shared/contracts";
import { applyVimConfig, ensureVimDefaults, parseVimConfig } from "./apply";
import { clipboardSync } from "./clipboard";
import { expandCommandLine, PROMPT_CARET } from "./exAdapters";
import { whenIdle } from "../idle";
import { dropPendingKeys } from "./keyLayer";
import { vimTheme } from "./theme";
import type { ParsedVimrc, VimConfigReport } from "./types";

export { applyVimConfig, loadVimConfig } from "./apply";
export { parseVimrc, type VimrcSourceInput } from "./parse";
export {
  editorOptionsFromReport,
  readVimEditorOptions,
  vimEditorOptionsChanged,
  vimOptionsExtension,
  type VimEditorOptions,
} from "./editorOptions";
export { currentVimMode, onPendingVimKeysChange, onVimModeChange, pendingVimKeys } from "./mode";
export { flushPendingKeys } from "./keyLayer";
export type * from "./types";

/** A command line a map opens with text still in it (`:%s/<C-R><C-W>//g`)
 *  gets the word, register or line filled in as it opens, and the caret
 *  where the map's `<Left>`s left it. Held keys go with the view. */
const promptExpansion = ViewPlugin.define((view) => {
  const cm = getCM(view);
  const open = cm?.openDialog;
  if (cm && open) {
    cm.openDialog = (template, callback, options?: { value?: string }) => {
      if (!options?.value) return open.call(cm, template, callback, options);
      const value = expandCommandLine(view, options.value);
      const caret = value.indexOf(PROMPT_CARET);
      const close = open.call(cm, template, callback, { ...options, value: value.replace(PROMPT_CARET, "") });
      const input = cm.state.dialog?.querySelector("input");
      if (input && caret >= 0) input.setSelectionRange(caret, caret);
      return close;
    };
  }
  return { destroy: () => cm && dropPendingKeys(cm) };
});

/** Vim, with the status panel off (the app's status bar shows the mode).
 *  Highest precedence, so its keys come before every keymap wherever the
 *  editor places it (the core appends features after its own keymap, whose
 *  Escape would otherwise never reach vim). */
export function createVimExtension(): Extension {
  ensureVimDefaults();
  return Prec.highest([vimTheme, vim({ status: false }), promptExpansion, clipboardSync()]);
}

// ── config cache ────────────────────────────────────────────────────────────

// The parsed config rides along with the response text it came from, so a
// page load applies it without parsing, and the background fetch compares the
// raw response text alone: an unchanged vimrc (nearly every load) costs one
// string compare, never a decode or a parse. A changed one is decoded and
// parsed in one idle slice and applied in the next, off the first paint. Bump the key when
// the parser's output for the same vimrc changes, so caches parse again.
const CACHE_KEY = "codecast:code-vimrc:v3";

interface Cached {
  response: string;
  parsed: ParsedVimrc;
}

let current: VimConfigReport | null = null;
/** The response text the applied config was parsed from. */
let currentResponse: string | null = null;
let refresh: Promise<VimConfigReport> | null = null;
// Fetches are numbered; one that lands after a newer one was adopted is dropped.
let fetches = 0;
let adoptedFetch = 0;
const listeners = new Set<(report: VimConfigReport) => void>();

function adopt(cached: Cached): VimConfigReport {
  current = applyVimConfig(cached.parsed);
  currentResponse = cached.response;
  for (const cb of listeners) cb(current);
  return current;
}

function readCache(): Cached | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    const c = raw ? (JSON.parse(raw) as Cached) : null;
    return c && typeof c.response === "string" && Array.isArray(c.parsed?.sources) ? c : null;
  } catch {
    return null;
  }
}

function writeCache(cached: Cached): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(cached));
  } catch {
    // Storage full or blocked: the next load fetches again.
  }
}

/** The report of the config applied now, if any. */
export function currentVimConfig(): VimConfigReport | null {
  return current;
}

/** The raw daemon response the applied config was parsed from. */
export function currentVimResponse(): string | null {
  return currentResponse;
}

/** Called with each newly applied config (a background refresh that found
 *  changes, a reload). Returns the unsubscribe. */
export function onVimConfigChange(cb: (report: VimConfigReport) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Apply the person's vimrc. The first call applies the copy cached from
 *  last time, so the first editor paints with their maps, and fetches the
 *  current one in the background; it resolves with the cached report when
 *  there is one. Later calls reuse that unless `reload` asks for a fetch
 *  (vim.reloadConfig, the overlay was saved). */
export function ensureVimConfig(fetchText: () => Promise<string>, opts: { reload?: boolean } = {}): Promise<VimConfigReport> {
  if (!current && !opts.reload) {
    const cached = readCache();
    if (cached) {
      try {
        adopt(cached);
      } catch {
        current = null;
      }
    }
  }
  if (!refresh || opts.reload) {
    const seq = ++fetches;
    // A newer fetch already landed: this answer is older than what runs.
    const superseded = () => seq < adoptedFetch && !!current;
    refresh = fetchText().then(
      async (text) => {
        if (superseded()) return current!;
        if (text === currentResponse && current) {
          adoptedFetch = seq;
          return current;
        }
        const parsed = await whenIdle(() => (superseded() ? null : parseVimConfig(JSON.parse(text) as CodeVimrcResponse)));
        return whenIdle(() => {
          if (!parsed || superseded()) return current!;
          adoptedFetch = seq;
          const cached = { response: text, parsed };
          writeCache(cached);
          return adopt(cached);
        });
      },
      (err) => {
        if (seq === fetches) refresh = null;
        if (current) return current;
        throw err;
      },
    );
  }
  return current && !opts.reload ? Promise.resolve(current) : refresh;
}
