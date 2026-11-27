// The two status bar items language features add: the diagnostics counts for
// the folder (click: the problems list) and the server chip for this file's
// language (click: a card with the server, its root, and Restart). Both write
// their own DOM from subscriptions; a keystroke never reaches them.

import type { EditorView } from "@codemirror/view";
import { featureContext, liveStatusItem, type StatusItemView } from "../../features";
import { subscribeLspState, restartLsp, retryLsp, lspServerDetails, lspClientsFor, onLspPoolChange, type LspPoolState } from "../pool";
import { chipDetail, chipStatus, leadTask, type LspChipStatus } from "../progress";
import { countDiagnostics, onVaultDiagnostics, vaultDiagnostics, type FileDiagnostics } from "../diagnostics";
import { uriToFsPath, uriKey } from "../uri";
import { closePeek, peekShown, showPeek, type PeekRow } from "./peek";
import { el } from "./list";
import { openVaultFile, showOutside } from "../host";
import { pluginOf } from "../navigation";

// ── server chip ─────────────────────────────────────────────────────────────

const LABEL: Record<LspChipStatus, string> = {
  idle: "Starts when needed",
  starting: "Starting",
  indexing: "Indexing",
  ready: "Ready",
  unresponsive: "Not responding",
  restarting: "Restarting after a crash",
  unavailable: "Not installed",
  crashed: "Crashed",
  offline: "No daemon",
  off: "Off for files over 1.5 MB",
};

/** The open server card, and the editor it belongs to. */
let openCard: { view: EditorView; close: () => void } | null = null;
const closeCardOf = (view: EditorView) => {
  if (openCard?.view === view) openCard.close();
};

function showCard(view: EditorView, anchor: HTMLElement, vaultId: string, state: LspPoolState, status: LspChipStatus): void {
  openCard?.close();
  const card = el("div", "cm-lsp-overlay cm-lsp-card");
  const box = view.dom.getBoundingClientRect();
  const at = anchor.getBoundingClientRect();
  card.style.left = `${Math.max(8, Math.min(at.left - box.left, box.width - 308))}px`;
  const details = state.serverId ? lspServerDetails(vaultId, state.serverId) : null;
  const server = state.server ?? details?.server;
  const grid = el("dl", "cm-lsp-card-grid");
  const row = (k: string, v: string | undefined, title?: string) => {
    if (!v) return;
    grid.append(el("dt", undefined, k));
    // The value is cut from the left (direction: rtl, for a path's tail);
    // the marks keep its slashes where they belong.
    const dd = grid.appendChild(el("dd", undefined, `\u200E${v}\u200E`));
    dd.title = title ?? v;
  };
  row("Server", server?.name ?? state.serverId);
  row("Status", LABEL[status]);
  const task = state.tasks ? leadTask(state.tasks) : null;
  if (task) row("Working", [task.title, task.message, task.percentage !== undefined ? `${Math.round(task.percentage)}%` : ""].filter(Boolean).join(" · "));
  const rootUri = state.rootUri ?? details?.rootUri;
  row("Root", rootUri ? (uriToFsPath(rootUri) ?? rootUri) : undefined);
  row("Binary", server?.command);
  if (state.reason && status !== "ready" && status !== "indexing") row("Reason", state.reason);
  card.append(grid);
  if (status === "unavailable" && state.installHint) card.append(el("div", "cm-lsp-card-hint", state.installHint));

  const actions = el("div", "cm-lsp-card-actions");
  const button = (label: string, run: () => void) => {
    const b = actions.appendChild(el("button", undefined, label));
    b.type = "button";
    b.onclick = () => {
      run();
      close();
      view.focus();
    };
  };
  if (state.serverId) {
    if (status === "unavailable" || status === "crashed" || status === "offline") button("Try again", () => retryLsp(vaultId, state.serverId!));
    else if (status !== "idle") button("Restart", () => restartLsp(vaultId, state.serverId!));
  }
  if (status === "unavailable" && state.installHint) {
    const cmd = state.installHint.replace(/^[^:]*:\s*/, "");
    button("Copy install command", () => void navigator.clipboard?.writeText(cmd).catch(() => {}));
  }
  if (actions.childElementCount) card.append(actions);

  const onDown = (e: MouseEvent) => {
    if (!card.contains(e.target as Node) && !anchor.contains(e.target as Node)) close();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
      view.focus();
    }
  };
  const close = () => {
    card.remove();
    document.removeEventListener("mousedown", onDown, true);
    document.removeEventListener("keydown", onKey, true);
    if (openCard?.close === close) openCard = null;
  };
  document.addEventListener("mousedown", onDown, true);
  document.addEventListener("keydown", onKey, true);
  openCard = { view, close };
  view.dom.appendChild(card);
}

export function serverChip(view: EditorView): StatusItemView | null {
  const dom = el("button", "cm-lsp-chip");
  dom.type = "button";
  const dot = el("span", "cm-lsp-chip-dot");
  const name = document.createTextNode("");
  const detail = el("span", "cm-lsp-chip-detail");
  dom.append(dot, name, detail);
  let current: { vaultId: string; state: LspPoolState; status: LspChipStatus } | null = null;
  dom.onclick = () => {
    if (!current) return;
    if (openCard?.view === view) return openCard.close();
    showCard(view, dom, current.vaultId, current.state, current.status);
  };
  const render = (vaultId: string, state: LspPoolState, status: LspChipStatus) => {
    current = { vaultId, state, status };
    // No server for this language at all: nothing to say.
    dom.hidden = status === "unavailable" && !state.serverId;
    dom.dataset.status = status;
    const label = state.server?.name ?? (state.serverId ? (lspServerDetails(vaultId, state.serverId)?.server.name ?? state.serverId) : "");
    // The bar names the file's language already: a server of the same name
    // shows its dot and state only (the title still names it).
    const shown = label === view.state.facet(featureContext)?.languageName ? "" : label;
    if (name.nodeValue !== shown) name.nodeValue = shown;
    const d = chipDetail(status, state.tasks ?? new Map());
    if (detail.textContent !== d) detail.textContent = d;
    detail.hidden = !d;
    dom.title = `${label}: ${LABEL[status]}`;
  };
  // The card describes one file's server: it goes when the editor shows
  // another file (a tab switch rebuilds the status bar) or reconfigures.
  const item = liveStatusItem(dom, () => {
    closeCardOf(view);
    const ctx = view.state.facet(featureContext);
    if (!ctx || ctx.only || ctx.languageId === "plaintext") {
      dom.hidden = true;
      return null;
    }
    if (ctx.largeFile) {
      render(ctx.vaultId, { status: "idle", serverId: undefined }, "off");
      dom.hidden = false;
      return null;
    }
    return subscribeLspState(ctx.vaultId, ctx.languageId, (state) => render(ctx.vaultId, state, chipStatus(state.status, state.tasks ?? new Map(), state.unresponsive)));
  });
  return {
    ...item,
    destroy() {
      closeCardOf(view);
      item.destroy?.();
    },
  };
}

// ── diagnostics counts and the problems list ────────────────────────────────

const SEV_CLASS = ["", "error", "warning", "info", "hint"];

// lucide's circle-x, triangle-alert and info, and a dot for hints: the icon
// set the app chrome draws, sized to the status bar's text.
const SEV_PATHS = [
  "",
  '<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/>',
  '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
  '<circle cx="12" cy="12" r="3" fill="currentColor"/>',
];
const sevTemplates: (SVGElement | null)[] = [];
/** A severity icon, built once and cloned. */
function sevIcon(sev: number): SVGElement {
  let t = sevTemplates[sev];
  if (!t) {
    const holder = document.createElement("span");
    holder.innerHTML = `<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${SEV_PATHS[sev] ?? SEV_PATHS[1]}</svg>`;
    t = sevTemplates[sev] = holder.firstElementChild as SVGElement;
  }
  return t.cloneNode(true) as SVGElement;
}

function problemRows(view: EditorView, vaultId: string): PeekRow[] {
  const here = (() => {
    const p = pluginOf(view);
    return p ? uriKey(p.uri) : null;
  })();
  const files = [...vaultDiagnostics(vaultId).entries()].sort(([a, fa], [b, fb]) => (a === here ? -1 : b === here ? 1 : fa.path.localeCompare(fb.path)));
  const rows: PeekRow[] = [];
  for (const [key, f] of files) {
    rows.push({ group: true, render: (dom) => dom.append(el("span", "cm-lsp-label", f.path), el("span", "cm-lsp-hint", String(f.items.length))) });
    const items = [...f.items].sort((a, b) => (a.severity ?? 1) - (b.severity ?? 1) || a.range.start.line - b.range.start.line);
    for (const d of items) {
      const sev = d.severity ?? 1;
      rows.push({
        open: () => openProblem(view, key === here, f, d.range.start),
        render: (dom) => {
          dom.appendChild(el("span", `cm-lsp-kind cm-lsp-sev-${SEV_CLASS[sev]}`)).append(sevIcon(sev));
          dom.append(el("span", "cm-lsp-label", d.message.split("\n")[0]));
          if (d.source || d.code !== undefined) dom.append(el("span", "cm-lsp-detail", [d.source, d.code].filter((x) => x !== undefined && x !== "").join(" ")));
          dom.append(el("span", "cm-lsp-hint", `${d.range.start.line + 1}:${d.range.start.character + 1}`));
        },
      });
    }
  }
  return rows;
}

function openProblem(view: EditorView, sameFile: boolean, f: FileDiagnostics, pos: { line: number; character: number }): void {
  const plugin = pluginOf(view);
  if (sameFile && plugin) {
    const at = plugin.fromPosition(pos);
    view.dispatch({ selection: { anchor: at }, scrollIntoView: true });
    view.focus();
  } else if (f.inside) openVaultFile(f.path, pos);
  else showOutside(view, { inside: false, absPath: f.path }, pos);
}

function countLabel(vaultId: string): string {
  const c = countDiagnostics(vaultDiagnostics(vaultId).values());
  const n = (k: number, word: string) => `${k} ${word}${k === 1 ? "" : "s"}`;
  return `${n(c.errors, "error")} · ${n(c.warnings, "warning")}`;
}

export function toggleProblems(view: EditorView): boolean {
  const ctx = view.state.facet(featureContext);
  if (!ctx) return false;
  if (peekShown(view) === "problems") return closePeek(view);
  showPeek(view, {
    id: "problems",
    title: "Problems",
    count: countLabel(ctx.vaultId),
    countNow: () => countLabel(ctx.vaultId),
    rows: () => problemRows(view, ctx.vaultId),
    watch: (refresh) => onVaultDiagnostics(ctx.vaultId, refresh),
  });
  return true;
}

export function diagnosticsItem(view: EditorView): StatusItemView | null {
  const dom = el("button", "cm-lsp-counts");
  dom.type = "button";
  dom.title = "Problems";
  const errors = el("span", "cm-lsp-sev-error");
  const warnings = el("span", "cm-lsp-sev-warning");
  const eN = document.createTextNode("0");
  const wN = document.createTextNode("0");
  errors.append(sevIcon(1), eN);
  warnings.append(sevIcon(2), wN);
  dom.append(errors, warnings);
  dom.onclick = () => toggleProblems(view);
  return liveStatusItem(dom, () => {
    const ctx = view.state.facet(featureContext);
    // A document that is not one file (the search results editor) runs no
    // language server, and its theme with it.
    if (!ctx || ctx.only) {
      dom.hidden = true;
      return null;
    }
    const render = () => {
      // Only while a server runs for this folder or has said something: a
      // folder with none would read zero forever.
      const files = vaultDiagnostics(ctx.vaultId);
      dom.hidden = files.size === 0 && lspClientsFor(ctx.vaultId).length === 0;
      if (dom.hidden) return;
      const c = countDiagnostics(files.values());
      eN.nodeValue = String(c.errors);
      wN.nodeValue = String(c.warnings);
      errors.toggleAttribute("data-zero", c.errors === 0);
      warnings.toggleAttribute("data-zero", c.warnings === 0);
      dom.title = `${c.errors} errors, ${c.warnings} warnings`;
    };
    render();
    const offDiagnostics = onVaultDiagnostics(ctx.vaultId, render);
    // The pool changes on every progress report; only a server starting or
    // going can change what this shows.
    const offPool = onLspPoolChange(() => {
      if ((vaultDiagnostics(ctx.vaultId).size === 0 && lspClientsFor(ctx.vaultId).length === 0) !== dom.hidden) render();
    });
    return () => {
      offDiagnostics();
      offPool();
    };
  });
}
