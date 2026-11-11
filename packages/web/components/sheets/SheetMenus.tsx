// The sheet's menus and small panels: tab and cell menus, the filter panel,
// the filter buttons and the find bar.
import { useMemo, useState } from "react";
import { CalendarDays, Check, Filter as FilterIcon, ListChecks, X } from "lucide-react";
import { a1, type SheetModel, type TabData } from "./sheetCore";
import { CtxItem } from "../ui/context-menu";
import { DropdownMenuSeparator } from "../ui/dropdown-menu";
import type { AxisLayout } from "./layout";
import { COL_HEADER_H, cellViewportRect } from "./gridGeometry";
import type { FormatAction } from "./FormatBar";
import { useWatchEffect } from "../../hooks/useWatchEffect";

export function TabMenu({ tabId, model, onRename, onDelete }: { tabId: string; model: SheetModel; onRename: () => void; onDelete: () => void }) {
  const t = model.byId.get(tabId);
  if (!t) return null;
  return (
    <>
      <CtxItem onSelect={onRename} disabled={!!t.meta.query}>Rename</CtxItem>
      <CtxItem danger onSelect={onDelete} disabled={model.tabs.length === 1}>Delete tab</CtxItem>
    </>
  );
}

export function CellMenu({
  kind,
  readOnly,
  onFormat,
  onClear,
  onCopyHint,
  validation,
  onValidate,
}: {
  kind: "cell" | "colHeader" | "rowHeader";
  readOnly: boolean;
  onFormat: (a: FormatAction) => void;
  onClear: () => void;
  onCopyHint: () => void;
  /** What the active cell accepts, if it has a dropdown or date picker. */
  validation?: "list" | "date";
  onValidate: (kind: "list" | "date" | "none") => void;
}) {
  if (readOnly) return <CtxItem onSelect={onCopyHint}>Copy</CtxItem>;
  return (
    <>
      {kind !== "colHeader" && (
        <>
          <CtxItem onSelect={() => onFormat({ type: "insert", axis: "row", after: false })}>Insert row above</CtxItem>
          <CtxItem onSelect={() => onFormat({ type: "insert", axis: "row", after: true })}>Insert row below</CtxItem>
        </>
      )}
      {kind !== "rowHeader" && (
        <>
          <CtxItem onSelect={() => onFormat({ type: "insert", axis: "col", after: false })}>Insert column left</CtxItem>
          <CtxItem onSelect={() => onFormat({ type: "insert", axis: "col", after: true })}>Insert column right</CtxItem>
        </>
      )}
      <DropdownMenuSeparator />
      {kind !== "colHeader" && <CtxItem danger onSelect={() => onFormat({ type: "delete", axis: "row" })}>Delete rows</CtxItem>}
      {kind !== "rowHeader" && <CtxItem danger onSelect={() => onFormat({ type: "delete", axis: "col" })}>Delete columns</CtxItem>}
      <DropdownMenuSeparator />
      <CtxItem onSelect={() => onFormat({ type: "sort", desc: false })}>Sort A to Z</CtxItem>
      <CtxItem onSelect={() => onFormat({ type: "sort", desc: true })}>Sort Z to A</CtxItem>
      <CtxItem icon={FilterIcon} onSelect={() => onFormat({ type: "filter" })}>Filter</CtxItem>
      {kind !== "colHeader" && <CtxItem onSelect={() => onFormat({ type: "freeze", axis: "row" })}>Freeze rows to here</CtxItem>}
      {kind !== "rowHeader" && <CtxItem onSelect={() => onFormat({ type: "freeze", axis: "col" })}>Freeze columns to here</CtxItem>}
      <CtxItem onSelect={() => onFormat({ type: "freeze", axis: "none" })}>Unfreeze</CtxItem>
      <DropdownMenuSeparator />
      {kind !== "rowHeader" && (
        <>
          <CtxItem icon={ListChecks} onSelect={() => onValidate("list")}>{validation === "list" ? "Edit dropdown" : "Dropdown"}</CtxItem>
          {validation !== "date" && <CtxItem icon={CalendarDays} onSelect={() => onValidate("date")}>Date picker</CtxItem>}
          {validation && <CtxItem onSelect={() => onValidate("none")}>{validation === "date" ? "Remove date picker" : "Remove dropdown"}</CtxItem>}
          <DropdownMenuSeparator />
        </>
      )}
      <CtxItem onSelect={onClear}>Clear contents</CtxItem>
    </>
  );
}

export function FilterPanel({ values, hidden, onApply }: { values: Array<{ text: string; count: number }>; hidden: string[]; onApply: (hidden: string[]) => void }) {
  const [off, setOff] = useState(() => new Set(hidden));
  const [q, setQ] = useState("");
  const shown = values.filter((v) => !q || v.text.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="sheet-filter-panel" data-sheet-filter-panel>
      <input autoFocus placeholder="Search values" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="sheet-filter-actions">
        <button type="button" onClick={() => setOff(new Set())}>All</button>
        <button type="button" onClick={() => setOff(new Set(values.map((v) => v.text)))}>None</button>
      </div>
      <div className="sheet-filter-list">
        {shown.map((v) => {
          const on = !off.has(v.text);
          return (
            <button
              type="button"
              key={v.text}
              className={on ? "is-on" : ""}
              onClick={() => setOff((s) => {
                const n = new Set(s);
                if (n.has(v.text)) n.delete(v.text);
                else n.add(v.text);
                return n;
              })}
            >
              <span className="sheet-check">{on && <Check className="w-3 h-3" />}</span>
              <span className="truncate flex-1 text-left">{v.text === "" ? "(blank)" : v.text}</span>
              <span className="text-sol-text-dim tabular-nums">{v.count}</span>
            </button>
          );
        })}
      </div>
      <button type="button" className="sheet-filter-ok" onClick={() => onApply([...off])}>Apply</button>
    </div>
  );
}

export function FilterButtons({
  tab,
  filter,
  cols,
  rows,
  frozenCols,
  frozenRows,
  scrollerRef,
  scrollTick,
  onOpen,
}: {
  tab: TabData;
  filter: NonNullable<TabData["meta"]["filter"]>;
  cols: AxisLayout;
  rows: AxisLayout;
  frozenCols: number;
  frozenRows: number;
  scrollerRef: React.RefObject<HTMLDivElement | null>;
  scrollTick: number;
  onOpen: (col: number, e: React.MouseEvent) => void;
}) {
  // Re-place on scroll: one cheap pass over the filtered columns.
  const [, force] = useState(0);
  useWatchEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    let raf = 0;
    const on = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        force((n) => n + 1);
      });
    };
    el.addEventListener("scroll", on, { passive: true });
    return () => el.removeEventListener("scroll", on);
  }, [scrollerRef]);
  void scrollTick;
  void tab;
  const el = scrollerRef.current;
  if (!el) return null;
  const out = [];
  for (let c = filter.c0; c <= filter.c1; c++) {
    const r = cellViewportRect(el, cols, rows, frozenCols, frozenRows, c, filter.row);
    if (!r.visible || r.x + r.w > el.clientWidth || r.y < COL_HEADER_H - 2 || r.y > el.clientHeight) continue;
    const active = (filter.hidden?.[String(c)] ?? []).length > 0;
    out.push(
      <button
        key={c}
        type="button"
        data-sheet-filter={c}
        aria-label={`Filter column ${a1(c, 1).replace(/\d+/, "")}`}
        className={`sheet-filter-btn ${active ? "is-active" : ""}`}
        style={{ left: r.x + r.w - 20, top: r.y + (r.h - 18) / 2 }}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => onOpen(c, e)}
      >
        <FilterIcon className="w-3 h-3" />
      </button>,
    );
  }
  return <>{out}</>;
}

/** ⌘F: find text or formulas on this tab; Enter goes to the next match, Shift+Enter back. */
export function FindBar({ find, onGo, from, onClose }: { find: (q: string) => Array<{ col: number; row: number }>; onGo: (c: { col: number; row: number }) => void; from: () => { col: number; row: number }; onClose: () => void }) {
  const [q, setQ] = useState("");
  const [at, setAt] = useState<number | null>(null);
  const matches = useMemo(() => find(q), [find, q]);
  const go = (dir: 1 | -1) => {
    if (!matches.length) return;
    let i: number;
    if (at === null) {
      const f = from();
      i = matches.findIndex((m) => m.row > f.row || (m.row === f.row && m.col >= f.col));
      if (i < 0) i = 0;
    } else i = (at + dir + matches.length) % matches.length;
    setAt(i);
    onGo(matches[i]);
  };
  return (
    <div className="sheet-find" data-sheet-find onPointerDown={(e) => e.stopPropagation()}>
      <input
        autoFocus
        placeholder="Find"
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setAt(null);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
          if (e.key === "Enter") {
            e.preventDefault();
            go(e.shiftKey ? -1 : 1);
          }
        }}
      />
      <span className="sheet-find-count">{q ? `${at === null ? 0 : at + 1}/${matches.length}` : ""}</span>
      <button type="button" aria-label="Close find" onClick={onClose}>
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}
