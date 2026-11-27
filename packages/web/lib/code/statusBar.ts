// The status bar under the editor, as a CodeMirror panel. Its live segments
// (cursor position, selection, the unsaved dot) change on keystrokes, so they
// are text nodes this panel writes directly: React never hears about a cursor
// move (contract 1). Static segments are read from the state's facets, so a
// reconfigured indent or a swapped buffer shows itself without a prop.
// Features add segments with registerStatusItem (features.ts).

import { countColumn, type EditorState, type Extension } from "@codemirror/state";
import { EditorView, showPanel, type Panel, type ViewUpdate } from "@codemirror/view";
import { indentUnit, getIndentUnit } from "@codemirror/language";
import { gotoLine } from "@codemirror/search";
import { fileFormatField, isDirty, savedDocField } from "./buffers";
import { featureContext, onStatusItemsChanged, registeredStatusItems, vaultBacked, type StatusItemView } from "./features";
import { runCodeCommand } from "./commands";
import { EDITOR_FONT } from "./theme";

const LOCK_SVG =
  '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>';

/** A segment whose text the panel rewrites in place. */
class LiveText {
  readonly dom: HTMLElement;
  private readonly node: Text;
  constructor(className: string) {
    this.dom = document.createElement("span");
    this.dom.className = className;
    this.node = document.createTextNode("");
    this.dom.append(this.node);
  }
  set(text: string): void {
    if (this.node.nodeValue !== text) this.node.nodeValue = text;
    this.dom.hidden = text === "";
  }
}

/** Past this offset into a line (a minified bundle, a one-line JSON) the
 *  column is counted in characters: expanding tabs would scan the line on
 *  every cursor move. */
const TAB_SCAN_LIMIT = 10_000;

export function cursorLabel(state: EditorState): string {
  const { main, ranges } = state.selection;
  if (ranges.length > 1) return `${ranges.length} selections`;
  const line = state.doc.lineAt(main.head);
  const offset = main.head - line.from;
  // Tabs widen only what precedes the last one; the rest is one column a character.
  const lastTab = offset === 0 || offset > TAB_SCAN_LIMIT ? -1 : line.text.lastIndexOf("\t", offset - 1);
  const col = lastTab < 0 ? offset : countColumn(line.text.slice(0, lastTab + 1), state.tabSize) + offset - lastTab - 1;
  return `Ln ${line.number}, Col ${col + 1}`;
}

export function selectionLabel(state: EditorState): string {
  const { main, ranges } = state.selection;
  if (ranges.length > 1 || main.empty) return "";
  const chars = main.to - main.from;
  const lines = state.doc.lineAt(main.to).number - state.doc.lineAt(main.from).number + 1;
  return lines > 1 ? `(${lines} lines, ${chars} selected)` : `(${chars} selected)`;
}

export function indentStatusLabel(state: EditorState): string {
  const unit = state.facet(indentUnit);
  return unit === "\t" ? `Tab Size: ${state.tabSize}` : `Spaces: ${getIndentUnit(state)}`;
}

function staticSegments(state: EditorState): string[] {
  const format = state.field(fileFormatField);
  return [
    indentStatusLabel(state),
    format.lineSeparator === "\r\n" ? "CRLF" : "LF",
    format.lossy ? "Unknown encoding" : format.bom ? "UTF-8 with BOM" : "UTF-8",
    state.facet(featureContext)?.languageName ?? "Plain Text",
  ];
}

/** Gap between status segments, and the bar's side padding, in px. */
const STATUS_GAP = 12;
const STATUS_PAD = 20;
export const DEFAULT_STATUS_PRIORITY = 50;

/** The order a narrow bar drops segments in: lowest priority first, the
 *  later one first between equals. */
export function dropOrder(priorities: readonly number[]): number[] {
  return priorities.map((p, i) => ({ p, i })).sort((a, b) => a.p - b.p || b.i - a.i).map((x) => x.i);
}

function createStatusPanel(view: EditorView): Panel {
  const dom = document.createElement("div");
  dom.className = "cm-code-status";
  const left = document.createElement("div");
  left.className = "cm-code-status-side";
  const right = document.createElement("div");
  right.className = "cm-code-status-side cm-code-status-right";
  dom.append(left, right);

  const lock = document.createElement("span");
  lock.className = "cm-code-status-lock";
  lock.innerHTML = `${LOCK_SVG}<span>Read-only</span>`;
  const dirty = new LiveText("cm-code-status-dirty");
  dirty.dom.title = "Unsaved changes";

  const cursor = document.createElement("button");
  cursor.type = "button";
  cursor.className = "cm-code-status-item";
  const cursorText = new LiveText("");
  const selection = new LiveText("cm-code-status-dim");
  cursor.append(cursorText.dom, selection.dom);
  cursor.onclick = () => {
    if (!runCodeCommand("goto.line", undefined, { view, source: "menu" })) gotoLine(view);
  };
  const statics = new LiveText("cm-code-status-static");

  let plugins: StatusItemView[] = [];
  /** Segments a narrow bar may drop, with what each is worth. */
  let droppable: { el: HTMLElement; priority: number }[] = [];
  // Measured on a resize or a reconfiguration, never on a keystroke.
  let fitFrame = 0;
  const fit = () => {
    fitFrame = 0;
    const avail = dom.clientWidth;
    if (!avail) return;
    for (const d of droppable) delete d.el.dataset.dropped;
    const overflows = () => left.scrollWidth + right.scrollWidth + STATUS_GAP + STATUS_PAD > avail;
    for (const i of dropOrder(droppable.map((d) => d.priority))) {
      if (!overflows()) break;
      if (!droppable[i].el.hidden) droppable[i].el.dataset.dropped = "";
    }
  };
  const scheduleFit = () => {
    if (!fitFrame && typeof requestAnimationFrame === "function") fitFrame = requestAnimationFrame(fit);
  };
  const resize = typeof ResizeObserver === "function" ? new ResizeObserver(scheduleFit) : null;
  resize?.observe(dom);

  /** What the items were mounted for: vault-backed ones only for a real vault. */
  let realVault = true;
  const mountItems = () => {
    for (const p of plugins) {
      p.destroy?.();
      p.dom.remove();
      resize?.unobserve(p.dom);
    }
    plugins = [];
    droppable = [
      { el: cursor, priority: 90 },
      { el: selection.dom, priority: 30 },
      { el: statics.dom, priority: 30 },
    ];
    realVault = vaultBacked(view.state.facet(featureContext));
    for (const item of registeredStatusItems()) {
      if (item.needsVault && !realVault) continue;
      const v = item.create(view);
      if (!v) continue;
      v.dom.classList.add("cm-code-status-item");
      (item.side === "left" ? left : right).append(v.dom);
      plugins.push(v);
      droppable.push({ el: v.dom, priority: item.priority ?? DEFAULT_STATUS_PRIORITY });
      // Items fill in after they mount (a server's state, a count): a change
      // in their size fits again. The cursor segment is left out, so typing
      // never sets this off.
      resize?.observe(v.dom);
    }
    right.append(cursor, statics.dom);
    resize?.observe(statics.dom);
    scheduleFit();
  };

  let labelLength = -1;
  const render = (state: EditorState, u: { doc: boolean; selection: boolean; saved: boolean; config: boolean }) => {
    if (u.doc || u.saved || u.config) dirty.set(isDirty(state) ? "●" : "");
    if (u.doc || u.selection || u.config) {
      const c = cursorLabel(state);
      const sel = selectionLabel(state);
      // A label that gains a character (Ln 99 to Ln 100) may push the bar
      // past its width: fit again. Comparing lengths reads no layout, and the
      // length changes only when a number gains or loses a digit.
      if (c.length + sel.length !== labelLength) {
        labelLength = c.length + sel.length;
        scheduleFit();
      }
      cursorText.set(c);
      selection.set(sel);
    }
    if (u.config) {
      statics.set(staticSegments(state).join("   "));
      lock.hidden = !state.readOnly;
      // Items rebind on a reconfiguration and may change width with it.
      scheduleFit();
    }
  };

  left.append(lock, dirty.dom);
  mountItems();
  render(view.state, { doc: true, selection: true, saved: true, config: true });
  const stopItems = onStatusItemsChanged(mountItems);

  return {
    dom,
    top: false,
    update(u: ViewUpdate) {
      const { startState: a, state: b } = u;
      // The static segments change only on reconfiguration; a keystroke
      // compares five references and reads nothing else.
      const config =
        a.field(fileFormatField) !== b.field(fileFormatField) ||
        a.facet(indentUnit) !== b.facet(indentUnit) ||
        a.tabSize !== b.tabSize ||
        a.readOnly !== b.readOnly ||
        a.facet(featureContext) !== b.facet(featureContext);
      // A save moves the saved version, not the document.
      const saved = a.field(savedDocField) !== b.field(savedDocField);
      if (u.docChanged || u.selectionSet || saved || config) {
        render(b, { doc: u.docChanged, selection: u.selectionSet, saved, config });
      }
      if (config && vaultBacked(b.facet(featureContext)) !== realVault) mountItems();
      for (const p of plugins) p.update?.(u);
    },
    destroy() {
      stopItems();
      resize?.disconnect();
      if (fitFrame) cancelAnimationFrame(fitFrame);
      for (const p of plugins) p.destroy?.();
    },
  };
}

const statusTheme = EditorView.theme({
  ".cm-code-status": {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: `${STATUS_GAP}px`,
    height: "24px",
    padding: "0 10px",
    fontFamily: EDITOR_FONT,
    fontSize: "11px",
    color: "var(--sol-text-dim)",
    userSelect: "none",
    whiteSpace: "nowrap",
  },
  ".cm-code-status-side": { display: "flex", alignItems: "center", gap: `${STATUS_GAP}px`, minWidth: "0", flex: "0 1 auto", overflow: "hidden" },
  ".cm-code-status-side > *": { flexShrink: "0" },
  // What is left still never spills: the file format truncates.
  ".cm-code-status-side > .cm-code-status-static": { flexShrink: "1", minWidth: "0", overflow: "hidden", textOverflow: "ellipsis" },
  ".cm-code-status [data-dropped]": { display: "none !important" },
  ".cm-code-status-item": {
    display: "inline-flex",
    alignItems: "center",
    gap: "6px",
    background: "none",
    border: "none",
    padding: "0",
    font: "inherit",
    color: "inherit",
    cursor: "default",
  },
  "button.cm-code-status-item": { cursor: "pointer" },
  "button.cm-code-status-item:hover": { color: "var(--sol-text)" },
  ".cm-code-status-dim": { opacity: "0.75" },
  ".cm-code-status-static": { whiteSpace: "pre" },
  ".cm-code-status-dirty": { color: "var(--sol-yellow)", fontSize: "10px" },
  ".cm-code-status-lock": { display: "inline-flex", alignItems: "center", gap: "4px", color: "var(--sol-text-muted)" },
  ".cm-code-status-lock[hidden], .cm-code-status [hidden]": { display: "none" },
  // Vim's mode chip (vimFeature.ts): one color per mode, as vim statuslines do.
  ".cm-vim-mode": {
    padding: "0 6px",
    borderRadius: "3px",
    fontWeight: "600",
    letterSpacing: "0.04em",
    color: "var(--vim-mode, var(--sol-text-dim))",
    background: "color-mix(in srgb, var(--vim-mode, transparent) 16%, transparent)",
  },
  ".cm-vim-mode[data-mode=normal], .cm-vim-mode[data-mode=op-pending]": { "--vim-mode": "var(--sol-blue)" },
  ".cm-vim-mode[data-mode=insert]": { "--vim-mode": "var(--sol-green)" },
  ".cm-vim-mode[data-mode^=visual]": { "--vim-mode": "var(--sol-magenta)" },
  ".cm-vim-mode[data-mode=replace]": { "--vim-mode": "var(--sol-red)" },
  ".cm-vim-mode[data-mode=off]": { fontWeight: "400", letterSpacing: "0" },
  // Keys vim holds toward a command (vimFeature.ts showcmd).
  ".cm-vim-showcmd": { color: "var(--sol-text)", whiteSpace: "pre", minWidth: "0" },
});

export function statusBar(): Extension {
  return [showPanel.of(createStatusPanel), statusTheme];
}
