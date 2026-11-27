// A pick list over the editor: document symbols, workspace symbols, code
// actions. Type to filter (fuzzy, or a server query), arrows or Ctrl-n/p to
// move, Enter to take, Escape to leave with the editor as it was. Moving the
// selection can preview (a symbol pick scrolls to it).

import type { EditorView } from "@codemirror/view";
import { fuzzyMatch } from "../../../fuzzyPath";
import { VirtualList, el, highlighted, type ListRow } from "./list";

export interface PickEntry {
  label: string;
  detail?: string;
  /** Right-aligned (a line number, a path). */
  hint?: string;
  kind?: { letter: string; color: string; title?: string };
}

export interface QuickPickOptions<T> {
  placeholder: string;
  /** A fixed list filtered here, or a query answered elsewhere (a server). */
  items: T[] | ((query: string, signal: AbortSignal) => Promise<T[]>);
  entry(item: T): PickEntry;
  onPick(item: T): void;
  onPreview?(item: T | null): void;
  onCancel?(): void;
  /** Shown when nothing matches. */
  empty: string;
  initialQuery?: string;
  /** Pixel offsets inside the editor to open at, instead of the top center. */
  at?: { left: number; top: number };
  maxRows?: number;
}

interface PickRow<T> extends ListRow {
  item: T;
}

let open: { close(cancel: boolean): void } | null = null;

export function closeQuickPick(): boolean {
  if (!open) return false;
  open.close(true);
  return true;
}

export function openQuickPick<T>(view: EditorView, opts: QuickPickOptions<T>): void {
  open?.close(true);
  const root = el("div", "cm-lsp-overlay cm-lsp-pick");
  if (opts.at) {
    Object.assign(root.style, { left: `${opts.at.left}px`, top: `${opts.at.top}px`, transform: "none", width: "min(420px, calc(100% - 24px))" });
  }
  const input = el("input");
  input.placeholder = opts.placeholder;
  input.spellcheck = false;
  input.setAttribute("aria-label", opts.placeholder);
  const empty = el("div", "cm-lsp-empty", opts.empty);
  empty.hidden = true;
  let done = false;
  let controller: AbortController | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const list = new VirtualList<PickRow<T>>({
    maxRows: opts.maxRows ?? 12,
    onSelect: (row) => opts.onPreview?.(row?.item ?? null),
    onActivate: (row) => finish(row.item),
  });

  const rowFor = (item: T, positions?: number[]): PickRow<T> => ({
    item,
    render(dom) {
      const e = opts.entry(item);
      if (e.kind) {
        const k = dom.appendChild(el("span", "cm-lsp-kind", e.kind.letter));
        k.style.color = e.kind.color;
        if (e.kind.title) k.title = e.kind.title;
      }
      dom.append(highlighted(e.label, positions));
      if (e.detail) dom.append(el("span", "cm-lsp-detail", e.detail));
      if (e.hint) dom.append(el("span", "cm-lsp-hint", e.hint));
    },
  });

  const show = (rows: PickRow<T>[], pending = false) => {
    list.setRows(rows);
    empty.hidden = rows.length > 0 || pending;
    if (!rows.length) opts.onPreview?.(null);
  };

  const filterLocal = (items: T[], query: string) => {
    if (!query.trim()) return show(items.map((i) => rowFor(i)));
    const hits: { item: T; score: number; positions: number[]; order: number }[] = [];
    items.forEach((item, order) => {
      const m = fuzzyMatch(opts.entry(item).label, query);
      if (m) hits.push({ item, score: m.score, positions: m.positions, order });
    });
    hits.sort((a, b) => b.score - a.score || a.order - b.order);
    show(hits.map((h) => rowFor(h.item, h.positions)));
  };

  const query = (q: string) => {
    if (Array.isArray(opts.items)) return filterLocal(opts.items, q);
    const ask = opts.items;
    controller?.abort();
    const c = (controller = new AbortController());
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      ask(q, c.signal).then(
        (items) => {
          if (!c.signal.aborted && !done) show(items.map((i) => rowFor(i)));
        },
        () => {
          if (!c.signal.aborted && !done) show([]);
        },
      );
    }, 90);
  };

  const close = (cancel: boolean) => {
    if (done) return;
    done = true;
    controller?.abort();
    if (timer) clearTimeout(timer);
    list.destroy();
    root.remove();
    if (open?.close === close) open = null;
    if (cancel) opts.onCancel?.();
    view.focus();
  };
  const finish = (item: T) => {
    close(false);
    opts.onPick(item);
  };

  input.addEventListener("input", () => query(input.value));
  input.addEventListener("keydown", (e) => {
    const ctrl = e.ctrlKey && !e.metaKey && !e.altKey;
    let handled = true;
    if (e.key === "ArrowDown" || (ctrl && (e.key === "n" || e.key === "j"))) list.move(1);
    else if (e.key === "ArrowUp" || (ctrl && (e.key === "p" || e.key === "k"))) list.move(-1);
    else if (e.key === "PageDown") list.page(1);
    else if (e.key === "PageUp") list.page(-1);
    else if (e.key === "Enter") {
      const row = list.current;
      if (row) finish(row.item);
    } else if (e.key === "Escape") close(true);
    else handled = false;
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  });
  root.addEventListener("focusout", (e) => {
    if (!root.contains(e.relatedTarget as Node | null)) close(true);
  });

  root.append(input, list.dom, empty);
  view.dom.appendChild(root);
  open = { close };
  input.value = opts.initialQuery ?? "";
  if (!Array.isArray(opts.items)) show([], true);
  query(input.value);
  input.focus();
  input.select();
}
