// The sheet's menus and small panels: tab and cell menus, the filter panel,
// the filter buttons and the find bar.
import { useMemo, useState } from "react";
import { CalendarDays, Check, ChevronRight, ClipboardPaste, Copy, Eye, EyeOff, MessageSquare, Filter as FilterIcon, ListChecks, Scissors, X } from "lucide-react";
import { KeyCap } from "../KeyCap";
import { isMac } from "../../shortcuts/registry";
import { a1, COND_RULE_NAMES, condPlaceholder, condTakesValue, type CondRule, type SheetModel, type TabData } from "./sheetCore";
import { CtxItem } from "../ui/context-menu";
import { DropdownMenuSeparator } from "../ui/dropdown-menu";
import type { AxisLayout } from "./layout";
import { COL_HEADER_H, cellViewportRect } from "./gridGeometry";
import type { FormatAction } from "./FormatBar";
import { useWatchEffect } from "../../hooks/useWatchEffect";

export function TabMenu({ tabId, model, onRename, onDelete, onDuplicate, onMove }: { tabId: string; model: SheetModel; onRename: () => void; onDelete: () => void; onDuplicate: () => void; onMove: (dir: -1 | 1) => void }) {
  const t = model.byId.get(tabId);
  if (!t) return null;
  const at = model.tabs.findIndex((x) => x.id === tabId);
  return (
    <>
      <CtxItem onSelect={onRename}>Rename</CtxItem>
      <CtxItem onSelect={onDuplicate}>Duplicate</CtxItem>
      {at > 0 && <CtxItem onSelect={() => onMove(-1)}>Move left</CtxItem>}
      {at < model.tabs.length - 1 && <CtxItem onSelect={() => onMove(1)}>Move right</CtxItem>}
      <DropdownMenuSeparator />
      <CtxItem danger onSelect={onDelete} disabled={model.tabs.length === 1}>Delete tab</CtxItem>
    </>
  );
}

export function CellMenu({
  kind,
  readOnly,
  filtered,
  hiddenLines,
  frozen,
  onFormat,
  onClear,
  onCopyHint,
  validation,
  onValidate,
  onClipboard,
  onComment,
  onHide,
}: {
  kind: "cell" | "colHeader" | "rowHeader";
  readOnly: boolean;
  onFormat: (a: FormatAction) => void;
  onClear: () => void;
  onCopyHint: () => void;
  /** What the active cell accepts, if it has a dropdown or date picker. */
  validation?: "list" | "date";
  onValidate: (kind: "list" | "date" | "none") => void;
  onClipboard: (kind: ClipKind) => void;
  onComment: () => void;
  onHide: (axis: "col" | "row", hide: boolean) => void;
  filtered?: boolean;
  /** Whether the tab has hidden columns or rows (Unhide shows only then). */
  hiddenLines?: { cols: boolean; rows: boolean };
  frozen?: boolean;
}) {
  if (readOnly) return <CtxItem onSelect={onCopyHint}>Copy</CtxItem>;
  return (
    <>
      <CtxItem icon={Scissors} onSelect={() => onClipboard("cut")} trailing={<Keys k="X" />}>Cut</CtxItem>
      <CtxItem icon={Copy} onSelect={() => onClipboard("copy")} trailing={<Keys k="C" />}>Copy</CtxItem>
      <CtxItem icon={ClipboardPaste} onSelect={() => onClipboard("paste")} trailing={<Keys k="V" />}>Paste</CtxItem>
      <CtxItem onSelect={() => onClipboard("values")} trailing={<Keys k="V" shift />}>Paste values only</CtxItem>
      <DropdownMenuSeparator />
      {kind === "cell" && (
        <>
          <CtxItem icon={MessageSquare} onSelect={onComment} trailing={<Keys k="M" alt />}>Comment</CtxItem>
          <DropdownMenuSeparator />
        </>
      )}
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
      {kind === "colHeader" && (
        <>
          <CtxItem icon={EyeOff} onSelect={() => onHide("col", true)}>Hide columns</CtxItem>
          {hiddenLines?.cols !== false && <CtxItem icon={Eye} onSelect={() => onHide("col", false)}>Unhide columns</CtxItem>}
        </>
      )}
      {kind === "rowHeader" && (
        <>
          <CtxItem icon={EyeOff} onSelect={() => onHide("row", true)}>Hide rows</CtxItem>
          {hiddenLines?.rows !== false && <CtxItem icon={Eye} onSelect={() => onHide("row", false)}>Unhide rows</CtxItem>}
        </>
      )}
      <DropdownMenuSeparator />
      {kind !== "colHeader" && <CtxItem danger onSelect={() => onFormat({ type: "delete", axis: "row" })}>Delete rows</CtxItem>}
      {kind !== "rowHeader" && <CtxItem danger onSelect={() => onFormat({ type: "delete", axis: "col" })}>Delete columns</CtxItem>}
      <DropdownMenuSeparator />
      <CtxItem onSelect={() => onFormat({ type: "sort", desc: false })}>Sort A to Z</CtxItem>
      <CtxItem onSelect={() => onFormat({ type: "sort", desc: true })}>Sort Z to A</CtxItem>
      <CtxItem icon={FilterIcon} onSelect={() => onFormat({ type: "filter" })}>{filtered ? "Remove filter" : "Filter"}</CtxItem>
      {kind !== "colHeader" && <CtxItem onSelect={() => onFormat({ type: "freeze", axis: "row" })}>Freeze rows to here</CtxItem>}
      {kind !== "rowHeader" && <CtxItem onSelect={() => onFormat({ type: "freeze", axis: "col" })}>Freeze columns to here</CtxItem>}
      {frozen !== false && <CtxItem onSelect={() => onFormat({ type: "freeze", axis: "none" })}>Unfreeze</CtxItem>}
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

export type ClipKind = "cut" | "copy" | "paste" | "values";

function Keys({ k, shift, alt }: { k: string; shift?: boolean; alt?: boolean }) {
  return (
    <span className="inline-flex gap-0.5">
      <KeyCap size="xs">{isMac ? "⌘" : "Ctrl"}</KeyCap>
      {alt && <KeyCap size="xs">{isMac ? "⌥" : "Alt"}</KeyCap>}
      {shift && <KeyCap size="xs">⇧</KeyCap>}
      <KeyCap size="xs">{k}</KeyCap>
    </span>
  );
}

/** The toast when the browser won't let the menu read the clipboard: the keyboard paste always works. */
export function PasteHint() {
  return (
    <span className="inline-flex items-center gap-1">
      Paste with <Keys k="V" />
    </span>
  );
}

/** Conditions a filter can keep rows by: the rules that look at a value alone. */
const FILTER_RULES: CondRule[] = ["gt", "lt", "between", "eq", "ne", "contains", "empty", "filled", "before", "after"];

export function FilterPanel({ values, hidden, when, onApply, onSort }: {
  values: Array<{ text: string; count: number }>;
  hidden: string[];
  when?: { rule: CondRule; value?: string | number };
  onApply: (hidden: string[], when: { rule: CondRule; value?: string | number } | null) => void;
  onSort: (desc: boolean) => void;
}) {
  const [off, setOff] = useState(() => new Set(hidden));
  const [q, setQ] = useState("");
  const [rule, setRule] = useState<CondRule | "">(when?.rule ?? "");
  const [value, setValue] = useState(when?.value !== undefined ? String(when.value) : "");
  const shown = values.filter((v) => !q || v.text.toLowerCase().includes(q.toLowerCase()));
  const apply = () => {
    const v = value.trim();
    const n = Number(v);
    onApply([...off], rule && (!condTakesValue(rule) || v) ? { rule, ...(condTakesValue(rule) ? { value: v !== "" && Number.isFinite(n) && rule !== "contains" && rule !== "eq" && rule !== "ne" ? n : v } : {}) } : null);
  };
  return (
    <div className="sheet-filter-panel" data-sheet-filter-panel>
      <div className="sheet-filter-actions">
        <button type="button" onClick={() => onSort(false)}>Sort A to Z</button>
        <button type="button" onClick={() => onSort(true)}>Sort Z to A</button>
      </div>
      <select value={rule} onChange={(e) => setRule(e.target.value as CondRule | "")} aria-label="Filter by condition">
        <option value="">Any value</option>
        {FILTER_RULES.map((r) => <option key={r} value={r}>{COND_RULE_NAMES[r]}</option>)}
      </select>
      {rule && condTakesValue(rule) && <input value={value} onChange={(e) => setValue(e.target.value)} aria-label="Condition value" placeholder={condPlaceholder(rule)} spellCheck={false} onKeyDown={(e) => e.key === "Enter" && apply()} />}
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
      <button type="button" className="sheet-filter-ok" onClick={apply}>Apply</button>
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
    const active = (filter.hidden?.[String(c)] ?? []).length > 0 || !!filter.when?.[String(c)];
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
export function FindBar({
  find,
  onGo,
  from,
  onClose,
  replace: replaceInitially,
  onReplace,
}: {
  find: (q: string) => Array<{ col: number; row: number }>;
  onGo: (c: { col: number; row: number }) => void;
  from: () => { col: number; row: number };
  onClose: () => void;
  /** Open with the replace row showing (⌘⇧H). */
  replace?: boolean;
  /** Replace in one cell (at) or everywhere; returns how many cells changed. Absent when the sheet is read-only. */
  onReplace?: (q: string, replacement: string, at?: { col: number; row: number }) => number;
}) {
  const [q, setQ] = useState("");
  const [r, setR] = useState("");
  const [showReplace, setShowReplace] = useState(!!replaceInitially);
  const [at, setAt] = useState<number | null>(null);
  const [replaced, setReplaced] = useState<number | null>(null);
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
  const replaceOne = () => {
    if (!onReplace || !q) return;
    if (at === null) return go(1);
    onReplace(q, r, matches[at]);
    setReplaced(null);
    go(1);
  };
  return (
    <div className="sheet-find" data-sheet-find data-owns-keys onPointerDown={(e) => e.stopPropagation()}>
      <div className="sheet-find-row">
        {onReplace && (
          <button type="button" className="sheet-find-toggle" aria-label={showReplace ? "Hide replace" : "Replace"} aria-expanded={showReplace} onClick={() => setShowReplace((v) => !v)}>
            <ChevronRight className={`w-3.5 h-3.5 ${showReplace ? "rotate-90" : ""}`} />
          </button>
        )}
        <input
          autoFocus
          placeholder="Find"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setAt(null);
            setReplaced(null);
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
      {showReplace && onReplace && (
        <div className="sheet-find-row">
          <span className="sheet-find-toggle" />
          <input
            placeholder="Replace with"
            value={r}
            onChange={(e) => setR(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") onClose();
              if (e.key === "Enter") {
                e.preventDefault();
                replaceOne();
              }
            }}
          />
          <button type="button" className="sheet-find-action" disabled={!q || !matches.length} onClick={replaceOne}>Replace</button>
          <button type="button" className="sheet-find-action" disabled={!q || !matches.length} onClick={() => { setReplaced(onReplace(q, r)); setAt(null); }}>
            All{replaced !== null ? ` · ${replaced}` : ""}
          </button>
        </div>
      )}
    </div>
  );
}
