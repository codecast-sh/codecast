// Session blame in the code editor: which codecast session wrote each line.
// `blame.toggle` (the status bar chip, `:Git blame`, `:Gblame`, the palette)
// shows the gutter in every editor; Settings > Editor > Inline blame puts the
// cursor line's origin at its end. Register once with registerBlameFeature().
//
// This module is small and rides the editor chunk. The gutter, the inline
// text and the fetch (gutter.ts) load the first time either turns on.

import type { EditorView } from "@codemirror/view";
import { useVaultStore } from "../../../store/vaultStore";
import { registerCodeCommand } from "../commands";
import { editorSetting, onEditorSettingsChange } from "../editorSettings";
import { featureContext, reconfigureEditorFeature, registerEditorFeature, registerStatusItem, type EditorFeatureContext, type StatusItemView } from "../features";
import { useGitStatusStore } from "../git/status";
import { blameAvailability } from "./data";

type GutterModule = typeof import("./gutter");

const FEATURE = "blame";
const STORAGE_KEY = "codecast.code.blameGutter";

let gutterModule: GutterModule | null = null;
let loading: Promise<GutterModule> | null = null;
function loadGutter(): Promise<GutterModule> {
  loading ??= import("./gutter").then(
    (m) => (gutterModule = m),
    (e) => {
      loading = null;
      throw e;
    },
  );
  return loading;
}

function readGutterOn(): boolean {
  try {
    return typeof localStorage !== "undefined" && localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

let gutterOn = readGutterOn();
const toggleListeners = new Set<() => void>();

export function blameGutterOn(): boolean {
  return gutterOn;
}

/** Show or hide the gutter in every editor; remembered across reloads. */
export function setBlameGutter(on: boolean): void {
  if (on === gutterOn) return;
  gutterOn = on;
  try {
    localStorage.setItem(STORAGE_KEY, on ? "1" : "0");
  } catch {
    // Private mode: the choice lasts the session.
  }
  toggleListeners.forEach((fn) => fn());
  reconfigureEditorFeature(FEATURE);
}

function blameFeature(_ctx: EditorFeatureContext) {
  const opts = { gutter: gutterOn, inline: editorSetting("inlineBlame") };
  if (!opts.gutter && !opts.inline) return null;
  if (gutterModule) return gutterModule.blameExtension(opts);
  return loadGutter().then((m) => m.blameExtension(opts));
}

/** Why the file in `view` cannot be blamed, or null when it can (or may). */
export function blameUnavailableReason(view: EditorView): string | null {
  const ctx = view.state.facet(featureContext);
  if (!ctx) return "No file";
  const avail = blameAvailability(ctx.vaultId);
  if (avail.ok === false) return avail.reason;
  const value = gutterModule?.blameValue(view.state);
  return value?.status === "unavailable" ? (value.reason ?? "Blame unavailable") : null;
}

// ── status bar chip ─────────────────────────────────────────────────────────

const BLAME_SVG =
  '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 5h3M4 12h3M4 19h3"/><path d="M11 5h9M11 12h6M11 19h8"/></svg>';

const CHIP_CSS = `
.cm-blame-chip { padding: 0 6px; border-radius: 3px; }
.cm-blame-chip[data-on] { color: var(--sol-text); background: color-mix(in srgb, var(--sol-cyan) 14%, transparent); }
.cm-blame-chip[data-state=loading] svg { animation: cm-blame-pulse 1.2s ease-in-out infinite; }
.cm-blame-chip:disabled { opacity: 0.45; cursor: default !important; }
@keyframes cm-blame-pulse { 50% { opacity: 0.35; } }`;
let chipCssAdded = false;

function blameChip(view: EditorView): StatusItemView {
  if (!chipCssAdded && typeof document !== "undefined") {
    chipCssAdded = true;
    const style = document.createElement("style");
    style.textContent = CHIP_CSS;
    document.head.append(style);
  }
  const dom = document.createElement("button");
  dom.type = "button";
  dom.className = "cm-blame-chip";
  dom.innerHTML = BLAME_SVG;
  dom.append(document.createTextNode("Blame"));
  dom.setAttribute("aria-label", "Session blame");
  dom.onmousedown = (e) => e.preventDefault();
  dom.onclick = () => toggleFrom(view);
  let lastStatus: string | undefined;
  const render = () => {
    const reason = blameUnavailableReason(view);
    const status = gutterModule?.blameValue(view.state)?.status;
    lastStatus = status;
    dom.disabled = !!reason;
    dom.toggleAttribute("data-on", gutterOn && !reason);
    dom.setAttribute("aria-pressed", String(gutterOn && !reason));
    if (status === "loading" && gutterOn) dom.dataset.state = "loading";
    else delete dom.dataset.state;
    dom.title = reason ? `Session blame: ${reason}` : status === "loading" && gutterOn ? "Reading blame" : gutterOn ? "Hide session blame" : "Show which session wrote each line";
  };
  render();
  const offGit = useGitStatusStore.subscribe((s, prev) => {
    const id = view.state.facet(featureContext)?.vaultId;
    if (id && s.byVault[id] !== prev.byVault[id]) render();
  });
  const offVault = useVaultStore.subscribe((s, prev) => {
    if (s.endpoint !== prev.endpoint || s.isRemote !== prev.isRemote || s.activeVaultId !== prev.activeVaultId) render();
  });
  toggleListeners.add(render);
  return {
    dom,
    update(u) {
      // Only transitions: the field's status, the file, a reconfiguration.
      const status = gutterModule?.blameValue(u.state)?.status;
      if (status !== lastStatus || u.startState.facet(featureContext) !== u.state.facet(featureContext)) render();
    },
    destroy() {
      offGit();
      offVault();
      toggleListeners.delete(render);
    },
  };
}

function toggleFrom(view: EditorView | undefined): boolean {
  // A file that cannot be blamed keeps the toggle where it is: the chip says why.
  if (view && blameUnavailableReason(view)) return true;
  setBlameGutter(!gutterOn);
  return true;
}

// ── registration ────────────────────────────────────────────────────────────

let registered = false;

export function registerBlameFeature(): void {
  if (registered) return;
  registered = true;
  registerEditorFeature(FEATURE, blameFeature, { needsVault: true });
  registerStatusItem({ id: "blame.toggle", side: "left", order: 25, priority: 25, needsVault: true, create: blameChip });
  registerCodeCommand("blame.toggle", (_args, ctx) => toggleFrom(ctx.view));
  let inline = editorSetting("inlineBlame");
  onEditorSettingsChange(() => {
    const next = editorSetting("inlineBlame");
    if (next === inline) return;
    inline = next;
    reconfigureEditorFeature(FEATURE);
  });
}
