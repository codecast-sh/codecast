// A compact list under the editor: references (Shift-F12, `gr`) and problems
// (the diagnostics count). One at a time per editor; Escape or × closes it,
// arrows move, Enter or a click goes to the row. The list lives in the
// buffer's state, so it comes back with the tab. It sits above the status bar
// (Prec.high orders it before the bar among the bottom panels).

import { Prec, StateEffect, StateField } from "@codemirror/state";
import { showPanel, type EditorView, type Panel } from "@codemirror/view";
import { VirtualList, el, type ListRow } from "./list";

export interface PeekRow extends ListRow {
  /** Go to what the row names. */
  open?(): void;
}

export interface PeekSpec {
  id: string;
  title: string;
  /** Beside the title: "12 in 3 files", "4 · 9". */
  count: string;
  /** Called each time the panel is drawn (and again when `refresh` asks), so
   *  rows can reflect live data. */
  rows(): PeekRow[];
  /** Subscribe to changes; return the unsubscribe. */
  watch?(refresh: () => void): () => void;
  /** Recomputed with the rows. */
  countNow?(): string;
}

const setPeek = StateEffect.define<PeekSpec | null>();

const peekField = StateField.define<PeekSpec | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setPeek)) value = e.value;
    return value;
  },
  provide: (f) => showPanel.from(f, (spec) => (spec ? (view) => createPeek(view, spec) : null)),
});

function createPeek(view: EditorView, spec: PeekSpec): Panel {
  const dom = el("div", "cm-lsp-peek");
  dom.tabIndex = -1;
  const head = el("div", "cm-lsp-peek-head");
  const count = el("span", "cm-lsp-peek-count", spec.count);
  const close = el("button", "cm-lsp-peek-close", "×");
  close.type = "button";
  close.setAttribute("aria-label", `Close ${spec.title}`);
  close.onclick = () => closePeek(view);
  head.append(el("span", "cm-lsp-peek-title", spec.title), count, close);
  const list = new VirtualList<PeekRow>({ maxRows: 8, onActivate: (row) => row.open?.() });
  dom.append(head, list.dom);
  const refresh = () => {
    list.setRows(spec.rows());
    if (spec.countNow) count.textContent = spec.countNow();
  };
  dom.addEventListener("keydown", (e) => {
    let handled = true;
    if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n") || e.key === "j") list.move(1);
    else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p") || e.key === "k") list.move(-1);
    else if (e.key === "Enter") list.current?.open?.();
    else if (e.key === "Escape") {
      closePeek(view);
      view.focus();
    } else handled = false;
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  });
  let unwatch: (() => void) | undefined;
  return {
    dom,
    top: false,
    mount() {
      refresh();
      unwatch = spec.watch?.(refresh);
      dom.focus();
    },
    destroy() {
      unwatch?.();
      list.destroy();
    },
  };
}

/** Show a list under the editor, replacing the one there. */
export function showPeek(view: EditorView, spec: PeekSpec): void {
  const effects: StateEffect<unknown>[] =
    view.state.field(peekField, false) === undefined ? [StateEffect.appendConfig.of(Prec.high(peekField.init(() => spec)))] : [setPeek.of(spec)];
  view.dispatch({ effects });
}

export function peekShown(view: EditorView): string | null {
  return view.state.field(peekField, false)?.id ?? null;
}

export function closePeek(view: EditorView): boolean {
  if (!view.state.field(peekField, false)) return false;
  view.dispatch({ effects: setPeek.of(null) });
  return true;
}
