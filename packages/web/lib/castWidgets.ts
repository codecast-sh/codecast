// Declarative interactive widgets for cast-canvas. The agent emits plain
// sanitized markup; codecast attaches the behavior — no agent JS ever runs
// (same contract as castChart). Hydration happens inside the shadow root after
// the sanitized HTML mounts, so listeners are ours and content stays inert.
//
//   Tabs:   <div class="cast-tabs"><section data-tab="Label">…</section>…</div>
//   Table:  <table class="cast-table">…</table>   (click a header to sort)
//   Tip:    any element with data-tip="text"      (pure CSS, no hydration)

// Styles are injected with the shadow base stylesheet (HtmlSnippet imports this
// into SHADOW_BASE) so widgets are themed once, not per canvas.
export const WIDGET_BASE_CSS =
  // Tabs
  ".cast-tabs-bar{display:flex;gap:2px;border-bottom:1px solid var(--sol-border);margin-bottom:10px;flex-wrap:wrap}" +
  ".cast-tabs-bar button{appearance:none;background:none;border:none;border-bottom:2px solid transparent;" +
  "padding:5px 10px;margin-bottom:-1px;font:inherit;font-size:12px;color:var(--sol-text-muted);cursor:pointer}" +
  ".cast-tabs-bar button:hover{color:var(--sol-text)}" +
  ".cast-tabs-bar button[aria-selected=true]{color:var(--sol-text);border-bottom-color:var(--sol-blue)}" +
  ".cast-tabs>section[hidden]{display:none}" +
  // Sortable table
  ".cast-table th{cursor:pointer;user-select:none;white-space:nowrap}" +
  ".cast-table th:hover{color:var(--sol-text)}" +
  ".cast-table th[data-sort]:after{content:' ↑';color:var(--sol-blue)}" +
  ".cast-table th[data-sort=desc]:after{content:' ↓'}" +
  // Tooltips — pure CSS, shown above the element on hover.
  "[data-tip]{position:relative}" +
  "[data-tip]:hover:after{content:attr(data-tip);position:absolute;bottom:calc(100% + 6px);left:50%;" +
  "transform:translateX(-50%);background:var(--sol-bg-highlight);color:var(--sol-text);" +
  "border:1px solid var(--sol-border);border-radius:5px;padding:3px 8px;font-size:11px;line-height:1.4;" +
  "white-space:pre;max-width:280px;z-index:10;pointer-events:none}";

function hydrateTabs(root: ParentNode): void {
  for (const tabs of Array.from(root.querySelectorAll<HTMLElement>(".cast-tabs"))) {
    if (tabs.querySelector(":scope > .cast-tabs-bar")) continue; // already hydrated
    const panels = Array.from(tabs.querySelectorAll<HTMLElement>(":scope > section[data-tab]"));
    if (panels.length < 2) continue;
    const bar = tabs.ownerDocument.createElement("div");
    bar.className = "cast-tabs-bar";
    const select = (active: number) => {
      panels.forEach((p, i) => (p.hidden = i !== active));
      Array.from(bar.children).forEach((b, i) =>
        (b as HTMLElement).setAttribute("aria-selected", String(i === active)),
      );
    };
    panels.forEach((panel, i) => {
      const btn = tabs.ownerDocument.createElement("button");
      btn.type = "button";
      btn.textContent = panel.getAttribute("data-tab") || `Tab ${i + 1}`;
      btn.addEventListener("click", () => select(i));
      bar.appendChild(btn);
    });
    tabs.prepend(bar);
    select(Math.max(0, panels.findIndex((p) => p.hasAttribute("data-active"))));
  }
}

// Numeric-aware cell comparison: "42", "3.1%", "$1,200", "8ms" sort as numbers.
function cellValue(row: HTMLTableRowElement, col: number): string {
  return row.cells[col]?.textContent?.trim() ?? "";
}
function asNumber(s: string): number {
  const n = parseFloat(s.replace(/[$,%\s]|(?<=\d)(ms|s|kb|mb|gb|k|m)$/gi, ""));
  return Number.isNaN(n) ? NaN : n;
}

function hydrateTables(root: ParentNode): void {
  for (const table of Array.from(root.querySelectorAll<HTMLTableElement>("table.cast-table"))) {
    if (table.dataset.hydrated) continue;
    table.dataset.hydrated = "1";
    const headers = Array.from(table.querySelectorAll<HTMLTableCellElement>("thead th"));
    const body = table.tBodies[0];
    if (!headers.length || !body) continue;
    headers.forEach((th, col) => {
      th.addEventListener("click", () => {
        const dir = th.getAttribute("data-sort") === "asc" ? "desc" : "asc";
        headers.forEach((h) => h.removeAttribute("data-sort"));
        th.setAttribute("data-sort", dir);
        const rows = Array.from(body.rows);
        const numeric = rows.every((r) => !Number.isNaN(asNumber(cellValue(r, col))) || !cellValue(r, col));
        rows.sort((a, b) => {
          const av = cellValue(a, col), bv = cellValue(b, col);
          const cmp = numeric ? asNumber(av) - asNumber(bv) : av.localeCompare(bv);
          return dir === "asc" ? cmp : -cmp;
        });
        body.append(...rows);
      });
    });
  }
}

/** Attach behavior to every widget under `root` (a shadow root). Idempotent. */
export function hydrateWidgets(root: ParentNode): void {
  hydrateTabs(root);
  hydrateTables(root);
}
