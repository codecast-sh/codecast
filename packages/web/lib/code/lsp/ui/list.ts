// A keyboard-driven list of fixed-height rows that draws only the rows in
// view, for symbol picks and reference lists that can run to thousands. Plain
// DOM: the quick pick and the peek panel own one each.

export const ROW_HEIGHT = 24;

export interface ListRow {
  /** Group header rows (a file name) are drawn but never selected. */
  group?: boolean;
  render(dom: HTMLElement): void;
}

export class VirtualList<R extends ListRow> {
  readonly dom: HTMLDivElement;
  private readonly spacer: HTMLDivElement;
  private rows: R[] = [];
  private selected = -1;
  private drawn = new Map<number, HTMLElement>();
  private frame = 0;

  constructor(
    private readonly opts: { maxRows: number; onSelect?: (row: R | null) => void; onActivate: (row: R) => void },
  ) {
    this.dom = document.createElement("div");
    this.dom.className = "cm-lsp-list";
    this.dom.setAttribute("role", "listbox");
    this.spacer = document.createElement("div");
    this.dom.append(this.spacer);
    this.dom.addEventListener("scroll", () => this.schedule());
    this.dom.addEventListener("mousedown", (e) => e.preventDefault());
    this.dom.addEventListener("click", (e) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>("[data-index]");
      if (!el) return;
      const i = Number(el.dataset.index);
      if (this.rows[i]?.group) return;
      this.select(i);
      this.opts.onActivate(this.rows[i]);
    });
  }

  get current(): R | null {
    return this.rows[this.selected] ?? null;
  }

  get length(): number {
    return this.rows.length;
  }

  setRows(rows: R[], select = rows.findIndex((r) => !r.group)): void {
    this.rows = rows;
    for (const el of this.drawn.values()) el.remove();
    this.drawn.clear();
    this.spacer.style.height = `${rows.length * ROW_HEIGHT}px`;
    this.dom.style.height = `${Math.min(rows.length, this.opts.maxRows) * ROW_HEIGHT}px`;
    this.selected = -1;
    this.dom.scrollTop = 0;
    this.select(select);
    this.draw();
  }

  select(i: number): void {
    if (i < 0 || i >= this.rows.length || this.rows[i].group) {
      if (this.selected !== -1 && i === -1) this.selected = -1;
      return;
    }
    const prev = this.drawn.get(this.selected);
    prev?.setAttribute("aria-selected", "false");
    this.selected = i;
    this.drawn.get(i)?.setAttribute("aria-selected", "true");
    const top = i * ROW_HEIGHT;
    if (top < this.dom.scrollTop) this.dom.scrollTop = top;
    else if (top + ROW_HEIGHT > this.dom.scrollTop + this.dom.clientHeight) this.dom.scrollTop = top + ROW_HEIGHT - this.dom.clientHeight;
    this.opts.onSelect?.(this.rows[i]);
    this.schedule();
  }

  /** Step the selection, skipping group rows and wrapping. */
  move(by: number): void {
    const n = this.rows.length;
    if (!n) return;
    let i = this.selected;
    for (let step = 0; step < n; step++) {
      i = by > 0 ? Math.min(n - 1, i + by) : Math.max(0, i + by);
      if (!this.rows[i].group) return this.select(i);
      if ((by > 0 && i === n - 1) || (by < 0 && i === 0)) break;
      by = Math.sign(by);
    }
  }

  page(dir: 1 | -1): void {
    this.move(dir * Math.max(1, this.opts.maxRows - 1));
  }

  private schedule(): void {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.draw();
    });
  }

  private draw(): void {
    const height = this.dom.clientHeight || this.opts.maxRows * ROW_HEIGHT;
    const first = Math.max(0, Math.floor(this.dom.scrollTop / ROW_HEIGHT) - 4);
    const last = Math.min(this.rows.length, Math.ceil((this.dom.scrollTop + height) / ROW_HEIGHT) + 4);
    for (const [i, el] of this.drawn) {
      if (i < first || i >= last) {
        el.remove();
        this.drawn.delete(i);
      }
    }
    for (let i = first; i < last; i++) {
      if (this.drawn.has(i)) continue;
      const row = this.rows[i];
      const el = document.createElement("div");
      el.className = row.group ? "cm-lsp-row cm-lsp-row-group" : "cm-lsp-row";
      el.dataset.index = String(i);
      el.style.top = `${i * ROW_HEIGHT}px`;
      el.setAttribute("role", row.group ? "presentation" : "option");
      if (!row.group) el.setAttribute("aria-selected", String(i === this.selected));
      row.render(el);
      this.spacer.append(el);
      this.drawn.set(i, el);
    }
  }

  destroy(): void {
    if (this.frame) cancelAnimationFrame(this.frame);
  }
}

/** A span with the characters at `positions` marked, for fuzzy matches. */
export function highlighted(text: string, positions: readonly number[] = []): HTMLElement {
  const span = document.createElement("span");
  span.className = "cm-lsp-label";
  if (!positions.length) {
    span.textContent = text;
    return span;
  }
  const marks = new Set(positions);
  let run = "";
  let inMark = false;
  const flush = () => {
    if (!run) return;
    if (inMark) span.appendChild(document.createElement("mark")).textContent = run;
    else span.append(run);
    run = "";
  };
  for (let i = 0; i < text.length; i++) {
    const m = marks.has(i);
    if (m !== inMark) {
      flush();
      inMark = m;
    }
    run += text[i];
  }
  flush();
  return span;
}

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
