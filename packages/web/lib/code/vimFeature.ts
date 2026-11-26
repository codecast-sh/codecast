// Vim in the code editor. On when the person has a vimrc, off otherwise, and
// either way whatever they chose in Settings > Editor, from the mode chip or
// with `vim.toggle` (docs/architecture/code-editor.md). The choice is the
// synced `vimMode` setting (editorSettings.ts), so it follows them across
// devices. The engine is its own chunk, loaded the
// first time an editor turns vim on.
//
// The vimrc comes from the daemon (daemonClient.fetchVimrcText) and is applied
// through vim's ensureVimConfig, which paints the first editor from the copy
// cached last time and refreshes in the background.

import type { EditorView } from "@codemirror/view";
import type { CodeVimrcResponse } from "@codecast/shared/contracts";
import { editorSetting, explicitEditorSettings, hasVimConfig, onEditorSettingsChange, setEditorSetting, vimModeOn, vimOptionsFromSettings } from "./editorSettings";
import { useVaultStore } from "../../store/vaultStore";
import { registerCodeCommands } from "./commands";
import { fetchVimrcText } from "./daemonClient";
import type { VaultEndpoint } from "../vault/client";
import { whenIdle } from "./idle";
import { liveStatusItem, reconfigureEditorFeature, registerEditorFeature, registerStatusItem, type EditorFeatureContext, type StatusItemView } from "./features";
import { editorOptionOverrides, type CodeEditorOptions } from "./setup";
import type { VimConfigReport, VimMode } from "./vim/types";

type VimModule = typeof import("./vim");

const FEATURE = "vim";
/** Vaults whose editors always run vim (the vimrc overlay editor). */
const vimAlways = new Set<string>();

export function alwaysVimFor(vaultId: string): () => void {
  vimAlways.add(vaultId);
  return () => vimAlways.delete(vaultId);
}

/** Whether the last vimrc read found one, so a page load decides without
 *  waiting on the daemon. Per machine, like the vimrc itself. */
const FOUND_KEY = "codecast:code-vimrc-found";

const storage = {
  get: (key: string) => {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set: (key: string, value: string | null) => {
    try {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch {
      // Storage blocked: the choice lasts for this page.
    }
  },
};

// The core options (line numbers, wrap) the vimrc set per language last time,
// held while the engine loads so a `set nonumber` file paints without numbers
// instead of dropping them a second later.
const CORE_KEY = "codecast:code-vim-core:v1";
let coreByLanguage: Record<string, Partial<CodeEditorOptions>> | null = null;

function rememberedCore(): Record<string, Partial<CodeEditorOptions>> {
  if (coreByLanguage) return coreByLanguage;
  try {
    coreByLanguage = JSON.parse(storage.get(CORE_KEY) ?? "{}") as Record<string, Partial<CodeEditorOptions>>;
  } catch {
    coreByLanguage = {};
  }
  return coreByLanguage;
}

function rememberCore(languageId: string, core: Partial<CodeEditorOptions>): void {
  const all = rememberedCore();
  if (JSON.stringify(all[languageId]) === JSON.stringify(core)) return;
  coreByLanguage = { ...all, [languageId]: core };
  storage.set(CORE_KEY, JSON.stringify(coreByLanguage));
}

function vimPlaceholder(ctx: EditorFeatureContext) {
  if (!vimAlways.has(ctx.vaultId) && !vimWanted()) return null;
  const core = rememberedCore()[ctx.languageId];
  return core ? editorOptionOverrides.of(core) : null;
}

let engine: Promise<VimModule> | null = null;
let loaded: VimModule | null = null;

function loadVim(): Promise<VimModule> {
  engine ??= import("./vim").then((m) => {
    loaded = m;
    // A refreshed vimrc changes options per language: rebuild them.
    m.onVimConfigChange(() => reconfigureEditorFeature(FEATURE));
    return m;
  });
  return engine;
}

// ── the vimrc ───────────────────────────────────────────────────────────────

let read: Promise<string> | null = null;

const hasVimrc = (text: string) => hasVimConfig(JSON.parse(text) as CodeVimrcResponse);

/** One read of the vimrc per page (and per reload), as raw text; a failed read
 *  is retried by the next caller. `fallback` reaches the daemon when Files has
 *  not connected this page yet (Settings > Editor opened first). */
function readVimrc(fallback?: VaultEndpoint | null): Promise<string> {
  if (!read) {
    const ep = useVaultStore.getState().endpoint ?? fallback;
    const req = ep ? fetchVimrcText(ep) : Promise.reject(new Error("Files is not connected to this machine"));
    read = req;
    req.then(
      (text) => void whenIdle(() => noteFound(hasVimrc(text))).catch(() => {}),
      () => {
        if (read === req) read = null;
      },
    );
  }
  return read;
}

function noteFound(found: boolean): void {
  const value = found ? "1" : "0";
  if (storage.get(FOUND_KEY) === value) return;
  storage.set(FOUND_KEY, value);
  // A vimrc appeared or went away: editors following it follow it now.
  if (editorSetting("vimMode") === "auto") reconfigureEditorFeature(FEATURE);
}

/** Whether the last read found a vimrc (null before any read on this machine). */
export function vimrcFound(): boolean | null {
  const found = storage.get(FOUND_KEY);
  return found === null ? null : found === "1";
}

/** On or off as things stand, without asking the daemon. */
function vimWanted(): boolean {
  return vimModeOn(editorSetting("vimMode"), storage.get(FOUND_KEY) === "1");
}

async function vimOn(): Promise<boolean> {
  if (editorSetting("vimMode") !== "auto" || storage.get(FOUND_KEY)) {
    void readVimrc().catch(() => {});
    return vimWanted();
  }
  // First visit: nothing known yet, so the answer waits on one read.
  return readVimrc().then(hasVimrc).catch(() => false);
}

/** Turn vim on or off; a choice that matches what the vimrc implies goes
 *  back to following it. Editors follow through onEditorSettingsChange. */
function setVim(on: boolean): void {
  const follows = (storage.get(FOUND_KEY) === "1") === on;
  setEditorSetting("vimMode", follows ? undefined : on ? "on" : "off");
}

// ── the mode chip ───────────────────────────────────────────────────────────

const MODE_LABEL: Record<VimMode, string> = {
  normal: "NORMAL",
  insert: "INSERT",
  visual: "VISUAL",
  "visual line": "V-LINE",
  "visual block": "V-BLOCK",
  replace: "REPLACE",
  "op-pending": "NORMAL",
};

/** Follow vim in this editor while it runs there (`follow`), or show the
 *  idle state (`idle`) when it does not. */
function whileVim(view: EditorView, follow: (vim: VimModule) => () => void, idle: () => void): () => (() => void) | null {
  return () => {
    if (loaded?.currentVimMode(view)) return follow(loaded);
    idle();
    return null;
  };
}

/** The mode while vim runs in this editor; a dim "Vim" to turn it back on
 *  when the person turned it off. Clicking toggles. */
function modeChip(view: EditorView): StatusItemView {
  const dom = document.createElement("button");
  dom.type = "button";
  dom.className = "cm-vim-mode";
  const text = document.createTextNode("");
  dom.append(text);
  dom.onclick = () => {
    setVim(!vimWanted());
    view.focus();
  };
  const show = (mode: VimMode | null) => {
    const label = mode ? MODE_LABEL[mode] : "Vim";
    if (text.nodeValue !== label) text.nodeValue = label;
    dom.dataset.mode = mode ?? "off";
    dom.title = mode ? "Vim mode on: click to turn off" : "Vim mode off: click to turn on";
    dom.hidden = !mode && editorSetting("vimMode") !== "off";
  };
  return liveStatusItem(dom, whileVim(view, (vim) => vim.onVimModeChange(view, show), () => show(null)));
}

/** Neovim's showcmd: the keys vim holds toward a command (a count, `g`, a
 *  leader prefix, an operator waiting for its motion), beside the mode chip.
 *  Written as a text node from vim's own events; empty and hidden otherwise. */
function showcmd(view: EditorView): StatusItemView {
  const dom = document.createElement("span");
  dom.className = "cm-vim-showcmd";
  const text = document.createTextNode("");
  dom.append(text);
  dom.hidden = true;
  const show = (keys: string) => {
    if (text.nodeValue !== keys) text.nodeValue = keys;
    dom.hidden = keys === "";
  };
  return liveStatusItem(dom, whileVim(view, (vim) => vim.onPendingVimKeysChange(view, show), () => show("")));
}

// ── registration ────────────────────────────────────────────────────────────

let registered = false;

/** Register vim with the editor core, once. */
export function registerVimFeature(): void {
  if (registered) return;
  registered = true;

  registerEditorFeature(FEATURE, async (ctx) => {
    if (!vimAlways.has(ctx.vaultId) && !(await vimOn())) return null;
    const vim = await loadVim();
    // No config (the daemon is out of reach, nothing cached): vim with its defaults.
    const report = await vim.ensureVimConfig(readVimrc).catch(() => null);
    const seed = vimOptionsFromSettings(explicitEditorSettings());
    rememberCore(ctx.languageId, vim.vimCoreOverrides(report, ctx.languageId, seed));
    return [
      vim.createVimExtension(),
      // The person's Settings > Editor choices go in under the runtime layer,
      // so they beat the vimrc and a `:set` typed later beats them.
      vim.vimOptionsExtension(report, ctx.languageId, seed),
    ];
  }, { placeholder: vimPlaceholder });

  // Rebuilt when the mode or a choice vim seeds changes, and only then.
  const signature = () => `${editorSetting("vimMode")}|${JSON.stringify(vimOptionsFromSettings(explicitEditorSettings()))}`;
  let last = signature();
  onEditorSettingsChange(() => {
    const next = signature();
    if (next === last) return;
    last = next;
    reconfigureEditorFeature(FEATURE);
  });

  registerStatusItem({ id: "vim.mode", side: "left", order: 10, priority: 100, create: modeChip });
  registerStatusItem({ id: "vim.showcmd", side: "left", order: 11, priority: 60, create: showcmd });

  registerCodeCommands({
    "vim.toggle": () => setVim(!vimWanted()),
    "vim.reloadConfig": () => {
      void reloadVimConfig().catch(() => {});
    },
  });
}

// ── for Settings > Editor ───────────────────────────────────────────────────

/** The daemon's vimrc response (sources with their text, the overlay, what
 *  was not followed), from the same one read per page the editors use. */
export async function readVimrcResponse(ep?: VaultEndpoint | null): Promise<CodeVimrcResponse> {
  return JSON.parse(await readVimrc(ep)) as CodeVimrcResponse;
}

/** The response the applied config was parsed from (the cached copy until
 *  the daemon answers), once the engine has loaded. */
export function currentVimrcResponse(): CodeVimrcResponse | null {
  const text = loaded?.currentVimResponse();
  return text ? (JSON.parse(text) as CodeVimrcResponse) : null;
}

/** The report of the config vim runs with, loading the engine if need be. */
export async function vimConfigReport(ep?: VaultEndpoint | null): Promise<VimConfigReport> {
  const vim = await loadVim();
  return vim.ensureVimConfig(() => readVimrc(ep));
}

/** Read the vimrc again and apply it to every editor; resolves with the new
 *  report. A changed config reaches the editors through onVimConfigChange. */
export async function reloadVimConfig(ep?: VaultEndpoint | null): Promise<VimConfigReport | null> {
  read = null;
  if (!loaded) {
    await readVimrc(ep);
    return null;
  }
  return loaded.ensureVimConfig(() => readVimrc(ep), { reload: true });
}

/** Each newly applied config, once the engine has loaded; returns the unsubscribe. */
export function onVimReport(cb: (report: VimConfigReport) => void): () => void {
  let off: (() => void) | null = null;
  let live = true;
  void loadVim().then((vim) => {
    if (live) off = vim.onVimConfigChange(cb);
  });
  return () => {
    live = false;
    off?.();
  };
}
