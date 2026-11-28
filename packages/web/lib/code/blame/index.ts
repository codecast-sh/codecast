// Session blame in the code editor: which codecast session wrote each line.
// `blame.toggle` (the status bar chip, `:Git blame`, `:Gblame`, the palette)
// shows the gutter in every editor; Settings > Editor > Inline blame puts the
// cursor line's origin at its end. Register once with registerBlameFeature().
//
// This module is small and rides the editor chunk. The gutter, the inline
// text and the fetch (gutter.ts) load the first time either turns on.

import { EditorView } from "@codemirror/view";
import type { EditorState } from "@codemirror/state";
import type { CodeBlameHunk } from "@codecast/shared/contracts";
import { useVaultStore } from "../../../store/vaultStore";
import { registerCodeCommand } from "../commands";
import { editorSetting, onEditorSettingsChange } from "../editorSettings";
import { featureContext, reconfigureEditorFeature, registerEditorFeature, registerStatusItem, type EditorFeatureContext, type StatusItemView } from "../features";
import { useGitStatusStore } from "../git/status";
import { blameAvailability } from "./data";
import { blameGutterStandIn } from "../gutterSlots";
import { lineIcon } from "../icons";

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

/** The blame an editor holds, once its gutter or inline blame has read it. */
export function blameHunksOf(state: EditorState): readonly CodeBlameHunk[] {
  return gutterModule?.blameValue(state)?.hunks ?? [];
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
  // The chip's look rides along even when blame is off: it is always shown.
  if (!opts.gutter && !opts.inline) return chipTheme;
  if (gutterModule) return [chipTheme, gutterModule.blameExtension(opts)];
  return loadGutter().then((m) => [chipTheme, m.blameExtension(opts)]);
}

/** Why the file in `view` cannot be blamed, or null when it can (or may).
 *  A failure that may pass (the daemon away, a timeout) is not a reason: the
 *  gutter asks again on its own, and blameRetryReason says what it waits on. */
export function blameUnavailableReason(view: EditorView): string | null {
  const ctx = view.state.facet(featureContext);
  if (!ctx) return "No file";
  const avail = blameAvailability(ctx.vaultId);
  if (avail.ok === false) return avail.reason;
  const value = gutterModule?.blameValue(view.state);
  return value?.status === "unavailable" && !value.transient ? (value.reason ?? "Blame unavailable") : null;
}

/** The passing failure the gutter is retrying after, or null. */
export function blameRetryReason(view: EditorView): string | null {
  const value = gutterModule?.blameValue(view.state);
  if (!value) return null;
  if (value.status === "unavailable" && value.transient) return value.reason ?? null;
  return value.retry ?? null;
}

// ── status bar chip ─────────────────────────────────────────────────────────

const BLAME_ICON = '<path d="M4 5h3M4 12h3M4 19h3"/><path d="M11 5h9M11 12h6M11 19h8"/>';

const chipTheme = EditorView.theme({
  ".cm-blame-chip": { padding: "0 6px", borderRadius: "3px" },
  ".cm-blame-chip[data-on]": { color: "var(--sol-text)", background: "color-mix(in srgb, var(--sol-cyan) 14%, transparent)" },
  ".cm-blame-chip[data-state=loading] svg": { animation: "cm-blame-pulse 1.2s ease-in-out infinite" },
  ".cm-blame-chip[data-state=retry] svg": { color: "var(--sol-yellow)" },
  ".cm-blame-chip:disabled": { opacity: "0.45", cursor: "default" },
  "@keyframes cm-blame-pulse": { "50%": { opacity: "0.35" } },
});

function blameChip(view: EditorView): StatusItemView {
  const dom = document.createElement("button");
  dom.type = "button";
  dom.className = "cm-blame-chip";
  dom.append(lineIcon(BLAME_ICON));
  dom.append(document.createTextNode("Blame"));
  dom.setAttribute("aria-label", "Session blame");
  dom.onmousedown = (e) => e.preventDefault();
  dom.onclick = () => toggleFrom(view);
  let lastSig: string | undefined;
  const sigOf = (state: typeof view.state) => {
    const v = gutterModule?.blameValue(state);
    return `${v?.status}|${v?.transient ? 1 : 0}|${v?.retry ?? ""}`;
  };
  const render = () => {
    // Blame that is on can always be turned off; only turning it on waits
    // for a file that can be blamed.
    const reason = blameUnavailableReason(view);
    const retry = blameRetryReason(view);
    const status = gutterModule?.blameValue(view.state)?.status;
    lastSig = sigOf(view.state);
    const on = gutterOn && !reason;
    dom.disabled = !!reason && !gutterOn;
    dom.toggleAttribute("data-on", on);
    dom.setAttribute("aria-pressed", String(on));
    if (gutterOn && retry) dom.dataset.state = "retry";
    else if (status === "loading" && gutterOn) dom.dataset.state = "loading";
    else delete dom.dataset.state;
    dom.title = reason
      ? gutterOn
        ? `Session blame: ${reason}. Click to hide`
        : `Session blame: ${reason}`
      : gutterOn && retry
        ? `Session blame: ${retry}, retrying. Click to hide`
        : status === "loading" && gutterOn
          ? "Reading blame"
          : gutterOn
            ? "Hide session blame"
            : "Show which session wrote each line";
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
      if (sigOf(u.state) !== lastSig || u.startState.facet(featureContext) !== u.state.facet(featureContext)) render();
    },
    destroy() {
      offGit();
      offVault();
      toggleListeners.delete(render);
    },
  };
}

function toggleFrom(view: EditorView | undefined): boolean {
  // Off is always allowed. On waits for a file that can be blamed: the
  // chip, disabled, says why.
  if (!gutterOn && view && blameUnavailableReason(view)) return true;
  setBlameGutter(!gutterOn);
  return true;
}

// ── registration ────────────────────────────────────────────────────────────

let registered = false;

export function registerBlameFeature(): void {
  if (registered) return;
  registered = true;
  registerEditorFeature(FEATURE, blameFeature, { needsVault: true, placeholder: () => (gutterOn ? [chipTheme, blameGutterStandIn] : null) });
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
