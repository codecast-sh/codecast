"use client";
import { ReactNode, useState, useCallback, useMemo, useEffect, useRef } from "react";
import { copyToClipboard } from "../lib/utils";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useRouter, usePathname } from "next/navigation";
import { useWatchEffect } from "../hooks/useWatchEffect";
import { formatShortcutLabel, useShortcutAction } from "../shortcuts";
import { FilterDropdown, FilterOptionList } from "./FilterDropdown";
import { ContextMenu, useContextMenu } from "./ui/context-menu";
import { useInboxStore } from "../store/inboxStore";
import { toast } from "sonner";
import { SyncProgressBadge } from "./SyncProgressBadge";
import {
  Plus,
  SlidersHorizontal,
  ListFilter,
  X,
  Command,
  Check,
  Search,
  Bookmark,
  Link2,
  ChevronDown,
  ChevronRight,
  ChevronLeft,
  ArrowUp,
  ArrowDown,
  RotateCcw,
  BookmarkPlus,
  Forward,
} from "lucide-react";
import { openForwardToChat } from "../lib/forwardToChat";
import { useTeamFeature } from "../lib/teamFeatures";
import { useTitlebarHead } from "../hooks/useTitlebarHead";

export interface ListTab {
  key: string;
  label: string;
  count?: number;
  /** Optional leading icon (lucide component). When present, the compact
   *  dropdown can shed its text label and collapse to icon-only at tight widths. */
  icon?: any;
  /** A member of a multi-select set (needs `onTabToggle`). A plain click still
   *  selects it alone; shift/meta-click on its pill, or its checkbox in the
   *  compact dropdown, adds it to / removes it from the current set. */
  toggle?: boolean;
  /** Preset: the toggle keys this tab stands for. While it is active those tabs
   *  render as included (checked), so a reader can see what the preset means
   *  instead of guessing from its name. */
  implies?: string[];
  /** Tooltip. */
  title?: string;
}

/** `activeTab` may name several tabs at once ("open,in_progress"). `active` is
 *  what was picked; `included` adds every key an active preset stands for. */
function tabSelection(tabs: ListTab[], activeTab: string) {
  const active = new Set(activeTab.split(","));
  const included = new Set(active);
  for (const t of tabs) if (active.has(t.key)) t.implies?.forEach((k) => included.add(k));
  return { active, included };
}

/** The pill/row label for the current selection: the single active tab, or the
 *  active toggles joined ("Open, In Progress") once several are on. */
function tabSelectionSummary(tabs: ListTab[], activeTab: string): { label: string; count?: number; icons: any[] } {
  const { active } = tabSelection(tabs, activeTab);
  const picked = tabs.filter((t) => active.has(t.key));
  if (picked.length <= 1) {
    const t = picked[0] ?? tabs[0];
    return { label: t?.label ?? "", count: t?.count, icons: t?.icon ? [t.icon] : [] };
  }
  const count = picked.reduce((n, t) => n + (t.count ?? 0), 0);
  return { label: picked.map((t) => t.label).join(", "), count, icons: picked.map((t) => t.icon).filter(Boolean) };
}

/** Compact stand-in for the status pill row, shown when the header is too narrow
 *  to fit every pill (see .cq-tabs-compact). Surfaces the active tab + count and
 *  drops the full list into a popover so no status is ever scrolled out of reach.
 *  Toggle tabs get a checkbox: the box adds/removes, the label picks it alone. */
function TabDropdown({
  tabs,
  activeTab,
  onChange,
  onToggle,
}: {
  tabs: ListTab[];
  activeTab: string;
  onChange: (key: string) => void;
  onToggle?: (key: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const { active: activeKeys, included } = tabSelection(tabs, activeTab);
  const summary = tabSelectionSummary(tabs, activeTab);
  const firstToggleIdx = tabs.findIndex((t) => t.toggle);

  useWatchEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  // The label/count only collapse when there's an icon to stand in for them, so
  // icon-less consumers (e.g. Docs) keep their text at every width. With several
  // toggles on, their icons stand in together — the button still says which.
  const labelCollapse = summary.icons.length ? "cq-tab-label" : "";

  return (
    <div ref={ref} className="relative flex-shrink-0">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 h-7 px-2 rounded-md bg-sol-bg-alt border border-sol-border/40 text-xs text-sol-text hover:border-sol-border transition-colors"
        title={summary.label}
      >
        {summary.icons.length > 0 && (
          <span className="flex items-center -space-x-0.5 flex-shrink-0">
            {summary.icons.slice(0, 4).map((I, i) => <I key={i} className="w-3.5 h-3.5 flex-shrink-0 text-sol-text-muted" />)}
          </span>
        )}
        <span className={`font-medium whitespace-nowrap max-w-[14rem] truncate ${labelCollapse}`}>{summary.label}</span>
        {summary.count != null && summary.count > 0 && (
          <span className={`text-[10px] tabular-nums text-sol-text-dim ${labelCollapse}`}>{summary.count}</span>
        )}
        <ChevronDown className="w-3 h-3 opacity-60 flex-shrink-0 cq-caret" />
      </button>
      {open && (
        <div className="absolute top-full left-0 mt-1 w-52 bg-sol-bg border border-sol-border rounded-lg shadow-xl z-[250] py-1">
          {tabs.map((t, i) => {
            const TIcon = t.icon;
            const isActive = activeKeys.has(t.key);
            const isIncluded = included.has(t.key);
            const canToggle = !!(t.toggle && onToggle);
            return (
              <div key={t.key}>
                {/* Presets above, the set they compose from below. */}
                {canToggle && i === firstToggleIdx && i > 0 && <div className="my-1 border-t border-sol-border/40" />}
                <div
                  className={`w-full flex items-center gap-2 pr-3 text-xs transition-colors ${
                    isActive ? "bg-sol-bg-highlight text-sol-text" : "text-sol-text-muted hover:bg-sol-bg-alt"
                  } ${canToggle ? "pl-2" : "pl-3"}`}
                >
                  {canToggle && (
                    <button
                      onClick={() => onToggle!(t.key)}
                      title={isIncluded ? `Remove ${t.label}` : `Add ${t.label}`}
                      className={`w-3.5 h-3.5 rounded border flex-shrink-0 flex items-center justify-center transition-colors ${
                        isIncluded ? "bg-sol-cyan border-sol-cyan" : "border-sol-border/60 hover:border-sol-text-dim"
                      }`}
                    >
                      {isIncluded && <Check className="w-2.5 h-2.5 text-sol-bg" />}
                    </button>
                  )}
                  <button
                    onClick={() => { onChange(t.key); setOpen(false); }}
                    title={t.title ?? (canToggle ? `Only ${t.label}` : t.label)}
                    className="flex-1 min-w-0 flex items-center gap-2 py-1.5"
                  >
                    {TIcon && <TIcon className="w-3.5 h-3.5 flex-shrink-0 text-sol-text-dim" />}
                    <span className="flex-1 text-left whitespace-nowrap">{t.label}</span>
                    {t.count != null && t.count > 0 && (
                      <span className="text-[10px] tabular-nums text-sol-text-dim">{t.count}</span>
                    )}
                    {isActive && !canToggle && <Check className="w-3 h-3 text-sol-cyan flex-shrink-0" />}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export interface ListSortOption {
  value: string;
  label: string;
}

/** One selectable row inside the Display popover (a grouping or sort choice).
 *  Picking a row does NOT close the popover — grouping and sorting are two
 *  independent axes the user often sets in one sitting, so we keep it open and
 *  let the checkmarks reflect state until they click away. */
function DisplayOptionRow({
  label,
  selected,
  onClick,
}: {
  label: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs transition-colors ${
        selected ? "bg-sol-bg-highlight text-sol-text" : "text-sol-text-muted hover:bg-sol-bg-alt"
      }`}
    >
      <span className="flex-1 text-left whitespace-nowrap">{label}</span>
      {selected && <Check className="w-3 h-3 text-sol-cyan flex-shrink-0" />}
    </button>
  );
}

/** Linear-style "Display" popover. Folds two independent controls — Grouping and
 *  Sorting (with a direction toggle) — plus any page-specific display options
 *  (e.g. a List/Board switch passed as `extra`) behind one button, so the header
 *  toolbar stays a single compact row. Same popover pattern as TabDropdown.
 *
 *  Grouping is optional: when `groupOptions` is omitted the section is hidden and
 *  the popover is sort-only. Sorting always shows; the asc/desc toggle appears
 *  only when the consumer wires `onSortDirChange`. */
function DisplayMenu({
  groupBy,
  groupOptions,
  onGroupChange,
  subGroupBy,
  subGroupOptions,
  onSubGroupChange,
  sortBy,
  sortOptions,
  onSortChange,
  sortDir,
  onSortDirChange,
  extra,
  onCopyLink,
}: {
  groupBy?: string;
  groupOptions?: ListSortOption[];
  onGroupChange?: (v: string) => void;
  subGroupBy?: string;
  subGroupOptions?: ListSortOption[];
  onSubGroupChange?: (v: string) => void;
  sortBy: string;
  sortOptions: ListSortOption[];
  onSortChange: (v: string) => void;
  sortDir?: "asc" | "desc";
  onSortDirChange?: () => void;
  extra?: ReactNode;
  /** When set, the popover gains a "Copy link to this view" row so the current
   *  filters/sort/tab are shareable even when no filter chip is showing (the
   *  filter bar — the other home for this action — is hidden with no filters). */
  onCopyLink?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useWatchEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const hasGrouping = !!(groupOptions && onGroupChange);
  const DirIcon = sortDir === "asc" ? ArrowUp : ArrowDown;

  return (
    <div ref={ref} className="relative flex-shrink-0">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 h-7 px-2.5 rounded-md border border-sol-border/40 text-xs text-sol-text-dim hover:text-sol-text hover:border-sol-border transition-colors"
        title="Display options"
      >
        <SlidersHorizontal className="w-3 h-3 flex-shrink-0" />
        <span className="cq-header-collapse">Display</span>
        <ChevronDown className="w-3 h-3 opacity-60 flex-shrink-0 cq-caret" />
      </button>
      {open && (
        <div className="absolute top-full right-0 mt-1 w-56 bg-sol-bg border border-sol-border rounded-lg shadow-xl z-[250] p-2 space-y-3">
          {extra && <div className="flex flex-col gap-2">{extra}</div>}
          {hasGrouping && (
            <div>
              <div className="text-[10px] uppercase tracking-wider text-sol-text-dim px-1 mb-1">Grouping</div>
              <div className="space-y-0.5">
                {groupOptions!.map((o) => (
                  <DisplayOptionRow
                    key={o.value}
                    label={o.label}
                    selected={o.value === groupBy}
                    onClick={() => onGroupChange!(o.value)}
                  />
                ))}
              </div>
            </div>
          )}
          {/* A second grouping axis, folded into the same header rather than
              nested: "Ashot · Codecast" is one group. Only offered once a
              primary grouping is chosen — there is nothing to sub-divide
              otherwise. */}
          {subGroupOptions && subGroupOptions.length > 0 && onSubGroupChange && groupBy && groupBy !== "none" && (
            <div>
              <div className="text-[10px] uppercase tracking-wider text-sol-text-dim px-1 mb-1">Then by</div>
              <div className="space-y-0.5">
                {subGroupOptions.map((o) => (
                  <DisplayOptionRow
                    key={o.value}
                    label={o.label}
                    selected={o.value === subGroupBy}
                    onClick={() => onSubGroupChange(o.value)}
                  />
                ))}
              </div>
            </div>
          )}
          <div>
            <div className="flex items-center justify-between px-1 mb-1">
              <span className="text-[10px] uppercase tracking-wider text-sol-text-dim">Sorting</span>
              {sortDir && onSortDirChange && (
                <button
                  onClick={onSortDirChange}
                  className="flex items-center gap-1 h-5 px-1.5 rounded text-[10px] text-sol-text-dim hover:text-sol-text hover:bg-sol-bg-alt transition-colors"
                  title={sortDir === "asc" ? "Ascending — click for descending" : "Descending — click for ascending"}
                >
                  <DirIcon className="w-3 h-3 flex-shrink-0" />
                  <span>{sortDir === "asc" ? "Asc" : "Desc"}</span>
                </button>
              )}
            </div>
            <div className="space-y-0.5">
              {sortOptions.map((o) => (
                <DisplayOptionRow
                  key={o.value}
                  label={o.label}
                  selected={o.value === sortBy}
                  onClick={() => onSortChange(o.value)}
                />
              ))}
            </div>
          </div>
          {onCopyLink && (
            <button
              onClick={() => { onCopyLink(); setOpen(false); }}
              className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs text-sol-text-muted hover:bg-sol-bg-alt hover:text-sol-text transition-colors border-t border-sol-border/30 pt-2"
            >
              <Link2 className="w-3 h-3 flex-shrink-0" />
              <span className="flex-1 text-left whitespace-nowrap">Copy link to this view</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export interface ListFilterDef {
  key: string;
  label: string;
  icon: ReactNode;
  value: string;
  options: { key: string; label: string; icon?: any; color?: string }[];
  onChange: (v: string) => void;
  multi?: boolean;
  /** Show the empty-key option in the add-menu too. For most filters "" means
   *  "any" and is noise there, but when "" names a real default view (e.g. the
   *  tasks Source filter's board), hiding it leaves the menu with no current
   *  state — the reader can't tell the options are departures from a default. */
  showEmptyOption?: boolean;
}

/** Add-filter menu: a two-level popover (category → that category's options) for
 *  filters that aren't set yet. Active filters render as removable chips, so this
 *  lists only the not-yet-applied categories. Two triggers: the header "Filter"
 *  button (variant="header", the entry point when the filter bar is hidden) and
 *  the dashed "+ Filter" inside the bar (variant="add", for adding more). */
function AddFilterMenu({
  defs,
  variant = "add",
  active = false,
}: {
  defs: ListFilterDef[];
  variant?: "add" | "header";
  active?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [catKey, setCatKey] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useWatchEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) { setOpen(false); setCatKey(null); }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const available = defs.filter((d) => !d.value);
  const cat = defs.find((d) => d.key === catKey) || null;
  const toggle = () => { setOpen((o) => !o); setCatKey(null); };

  return (
    <div ref={ref} className="relative">
      {variant === "header" ? (
        <button
          onClick={toggle}
          className={`flex items-center gap-1.5 text-xs h-7 px-2.5 rounded-md border transition-colors ${
            open || active
              ? "border-sol-cyan/40 text-sol-cyan bg-sol-cyan/5"
              : "border-sol-border/40 text-sol-text-dim hover:text-sol-text hover:border-sol-border"
          }`}
          title="Filter"
        >
          <ListFilter className="w-3 h-3 flex-shrink-0" />
          <span className="cq-header-collapse">Filter</span>
          {active && <span className="w-1.5 h-1.5 rounded-full bg-sol-cyan flex-shrink-0" />}
        </button>
      ) : (
        <button
          onClick={toggle}
          className="flex items-center gap-1 text-xs h-7 px-2 rounded-md border border-dashed border-sol-border/50 text-sol-text-dim hover:text-sol-text hover:border-sol-border transition-colors"
          title="Add filter"
        >
          <Plus className="w-3 h-3" />
          <span className="cq-addfilter-label">Filter</span>
        </button>
      )}
      {open && (
        <div className={`absolute top-full ${variant === "header" ? "right-0" : "left-0"} mt-1 w-48 bg-sol-bg border border-sol-border rounded-lg shadow-xl z-[250] py-1 max-h-72 overflow-y-auto`}>
          {!cat ? (
            available.length === 0 ? (
              <div className="px-3 py-1.5 text-xs text-sol-text-dim">All filters added</div>
            ) : (
              available.map((d) => (
                <button
                  key={d.key}
                  onClick={() => setCatKey(d.key)}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-sol-text-muted hover:bg-sol-bg-alt transition-colors"
                >
                  <span className="flex-shrink-0 flex items-center">{d.icon}</span>
                  <span className="flex-1 text-left">{d.label}</span>
                  <ChevronRight className="w-3 h-3 opacity-50 flex-shrink-0" />
                </button>
              ))
            )
          ) : (
            <>
              <button
                onClick={() => setCatKey(null)}
                className="w-full flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-medium text-sol-text-dim hover:text-sol-text border-b border-sol-border/30 mb-1 transition-colors"
              >
                <ChevronLeft className="w-3 h-3" /> {cat.label}
              </button>
              <FilterOptionList
                options={cat.showEmptyOption ? cat.options : cat.options.filter((o) => o.key !== "")}
                value={cat.value}
                multi={cat.multi}
                onChange={cat.onChange}
                onPicked={() => { setOpen(false); setCatKey(null); }}
              />
            </>
          )}
        </div>
      )}
    </div>
  );
}

export interface ListGroup<T> {
  key: string;
  label: string;
  icon?: ReactNode;
  badge?: ReactNode;
  extra?: ReactNode;
  items: T[];
}

export interface ItemRowState {
  isFocused: boolean;
  isSelected: boolean;
  isEditing: boolean;
  onClick: () => void;
  onSelect: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onEditDone: () => void;
  onTitleCommit: (newTitle: string) => void;
  onOpenPalette: (mode: string) => void;
}

export interface GenericListViewProps<T> {
  title: string;
  tabs: ListTab[];
  /** The active tab key, or several joined by commas when the consumer
   *  supports multi-select through onTabToggle. */
  activeTab: string;
  onTabChange: (tab: string) => void;
  /** Add/remove one `toggle` tab from the current selection (shift/meta-click on
   *  a pill, or the checkbox in the compact dropdown). The consumer owns the set
   *  arithmetic — it knows its own presets and normalisation. */
  onTabToggle?: (tab: string) => void;

  /** Grouping axis — independent of sort. Omit all three to render a sort-only
   *  Display popover (no Grouping section). Convention: a `"none"` option value
   *  means "don't group" (flat list). */
  groupBy?: string;
  groupOptions?: ListSortOption[];
  onGroupChange?: (group: string) => void;

  /** Optional second grouping axis. Buckets stay one level deep — the two axes
   *  combine into a single header — so the row model never grows a depth. */
  subGroupBy?: string;
  subGroupOptions?: ListSortOption[];
  onSubGroupChange?: (group: string) => void;

  sortBy: string;
  sortOptions: ListSortOption[];
  onSortChange: (sort: string) => void;
  /** Sort direction. When provided alongside `onSortDirChange`, the Sorting
   *  section shows an asc/desc toggle. */
  sortDir?: "asc" | "desc";
  onSortDirChange?: () => void;

  filters?: {
    hasActive: boolean;
    defs: ListFilterDef[];
    onClear: () => void;
    onSaveView?: (name: string) => void;
    /** The saved view this list was opened from, when it has been modified
     *  since. Present only while dirty — an unchanged view needs no controls,
     *  and the rail already shows which one you are in. */
    dirtyView?: { name: string; onUpdate: () => void; onDiscard: () => void; canUpdate: boolean };
  };

  /** Returns a shareable absolute URL encoding the current view (filters, sort,
   *  active tab). When provided, a "copy link" action appears in the Display
   *  popover and — when a filter is active — in the filter bar's action cluster.
   *  The consumer serializes its own URL params (it owns the param schema);
   *  this component owns the clipboard write + toast. */
  shareUrl?: () => string;

  groups: ListGroup<T>[] | null;
  flatItems: T[];

  renderRow: (item: T, state: ItemRowState) => ReactNode;
  getItemId: (item: T) => string;
  getItemRoute: (item: T) => string;
  emptyIcon?: ReactNode;
  emptyMessage?: string;

  onCreate: () => void;

  hasMore?: boolean;
  isLoadingMore?: boolean;
  onLoadMore?: () => void;

  paletteTargetType?: 'task' | 'doc';
  /** Short-ID ref for an item (e.g. a task's `ct-…`). When provided, Ctrl+N with
   *  rows multi-selected opens the new-session composer pre-filled with the
   *  selection's refs, so the first message can just say what to do with them
   *  ("merge these two"). */
  getComposeRef?: (item: T) => string | null | undefined;
  paletteShortcuts?: { key: string; mode: string; label: string }[];
  paletteProps?: { teamMembers?: any[]; currentUser?: any };

  renderPreview?: (item: T, onClose: () => void, onOpen: () => void) => ReactNode;

  onItemEdit?: (item: T, newTitle: string) => void;

  getSearchText?: (item: T) => string;
  /** Corpus to search when a query is typed, overriding the tab-filtered
   *  groups/flatItems. Lets a search span items hidden by the active browse tab
   *  (e.g. a docs search finding a doc whose type isn't the selected tab) instead
   *  of silently returning "No results". When omitted, search stays scoped to the
   *  visible groups/flatItems (unchanged behavior). */
  searchAllItems?: T[];
  /** When set, a subtle "syncing N" whisper renders next to the title while the
   *  reconcile crawl for this scope ("tasks" | "docs") is still streaming in. */
  syncScope?: string;
  headerExtra?: ReactNode;
  /** Page-specific controls rendered inside the Display popover (e.g. a List/Board
   *  view switch). Kept out of the always-visible toolbar to stay Linear-compact. */
  displayExtra?: ReactNode;
  listFooter?: ReactNode;
  customContent?: (helpers: {
    openPaletteForItems: (items: T[], mode?: string) => void;
    openContextMenuForItems: (e: React.MouseEvent, items: T[]) => void;
  }) => ReactNode;
  /** Right-click menu content for rows (and customContent surfaces). When set,
   *  right-click opens a cursor-anchored menu instead of the palette overlay.
   *  Receives the selection when the clicked row is part of it, else just the
   *  clicked row — same targeting the keyboard palette entry uses. */
  contextMenuContent?: (items: T[]) => ReactNode;
  /** Optional drag & drop. Rows become draggable; group headers — and rows of
   *  other groups — accept "move into that bucket" drops; the middle of a row
   *  is a combine target; row edges are insertion gaps when onReorder is set. */
  dnd?: {
    /** Move `item` into the bucket named by `groupKey`. */
    onDropOnGroup?: (item: T, groupKey: string) => void;
    /** Whether that bucket can accept `item` (also gates the hover highlight).
     *  Defaults to true when onDropOnGroup is set. */
    canDropOnGroup?: (item: T, groupKey: string) => boolean;
    /** Drop one row onto another (combine gesture — e.g. duplicate/subtask). */
    onDropOnItem?: (item: T, target: T) => void;
    /** Manual reorder: insert `item` between `before` and `after` (either null
     *  at a group edge) inside `groupKey` (null when the list is flat). */
    onReorder?: (item: T, before: T | null, after: T | null, groupKey: string | null) => void;
  };
  extraKeyHandler?: (e: KeyboardEvent, stop: () => void) => boolean;
  disableKeyboard?: boolean;
  activeItemId?: string;
  children?: ReactNode;
}

export function GenericListView<T>({
  title,
  tabs,
  activeTab,
  onTabChange,
  onTabToggle,
  groupBy,
  groupOptions,
  onGroupChange,
  subGroupBy,
  subGroupOptions,
  onSubGroupChange,
  sortBy,
  sortOptions,
  onSortChange,
  sortDir,
  onSortDirChange,
  filters,
  shareUrl,
  groups,
  flatItems,
  renderRow,
  getItemId,
  getItemRoute,
  emptyIcon,
  emptyMessage,
  onCreate,
  hasMore,
  isLoadingMore,
  onLoadMore,
  paletteTargetType,
  getComposeRef,
  paletteShortcuts,
  paletteProps,
  renderPreview,
  onItemEdit,
  getSearchText,
  searchAllItems,
  syncScope,
  headerExtra,
  displayExtra,
  listFooter,
  customContent,
  contextMenuContent,
  dnd,
  extraKeyHandler,
  disableKeyboard,
  activeItemId,
  children,
}: GenericListViewProps<T>) {
  const router = useRouter();
  const titlebarRef = useTitlebarHead<HTMLDivElement>();
  const currentPath = usePathname();

  // Open/close a row's detail by driving the URL: navigating to the row's route
  // opens it (instant when the route shares this page's component — e.g.
  // /tasks), and navigating back to the list route closes it, in place with no
  // re-mount. Click always opens — re-clicking the open row is a no-op, closing
  // belongs to Esc/✕ — while space keeps the keyboard toggle.
  const openDetail = (item: T) => router.push(getItemRoute(item));
  const toggleDetail = (item: T) => {
    const route = getItemRoute(item);
    const base = route.replace(/\/[^/]+$/, "");
    router.push(currentPath === route ? base : route);
  };

  const [focusIndex, setFocusIndex] = useState(0);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const storeOpenPalette = useInboxStore((s) => s.openPalette);
  const storeOpenCompose = useInboxStore((s) => s.openCompose);
  const paletteIsOpen = useInboxStore((s) => s.palette.open);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const shortcutsPanelOpen = useInboxStore(s => s.shortcutsPanelOpen);
  const [searchQuery, setSearchQuery] = useState("");
  const [showSearch, setShowSearch] = useState(false);
  const [savingView, setSavingView] = useState(false);
  const [saveViewName, setSaveViewName] = useState("");
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const loadMoreRef = useRef<HTMLDivElement | null>(null);

  const chatOn = useTeamFeature("chat");
  const copyViewLink = useCallback(async () => {
    if (!shareUrl) return;
    const url = shareUrl();
    try {
      await copyToClipboard(url);
      toast.success("Link to this view copied");
    } catch {
      toast.error("Couldn't copy link");
    }
  }, [shareUrl]);

  const searching = !!searchQuery && !!getSearchText;
  // A search with a `searchAllItems` corpus spans the whole set (ignoring the
  // active browse tab / grouping) and renders as a flat result list.
  const crossScopeSearch = searching && !!searchAllItems;

  const displayGroups = useMemo((): ListGroup<T>[] | null => {
    if (!groups) return null;
    if (!searching) return groups;
    if (crossScopeSearch) return null; // flat results from searchAllItems instead
    const q = searchQuery.toLowerCase();
    return groups
      .map(g => ({ ...g, items: g.items.filter(item => getSearchText!(item).toLowerCase().includes(q)) }))
      .filter(g => g.items.length > 0);
  }, [groups, searching, crossScopeSearch, searchQuery, getSearchText]);

  const displayFlatItems = useMemo(() => {
    if (!searching) return flatItems;
    const q = searchQuery.toLowerCase();
    if (crossScopeSearch) return searchAllItems!.filter(item => getSearchText!(item).toLowerCase().includes(q));
    if (groups) return flatItems; // grouped search handled in displayGroups
    return flatItems.filter(item => getSearchText!(item).toLowerCase().includes(q));
  }, [groups, flatItems, searching, crossScopeSearch, searchAllItems, searchQuery, getSearchText]);

  const visibleItems = useMemo(() => {
    if (displayGroups) {
      return displayGroups.flatMap((g) =>
        collapsedGroups.has(g.key) ? [] : g.items
      );
    }
    return displayFlatItems;
  }, [displayGroups, collapsedGroups, displayFlatItems]);

  const focusedItem = visibleItems[focusIndex] || null;

  // Flatten groups + items into a single ordered list of "rows" so the whole
  // view (group headers AND item rows) can be virtualized as one stream. Each
  // item row carries its index into `visibleItems` so keyboard focus and the
  // rendered row stay in lockstep. Without virtualization every task/doc in the
  // workspace was a live DOM node and re-rendered on every j/k press — O(N) per
  // keystroke. Now only the visible window (~window height) is mounted.
  type RowEntry =
    | { kind: "header"; key: string; group: ListGroup<T>; collapsed: boolean }
    | { kind: "item"; key: string; item: T; focusIndex: number; groupKey: string | null };
  const rowModel = useMemo<RowEntry[]>(() => {
    const rows: RowEntry[] = [];
    if (displayGroups) {
      let fi = 0;
      for (const g of displayGroups) {
        const collapsed = collapsedGroups.has(g.key);
        rows.push({ kind: "header", key: `__hdr_${g.key}`, group: g, collapsed });
        if (!collapsed) {
          for (const item of g.items) {
            rows.push({ kind: "item", key: getItemId(item), item, focusIndex: fi, groupKey: g.key });
            fi++;
          }
        }
      }
    } else {
      displayFlatItems.forEach((item, i) => {
        rows.push({ kind: "item", key: getItemId(item), item, focusIndex: i, groupKey: null });
      });
    }
    return rows;
  }, [displayGroups, displayFlatItems, collapsedGroups, getItemId]);

  // focusIndex (index into visibleItems) → rowModel index, so keyboard nav can
  // scroll the right virtual row into view.
  const focusToRowIndex = useMemo(() => {
    const map: number[] = [];
    rowModel.forEach((r, idx) => { if (r.kind === "item") map[r.focusIndex] = idx; });
    return map;
  }, [rowModel]);

  const rowVirtualizer = useVirtualizer({
    count: rowModel.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => (rowModel[i]?.kind === "header" ? 38 : 45),
    getItemKey: (i) => rowModel[i]?.key ?? i,
    overscan: 12,
  });

  useWatchEffect(() => {
    if (focusIndex >= visibleItems.length && visibleItems.length > 0) {
      setFocusIndex(visibleItems.length - 1);
    }
  }, [visibleItems.length, focusIndex]);

  useWatchEffect(() => {
    if (previewId && focusedItem && getItemId(focusedItem) !== previewId) {
      setPreviewId(getItemId(focusedItem));
    }
  }, [focusIndex]);

  useWatchEffect(() => {
    const rowIdx = focusToRowIndex[focusIndex];
    if (rowIdx != null) rowVirtualizer.scrollToIndex(rowIdx, { align: "auto" });
  }, [focusIndex]);

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const getTargetItemsForPalette = useCallback((): any[] => {
    if (selectedIds.size > 0) {
      return visibleItems.filter((item) => selectedIds.has(getItemId(item)));
    }
    return focusedItem ? [focusedItem] : [];
  }, [selectedIds, visibleItems, focusedItem, getItemId]);

  const openPalette = useCallback((mode: string) => {
    storeOpenPalette({ targets: getTargetItemsForPalette(), targetType: paletteTargetType, mode });
  }, [storeOpenPalette, getTargetItemsForPalette, paletteTargetType]);

  const openPaletteForItems = useCallback((items: T[], mode = "root") => {
    storeOpenPalette({ targets: items as any[], targetType: paletteTargetType, mode });
  }, [storeOpenPalette, paletteTargetType]);

  // One cursor-anchored menu serves every row (virtualized lists included) and
  // any customContent surface (e.g. kanban cards).
  const ctxMenu = useContextMenu<T[]>();
  const openContextMenuForItems = useCallback((e: React.MouseEvent, items: T[]) => {
    ctxMenu.open(e, items);
  }, [ctxMenu.open]);

  // --- Drag & drop. One dragged row id + one hint describing what a release
  // would do: move to a bucket, combine with a row, or insert into a gap. The
  // hint drives every highlight, so what lights up is exactly what will happen.
  type DropHint =
    | { kind: "group"; key: string }
    | { kind: "item"; id: string }
    | { kind: "gap"; id: string; edge: "before" | "after" };
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropHint, setDropHint] = useState<DropHint | null>(null);
  const dndMaps = useMemo(() => {
    const byId = new Map<string, T>();
    const groupOf = new Map<string, string | null>();
    for (const r of rowModel) if (r.kind === "item") { byId.set(r.key, r.item); groupOf.set(r.key, r.groupKey); }
    return { byId, groupOf };
  }, [rowModel]);
  const draggedItem = dragId ? dndMaps.byId.get(dragId) ?? null : null;
  const clearDrag = useCallback(() => { setDragId(null); setDropHint(null); }, []);
  const sameHint = (a: DropHint | null, b: DropHint) =>
    !!a && a.kind === b.kind && (a as any).key === (b as any).key && (a as any).id === (b as any).id && (a as any).edge === (b as any).edge;
  const setHint = useCallback((h: DropHint) => {
    setDropHint((prev) => (sameHint(prev, h) ? prev : h));
  }, []);

  const performDrop = useCallback(() => {
    const hint = dropHint;
    const item = draggedItem;
    clearDrag();
    if (!hint || !item || !dnd) return;
    if (hint.kind === "group") { dnd.onDropOnGroup?.(item, hint.key); return; }
    if (hint.kind === "item") {
      const target = dndMaps.byId.get(hint.id);
      if (target && getItemId(target) !== getItemId(item)) dnd.onDropOnItem?.(item, target);
      return;
    }
    // Gap: resolve the neighbors around the insertion point, staying inside the
    // target row's group (a header or list edge leaves that side null).
    const idx = rowModel.findIndex((r) => r.kind === "item" && r.key === hint.id);
    const row = rowModel[idx];
    if (!row || row.kind !== "item") return;
    let before: T | null = null;
    let after: T | null = null;
    if (hint.edge === "before") {
      after = row.item;
      const prev = rowModel[idx - 1];
      if (prev?.kind === "item" && prev.groupKey === row.groupKey) before = prev.item;
    } else {
      before = row.item;
      const next = rowModel[idx + 1];
      if (next?.kind === "item" && next.groupKey === row.groupKey) after = next.item;
    }
    const iid = getItemId(item);
    if ((before && getItemId(before) === iid) || (after && getItemId(after) === iid)) return;
    dnd.onReorder?.(item, before, after, row.groupKey);
  }, [dropHint, draggedItem, dnd, dndMaps, rowModel, getItemId, clearDrag]);

  // Ctrl+N with rows multi-selected: seed the new-session composer with the
  // selection's refs (bare short IDs render as live reference cards), so the
  // first message can just say what to do with them. With nothing selected,
  // decline — DashboardLayout's default handler opens the blank composer.
  useShortcutAction('session.compose', () => {
    if (!getComposeRef || selectedIds.size === 0) return false;
    const refs = visibleItems
      .filter((item) => selectedIds.has(getItemId(item)))
      .map(getComposeRef)
      .filter((r): r is string => !!r);
    if (refs.length === 0) return false;
    storeOpenCompose(refs.join(" ") + " ");
    return true;
  });

  const toggleGroup = useCallback((key: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  useWatchEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable) return;

      const stop = () => { e.preventDefault(); };

      if (shortcutsPanelOpen) return;

      if (disableKeyboard || paletteIsOpen || !!editingId) return;

      if (extraKeyHandler?.(e, stop)) return;

      if (e.key === "k" && (e.metaKey || e.ctrlKey)) { stop(); openPalette("root"); return; }
      if (e.key === "x" && !e.metaKey && !e.ctrlKey) {
        stop();
        if (focusedItem) toggleSelect(getItemId(focusedItem));
        return;
      }
      if (e.key === "Escape") {
        if (previewId) { stop(); setPreviewId(null); return; }
        if (selectedIds.size > 0) { stop(); setSelectedIds(new Set()); return; }
      }

      if (paletteShortcuts) {
        for (const ps of paletteShortcuts) {
          if (e.key === ps.key && !e.metaKey && !e.ctrlKey) {
            stop(); openPalette(ps.mode); return;
          }
        }
      }

      if (e.key === "d" && !e.metaKey && !e.ctrlKey) { stop(); openPalette("root"); return; }
      if (e.key === "e" && !e.metaKey && !e.ctrlKey && onItemEdit) {
        stop();
        if (focusedItem) setEditingId(getItemId(focusedItem));
        return;
      }
      if (e.key === "a" && (e.metaKey || e.ctrlKey)) {
        stop();
        setSelectedIds(new Set(visibleItems.map(getItemId)));
        return;
      }
      if (e.key === " " && !e.metaKey && !e.ctrlKey) {
        stop();
        if (focusedItem) toggleDetail(focusedItem);
        return;
      }

      if (e.key === "j" && !e.metaKey && !e.ctrlKey) {
        stop();
        setFocusIndex((i) => Math.min(i + 1, visibleItems.length - 1));
        return;
      }
      if (e.key === "k" && !e.metaKey && !e.ctrlKey) {
        stop();
        setFocusIndex((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === "Enter") {
        stop();
        if (focusedItem) router.push(getItemRoute(focusedItem));
        return;
      }
      if (e.key === "/" && !e.metaKey && !e.ctrlKey && getSearchText) { stop(); setShowSearch(true); return; }
      if (e.key === "c" && !e.metaKey && !e.ctrlKey) { stop(); onCreate(); return; }
      if (e.key === "Home") { stop(); setFocusIndex(0); return; }
      if (e.key === "End") { stop(); setFocusIndex(Math.max(0, visibleItems.length - 1)); return; }

      const tabKeys: Record<string, number> = {};
      tabs.forEach((_, i) => { tabKeys[String(i + 1)] = i; });
      if (tabKeys[e.key] !== undefined && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
        stop();
        onTabChange(tabs[tabKeys[e.key]].key);
        setFocusIndex(0);
        return;
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [shortcutsPanelOpen, disableKeyboard, paletteIsOpen, editingId, focusedItem, visibleItems, focusIndex, tabs,
    previewId, selectedIds, paletteShortcuts, onTabChange, getItemRoute, getItemId, currentPath,
    onCreate, openPalette, toggleSelect, router, extraKeyHandler, onItemEdit, renderPreview, getSearchText]);

  const previewItem = previewId ? flatItems.find((item) => getItemId(item) === previewId) || null : null;

  useEffect(() => {
    if (!hasMore || !onLoadMore || isLoadingMore) return;
    const root = scrollRef.current;
    const target = loadMoreRef.current;
    if (!root || !target) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) onLoadMore();
      },
      { root, rootMargin: "240px 0px", threshold: 0 }
    );

    observer.observe(target);
    return () => observer.disconnect();
  }, [hasMore, onLoadMore, isLoadingMore, visibleItems.length]);

  const renderItemRow = (item: T, globalIdx: number, groupKey: string | null) => {
    const id = getItemId(item);
    const isFocused = focusIndex === globalIdx;
    const isSelected = selectedIds.has(id);
    const isEditing = editingId === id;
    const isActive = activeItemId === id;

    // What a release right here would do (drives the row's highlight).
    const combineTarget = dropHint?.kind === "item" && dropHint.id === id;
    const gapEdge = dropHint?.kind === "gap" && dropHint.id === id ? dropHint.edge : null;
    const inTargetGroup = dropHint?.kind === "group" && groupKey === dropHint.key;
    const dragProps = dnd
      ? {
          draggable: !isEditing,
          onDragStart: (e: React.DragEvent) => {
            e.dataTransfer.setData("text/plain", id);
            e.dataTransfer.effectAllowed = "move";
            setDragId(id);
          },
          onDragEnd: clearDrag,
          onDragOver: (e: React.DragEvent) => {
            if (!draggedItem || dragId === id) return;
            const rect = e.currentTarget.getBoundingClientRect();
            const rel = (e.clientY - rect.top) / Math.max(1, rect.height);
            const canReorder = !!dnd.onReorder;
            const canCombine = !!dnd.onDropOnItem;
            const canGroupMove =
              !!dnd.onDropOnGroup &&
              groupKey != null &&
              groupKey !== dndMaps.groupOf.get(dragId!) &&
              (dnd.canDropOnGroup?.(draggedItem, groupKey) ?? true);
            // Edges insert (or, without reorder, move into this row's bucket);
            // the middle combines. Whatever this row can't do falls through to
            // what it can, so a drop is never silently dead over a valid move.
            let hint: DropHint | null = null;
            const edge: "before" | "after" = rel < 0.5 ? "before" : "after";
            if (rel < 0.3 || rel > 0.7) {
              if (canReorder) hint = { kind: "gap", id, edge };
              else if (canGroupMove) hint = { kind: "group", key: groupKey! };
              else if (canCombine) hint = { kind: "item", id };
            } else if (canCombine) hint = { kind: "item", id };
            else if (canGroupMove) hint = { kind: "group", key: groupKey! };
            else if (canReorder) hint = { kind: "gap", id, edge };
            if (!hint) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            setHint(hint);
          },
          onDrop: (e: React.DragEvent) => { e.preventDefault(); performDrop(); },
        }
      : {};

    const state: ItemRowState = {
      isFocused,
      isSelected,
      isEditing,
      // Click opens the detail in place (space toggles) by driving the URL.
      onClick: () => { setFocusIndex(globalIdx); openDetail(item); },
      onSelect: () => toggleSelect(id),
      onContextMenu: (e: React.MouseEvent) => {
        if (contextMenuContent) {
          // The selection travels with the right-click when the clicked row is
          // part of it — same targeting keyboard palette entry uses.
          const targets = selectedIds.has(id)
            ? visibleItems.filter((it) => selectedIds.has(getItemId(it)))
            : [item];
          setFocusIndex(globalIdx);
          ctxMenu.open(e, targets);
          return;
        }
        e.preventDefault();
        storeOpenPalette({ targets: [item] as any[], targetType: paletteTargetType, mode: "root" });
      },
      onEditDone: () => setEditingId(null),
      onTitleCommit: (newTitle: string) => {
        if (onItemEdit) onItemEdit(item, newTitle);
        setEditingId(null);
      },
      onOpenPalette: (mode: string) => {
        storeOpenPalette({ targets: [item] as any[], targetType: paletteTargetType, mode });
      },
    };

    return (
      <div
        key={id}
        data-list-focused={isFocused || undefined}
        onClick={state.onClick}
        onContextMenu={state.onContextMenu}
        {...dragProps}
        style={
          combineTarget
            ? { boxShadow: "inset 0 0 0 1.5px var(--sol-cyan)" }
            : inTargetGroup
              ? { background: "color-mix(in srgb, var(--sol-cyan) 6%, transparent)" }
              : undefined
        }
        className={`relative w-full flex items-center gap-3 px-4 py-2.5 transition-colors text-left group border-b border-sol-border/20 cursor-pointer select-none ${
          dragId === id ? "opacity-40" : ""
        } ${
          isActive && isFocused
            ? "bg-sol-cyan/15 border-l-[3px] border-l-sol-cyan"
            : isActive
              ? "bg-sol-yellow/8 border-l-[3px] border-l-sol-yellow"
              : isFocused
                ? "bg-sol-cyan/10 border-l-[3px] border-l-sol-cyan"
                : isSelected
                  ? "bg-sol-cyan/8 border-l-[3px] border-l-sol-cyan/50"
                  : "hover:bg-sol-bg-alt/50 border-l-[3px] border-l-transparent"
        }`}
      >
        {gapEdge && (
          <span
            aria-hidden
            className={`pointer-events-none absolute left-2 right-2 h-0.5 rounded bg-sol-cyan z-10 ${
              gapEdge === "before" ? "top-[-1px]" : "bottom-[-1px]"
            }`}
          />
        )}
        <button
          onClick={(e) => { e.stopPropagation(); state.onSelect(); }}
          className={`w-4 h-4 rounded border flex-shrink-0 flex items-center justify-center transition-colors cq-hide-compact ${
            isSelected
              ? "bg-sol-cyan border-sol-cyan"
              : isFocused
                ? "border-gray-500/50"
                : "border-sol-border/60 opacity-0 group-hover:opacity-100"
          }`}
        >
          {isSelected && <Check className="w-3 h-3 text-sol-bg" />}
        </button>
        {renderRow(item, state)}
      </div>
    );
  };

  const renderGroupHeader = (g: ListGroup<T>, isCollapsed: boolean) => (
    <div
      className="w-full flex items-center gap-2 px-4 py-2 bg-sol-bg-alt/30 border-b border-sol-border/20"
      style={
        dropHint?.kind === "group" && dropHint.key === g.key
          ? { boxShadow: "inset 0 0 0 1.5px var(--sol-cyan)" }
          : undefined
      }
      onDragOver={
        dnd?.onDropOnGroup
          ? (e) => {
              if (!draggedItem) return;
              if (!(dnd.canDropOnGroup?.(draggedItem, g.key) ?? true)) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              setHint({ kind: "group", key: g.key });
            }
          : undefined
      }
      onDrop={dnd?.onDropOnGroup ? (e) => { e.preventDefault(); performDrop(); } : undefined}
    >
      <button
        onClick={() => toggleGroup(g.key)}
        className="flex items-center gap-2 flex-1 hover:bg-sol-bg-alt/50 transition-colors text-left"
      >
        <svg
          className={`w-3 h-3 text-sol-text-dim transition-transform ${isCollapsed ? "" : "rotate-90"}`}
          fill="currentColor"
          viewBox="0 0 20 20"
        >
          <path d="M6 4l8 6-8 6V4z" />
        </svg>
        {g.icon}
        <span className="text-xs font-medium text-sol-text-dim uppercase tracking-wide">
          {g.label}
        </span>
        <span className="text-xs text-sol-text-dim">({g.items.length})</span>
        {g.badge}
      </button>
      {g.extra}
    </div>
  );

  // The chip-able filter bar renders inside .cq-container (below). When it shows,
  // the container's own bottom border would land at the bottom of the filter
  // zone and stack with the next divider (a group header / first row) — at narrow
  // width, where the action cluster wraps right up against it, that reads as a
  // doubled line. So the container draws its bottom border only when the filter
  // bar is hidden; when shown, the filter bar's own top border separates it from
  // the toolbar and the content below owns the lower edge — one divider, not two.
  // The bar also has to appear for a MODIFIED view even with no chips showing:
  // clearing a view's only filter is a change you must be able to save or undo,
  // and hiding the bar would take both actions away at exactly that moment.
  const filterBarShown = !!filters && (filters.defs.some((d) => d.value) || !!filters.dirtyView);
  const tabSel = useMemo(() => tabSelection(tabs, activeTab), [tabs, activeTab]);
  const firstToggleTab = tabs.findIndex((t) => t.toggle);

  return (
    <div className="h-full flex flex-col">
      {/* Header. The outer wrapper is the container-query context; the inner
          .cq-header row is what adapts (wraps the toolbar below the tabs) as the
          panel narrows — a container can't query its own width, only a child's. */}
      <div className={`cq-container ${filterBarShown ? "" : "border-b border-sol-border/30"}`}>
        <div ref={titlebarRef} className="cq-header cq-header-pad cc-panel__head cc-panel__head--flow flex-wrap justify-between gap-x-2">
        <div className="flex items-center gap-2 min-w-0">
          <h1 className="sr-only">{title}</h1>
          {syncScope && <SyncProgressBadge scope={syncScope} />}
          {/* Wide header: segmented pill row. Once too tight for one row (≤1210px,
              see .cq-tabs-compact in globals.css): a single compact dropdown. */}
          <div className="cq-tabs-pills flex items-center gap-0.5 p-0.5 rounded-lg bg-sol-bg-alt/40 border border-sol-border/30 flex-wrap">
            {tabs.map((tab, i) => {
              const isActive = tabSel.active.has(tab.key);
              // Included but not picked: a preset stands for this tab. Same
              // fill as active, quieter text — "on", but not what you clicked.
              const isIncluded = tabSel.included.has(tab.key);
              const canToggle = !!(tab.toggle && onTabToggle);
              return (
              <button
                key={tab.key}
                onClick={(e) => {
                  if (canToggle && (e.shiftKey || e.metaKey || e.ctrlKey)) onTabToggle!(tab.key);
                  else onTabChange(tab.key);
                  setFocusIndex(0);
                }}
                title={tab.title ?? (canToggle ? `${tab.label} — shift-click to add or remove` : undefined)}
                className={`text-xs px-2.5 h-6 rounded-md transition-colors flex items-center gap-1.5 whitespace-nowrap flex-shrink-0 ${
                  isActive
                    ? "bg-sol-bg-highlight text-sol-text shadow-sm"
                    : isIncluded
                      ? "bg-[color-mix(in_srgb,var(--sol-bg-highlight)_60%,transparent)] text-sol-text-muted"
                      : "text-sol-text-dim hover:text-sol-text hover:bg-sol-bg-alt/60"
                } ${canToggle && i === firstToggleTab && i > 0 ? "ml-1.5 pl-2.5 border-l border-sol-border/40 rounded-l-none" : ""}`}
              >
                {tab.label}
                {tab.count != null && tab.count > 0 && <span className="text-[10px] tabular-nums opacity-60">{tab.count}</span>}
              </button>
              );
            })}
          </div>
          <div className="cq-tabs-compact">
            <TabDropdown
              tabs={tabs}
              activeTab={activeTab}
              onChange={(key) => { onTabChange(key); setFocusIndex(0); }}
              onToggle={onTabToggle ? (key) => { onTabToggle(key); setFocusIndex(0); } : undefined}
            />
          </div>
        </div>
        <div className="cq-header-toolbar flex flex-wrap items-center justify-end gap-1.5 ml-auto">
          {headerExtra}
          {selectedIds.size > 0 && (
            <span className="text-xs text-sol-cyan">{selectedIds.size} selected</span>
          )}
          {showSearch && getSearchText && (
            <input
              value={searchQuery}
              onChange={(e) => { setSearchQuery(e.target.value); setFocusIndex(0); }}
              onKeyDown={(e) => {
                if (e.key === "Escape") { setShowSearch(false); setSearchQuery(""); }
              }}
              placeholder="Search..."
              autoFocus
              className="text-xs w-40 h-7 px-2.5 rounded-md bg-sol-bg-alt border border-sol-cyan/40 text-sol-text placeholder:text-sol-text-dim focus:outline-none"
            />
          )}
          {getSearchText && (
            <button
              onClick={() => {
                if (showSearch && searchQuery) { setSearchQuery(""); }
                setShowSearch((s) => !s);
              }}
              className={`flex items-center justify-center w-7 h-7 rounded-md border transition-colors ${
                showSearch
                  ? "border-sol-cyan/40 text-sol-cyan bg-sol-cyan/5"
                  : "border-sol-border/40 text-sol-text-dim hover:text-sol-text hover:border-sol-border"
              }`}
              title="Search"
            >
              <Search className="w-3.5 h-3.5" />
            </button>
          )}
          {filters && <AddFilterMenu defs={filters.defs} variant="header" active={filters.defs.some((d) => d.value)} />}
          <DisplayMenu
            groupBy={groupBy}
            groupOptions={groupOptions}
            onGroupChange={onGroupChange ? (v) => { onGroupChange(v); setFocusIndex(0); } : undefined}
            subGroupBy={subGroupBy}
            subGroupOptions={subGroupOptions}
            onSubGroupChange={onSubGroupChange ? (v) => { onSubGroupChange(v); setFocusIndex(0); } : undefined}
            sortBy={sortBy}
            sortOptions={sortOptions}
            onSortChange={(v) => { onSortChange(v); setFocusIndex(0); }}
            sortDir={sortDir}
            onSortDirChange={onSortDirChange ? () => { onSortDirChange(); setFocusIndex(0); } : undefined}
            extra={displayExtra}
            onCopyLink={shareUrl ? copyViewLink : undefined}
          />
          <button
            onClick={() => openPalette("root")}
            className="cq-header-collapse flex items-center gap-1.5 text-xs h-7 px-2.5 rounded-md border border-sol-border/40 text-sol-text-dim hover:text-sol-text hover:border-sol-border transition-colors"
            title={`Command palette (${formatShortcutLabel('palette.toggle')})`}
          >
            <Command className="w-3 h-3" />K
          </button>
          <button
            onClick={onCreate}
            className="flex items-center justify-center w-7 h-7 rounded-full border border-sol-border/40 text-sol-text-dim hover:text-sol-text hover:border-sol-border transition-colors flex-shrink-0"
            title="Create new"
          >
            <Plus className="w-4 h-4" />
          </button>
        </div>
        </div>

        {/* Filter bar — only present once at least one chip-able filter is set (NOT
            filters.hasActive, which also counts the source toggle and would leave an
            empty chipless row). The header "Filter" button adds the first one. Kept
            INSIDE .cq-container so its labels and padding collapse with the panel
            width — a container query needs a containment ancestor or it falls back to
            the viewport (which is why these classes did nothing out here before). */}
        {filterBarShown && (
          <div className="cq-header-pad cq-filter-bar flex items-center flex-wrap gap-x-1.5 gap-y-1.5 px-6 py-2 border-t border-sol-border/30 bg-sol-bg-alt/20">
          {/* Active filters as removable chips; everything unset lives behind "+ Filter". */}
          {filters.defs.filter((f) => f.value).map((f) => (
            <FilterDropdown
              key={f.key}
              chip
              label={f.label}
              icon={f.icon}
              value={f.value}
              options={f.options}
              onChange={f.onChange}
              multi={f.multi}
            />
          ))}
          <AddFilterMenu defs={filters.defs} />

          {/* View actions — a tight right-aligned cluster. Each button shows its
              label at roomy widths and collapses to icon-only (cq-header-collapse)
              when the bar is narrow, so save / link / clear stay on one row
              instead of each wrapping to its own line. */}
          <div className="ml-auto flex items-center gap-0.5">
            {shareUrl && (
              <button
                onClick={copyViewLink}
                title="Copy link to this view"
                className="flex items-center gap-1 h-6 px-1.5 rounded-md text-[10px] text-sol-text-dim hover:text-sol-cyan hover:bg-sol-cyan/5 transition-colors"
              >
                <Link2 className="w-3 h-3 flex-shrink-0" />
                <span className="cq-header-collapse">Link</span>
              </button>
            )}
            {shareUrl && chatOn && (
              <button
                onClick={() => openForwardToChat({ url: shareUrl(), label: "view" })}
                title="Send this view to chat"
                className="flex items-center gap-1 h-6 px-1.5 rounded-md text-[10px] text-sol-text-dim hover:text-sol-cyan hover:bg-sol-cyan/5 transition-colors"
              >
                <Forward className="w-3 h-3 flex-shrink-0" />
                <span className="cq-header-collapse">Send</span>
              </button>
            )}
            {/* You changed the filters while inside a saved view. Offer to fold
                the change back in, or to throw it away — and keep the save
                button beside them, because the third honest answer is "this is
                a different view now". Only the author can update a view, so a
                teammate in a shared one gets discard and save-as instead. */}
            {filters.dirtyView && !savingView && (
              <>
                {filters.dirtyView.canUpdate && (
                  <button
                    onClick={filters.dirtyView.onUpdate}
                    title={`Save these filters into "${filters.dirtyView.name}"`}
                    className="flex items-center gap-1 h-6 px-1.5 rounded-md text-[10px] text-sol-cyan hover:bg-sol-cyan/10 transition-colors"
                  >
                    <Check className="w-3 h-3 flex-shrink-0" />
                    <span className="cq-header-collapse">Update view</span>
                  </button>
                )}
                <button
                  onClick={filters.dirtyView.onDiscard}
                  title={`Go back to "${filters.dirtyView.name}" as saved`}
                  className="flex items-center gap-1 h-6 px-1.5 rounded-md text-[10px] text-sol-text-dim hover:text-sol-text hover:bg-sol-bg-alt transition-colors"
                >
                  {/* A revert arrow, NOT an X: the labels collapse to icons in a
                      narrow pane, and Clear-filters beside it is already an X.
                      Two identical icons a few pixels apart, meaning different
                      things, is worse than no icon at all. */}
                  <RotateCcw className="w-3 h-3 flex-shrink-0" />
                  <span className="cq-header-collapse">Discard</span>
                </button>
              </>
            )}
            {filters.onSaveView && !savingView && (
              <button
                onClick={() => { setSavingView(true); setSaveViewName(""); }}
                title={filters.dirtyView ? "Save these filters as a new view" : "Save current view as a shortcut"}
                className="flex items-center gap-1 h-6 px-1.5 rounded-md text-[10px] text-sol-text-dim hover:text-sol-cyan hover:bg-sol-cyan/5 transition-colors"
              >
                {filters.dirtyView
                  ? <BookmarkPlus className="w-3 h-3 flex-shrink-0" />
                  : <Bookmark className="w-3 h-3 flex-shrink-0" />}
                <span className="cq-header-collapse">{filters.dirtyView ? "Save as new" : "Save view"}</span>
              </button>
            )}
            {filters.onSaveView && savingView && (
              <form
                className="flex items-center gap-1.5"
                onSubmit={(e) => {
                  e.preventDefault();
                  const name = saveViewName.trim();
                  if (name) {
                    filters.onSaveView!(name);
                    setSavingView(false);
                    toast.success(`View "${name}" saved`);
                  }
                }}
              >
                <input
                  autoFocus
                  value={saveViewName}
                  onChange={(e) => setSaveViewName(e.target.value)}
                  placeholder="View name..."
                  className="text-[11px] px-2 py-0.5 rounded bg-sol-bg border border-sol-border/60 text-sol-text outline-none focus:border-sol-cyan w-28"
                  onKeyDown={(e) => { if (e.key === "Escape") setSavingView(false); }}
                />
                <button
                  type="submit"
                  disabled={!saveViewName.trim()}
                  className="text-[10px] text-sol-cyan hover:text-sol-cyan/80 disabled:opacity-30 disabled:cursor-default flex items-center gap-0.5"
                  title="Save"
                >
                  <Check className="w-3 h-3" />
                </button>
                <button
                  type="button"
                  onClick={() => setSavingView(false)}
                  className="text-[10px] text-sol-text-dim hover:text-sol-text"
                  title="Cancel"
                >
                  <X className="w-3 h-3" />
                </button>
              </form>
            )}
            {filters.hasActive && (
              <button
                onClick={filters.onClear}
                title="Clear filters"
                className="flex items-center gap-1 h-6 px-1.5 rounded-md text-[10px] text-sol-text-dim hover:text-sol-text hover:bg-sol-bg-alt transition-colors"
              >
                <X className="w-3 h-3 flex-shrink-0" />
                <span className="cq-header-collapse">Clear</span>
              </button>
            )}
          </div>
        </div>
        )}
      </div>

      {/* Content area */}
      {customContent ? customContent({ openPaletteForItems, openContextMenuForItems }) : (
        <div className="flex-1 flex overflow-hidden">
          <div ref={scrollRef} className="flex-1 overflow-y-auto">
            {visibleItems.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-48 text-sol-text-dim">
                {emptyIcon}
                <p className="text-sm mt-2">{searchQuery ? "No results" : (emptyMessage || "No items found")}</p>
                {!searchQuery && (
                  <button onClick={onCreate} className="mt-3 text-sm text-sol-cyan hover:underline">
                    Create one
                  </button>
                )}
              </div>
            ) : (
              <div style={{ height: rowVirtualizer.getTotalSize(), width: "100%", position: "relative" }}>
                {rowVirtualizer.getVirtualItems().map((vi) => {
                  const row = rowModel[vi.index];
                  if (!row) return null;
                  return (
                    <div
                      key={vi.key}
                      data-index={vi.index}
                      ref={rowVirtualizer.measureElement}
                      style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${vi.start}px)` }}
                    >
                      {row.kind === "header"
                        ? renderGroupHeader(row.group, row.collapsed)
                        : renderItemRow(row.item, row.focusIndex, row.groupKey)}
                    </div>
                  );
                })}
              </div>
            )}

            {listFooter}

            {hasMore && onLoadMore && (
              <div ref={loadMoreRef} className="px-6 py-3 border-t border-sol-border/20">
                <button onClick={onLoadMore} className="text-xs text-sol-text-dim hover:text-sol-text transition-colors">
                  {isLoadingMore ? "Loading..." : "Load more"}
                </button>
              </div>
            )}
          </div>
          {previewItem && renderPreview && renderPreview(
            previewItem,
            () => setPreviewId(null),
            () => router.push(getItemRoute(previewItem))
          )}
        </div>
      )}

      {children}

      {contextMenuContent && (
        <ContextMenu state={ctxMenu}>{(items) => contextMenuContent(items)}</ContextMenu>
      )}
    </div>
  );
}
