"use client";
import { ReactNode, useState, useCallback, useMemo, useEffect, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useRouter } from "next/navigation";
import { useWatchEffect } from "../hooks/useWatchEffect";
import { FilterDropdown, FilterOptionList } from "./FilterDropdown";
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
  ChevronDown,
  ChevronRight,
  ChevronLeft,
} from "lucide-react";

export interface ListTab {
  key: string;
  label: string;
  count?: number;
  /** Optional leading icon (lucide component). When present, the compact
   *  dropdown can shed its text label and collapse to icon-only at tight widths. */
  icon?: any;
}

/** Compact stand-in for the status pill row, shown when the header is too narrow
 *  to fit every pill (see .cq-tabs-compact). Surfaces the active tab + count and
 *  drops the full list into a popover so no status is ever scrolled out of reach. */
function TabDropdown({
  tabs,
  activeTab,
  onChange,
}: {
  tabs: ListTab[];
  activeTab: string;
  onChange: (key: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const active = tabs.find((t) => t.key === activeTab) ?? tabs[0];

  useWatchEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const ActiveIcon = active?.icon;
  // The label/count only collapse when there's an icon to stand in for them, so
  // icon-less consumers (e.g. Docs) keep their text at every width.
  const labelCollapse = ActiveIcon ? "cq-tab-label" : "";

  return (
    <div ref={ref} className="relative flex-shrink-0">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 h-7 px-2 rounded-md bg-sol-bg-alt border border-sol-border/40 text-xs text-sol-text hover:border-sol-border transition-colors"
        title={active?.label}
      >
        {ActiveIcon && <ActiveIcon className="w-3.5 h-3.5 flex-shrink-0 text-sol-text-muted" />}
        <span className={`font-medium whitespace-nowrap ${labelCollapse}`}>{active?.label}</span>
        {active?.count != null && active.count > 0 && (
          <span className={`text-[10px] tabular-nums text-sol-text-dim ${labelCollapse}`}>{active.count}</span>
        )}
        <ChevronDown className="w-3 h-3 opacity-60 flex-shrink-0" />
      </button>
      {open && (
        <div className="absolute top-full left-0 mt-1 w-48 bg-sol-bg border border-sol-border rounded-lg shadow-xl z-[60] py-1">
          {tabs.map((t) => {
            const TIcon = t.icon;
            return (
              <button
                key={t.key}
                onClick={() => { onChange(t.key); setOpen(false); }}
                className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs transition-colors ${
                  t.key === activeTab ? "bg-sol-bg-highlight text-sol-text" : "text-sol-text-muted hover:bg-sol-bg-alt"
                }`}
              >
                {TIcon && <TIcon className="w-3.5 h-3.5 flex-shrink-0 text-sol-text-dim" />}
                <span className="flex-1 text-left whitespace-nowrap">{t.label}</span>
                {t.count != null && t.count > 0 && (
                  <span className="text-[10px] tabular-nums text-sol-text-dim">{t.count}</span>
                )}
                {t.key === activeTab && <Check className="w-3 h-3 text-sol-cyan flex-shrink-0" />}
              </button>
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

/** Linear-style "Display" popover. Folds the grouping control — and any
 *  page-specific display options (e.g. a List/Board switch passed as `extra`) —
 *  behind one button, so the header toolbar stays a single compact row instead
 *  of spilling a wide <select> across it. Same popover pattern as TabDropdown. */
function DisplayMenu({
  sortBy,
  sortOptions,
  onSortChange,
  extra,
}: {
  sortBy: string;
  sortOptions: ListSortOption[];
  onSortChange: (v: string) => void;
  extra?: ReactNode;
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

  return (
    <div ref={ref} className="relative flex-shrink-0">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 h-7 px-2.5 rounded-md border border-sol-border/40 text-xs text-sol-text-dim hover:text-sol-text hover:border-sol-border transition-colors"
        title="Display options"
      >
        <SlidersHorizontal className="w-3 h-3 flex-shrink-0" />
        <span className="cq-header-collapse">Display</span>
        <ChevronDown className="w-3 h-3 opacity-60 flex-shrink-0" />
      </button>
      {open && (
        <div className="absolute top-full right-0 mt-1 w-56 bg-sol-bg border border-sol-border rounded-lg shadow-xl z-[60] p-2 space-y-3">
          {extra && <div className="flex flex-col gap-2">{extra}</div>}
          <div>
            <div className="text-[10px] uppercase tracking-wider text-sol-text-dim px-1 mb-1">Grouping</div>
            <div className="space-y-0.5">
              {sortOptions.map((o) => (
                <button
                  key={o.value}
                  onClick={() => { onSortChange(o.value); setOpen(false); }}
                  className={`w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs transition-colors ${
                    o.value === sortBy ? "bg-sol-bg-highlight text-sol-text" : "text-sol-text-muted hover:bg-sol-bg-alt"
                  }`}
                >
                  <span className="flex-1 text-left whitespace-nowrap">{o.label}</span>
                  {o.value === sortBy && <Check className="w-3 h-3 text-sol-cyan flex-shrink-0" />}
                </button>
              ))}
            </div>
          </div>
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
          <span>Filter</span>
        </button>
      )}
      {open && (
        <div className={`absolute top-full ${variant === "header" ? "right-0" : "left-0"} mt-1 w-48 bg-sol-bg border border-sol-border rounded-lg shadow-xl z-[60] py-1 max-h-72 overflow-y-auto`}>
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
                options={cat.options.filter((o) => o.key !== "")}
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
  activeTab: string;
  onTabChange: (tab: string) => void;

  sortBy: string;
  sortOptions: ListSortOption[];
  onSortChange: (sort: string) => void;

  filters?: {
    hasActive: boolean;
    defs: ListFilterDef[];
    onClear: () => void;
    onSaveView?: (name: string) => void;
  };

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
  paletteShortcuts?: { key: string; mode: string; label: string }[];
  paletteProps?: { teamMembers?: any[]; currentUser?: any };

  renderPreview?: (item: T, onClose: () => void, onOpen: () => void) => ReactNode;

  onItemEdit?: (item: T, newTitle: string) => void;

  getSearchText?: (item: T) => string;
  /** When set, a subtle "syncing N" whisper renders next to the title while the
   *  reconcile crawl for this scope ("tasks" | "docs") is still streaming in. */
  syncScope?: string;
  headerExtra?: ReactNode;
  /** Page-specific controls rendered inside the Display popover (e.g. a List/Board
   *  view switch). Kept out of the always-visible toolbar to stay Linear-compact. */
  displayExtra?: ReactNode;
  listFooter?: ReactNode;
  customContent?: (helpers: { openPaletteForItems: (items: T[], mode?: string) => void }) => ReactNode;
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
  sortBy,
  sortOptions,
  onSortChange,
  filters,
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
  paletteShortcuts,
  paletteProps,
  renderPreview,
  onItemEdit,
  getSearchText,
  syncScope,
  headerExtra,
  displayExtra,
  listFooter,
  customContent,
  extraKeyHandler,
  disableKeyboard,
  activeItemId,
  children,
}: GenericListViewProps<T>) {
  const router = useRouter();

  const [focusIndex, setFocusIndex] = useState(0);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const storeOpenPalette = useInboxStore((s) => s.openPalette);
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

  const displayGroups = useMemo((): ListGroup<T>[] | null => {
    if (!groups) return null;
    if (!searchQuery || !getSearchText) return groups;
    const q = searchQuery.toLowerCase();
    return groups
      .map(g => ({ ...g, items: g.items.filter(item => getSearchText(item).toLowerCase().includes(q)) }))
      .filter(g => g.items.length > 0);
  }, [groups, searchQuery, getSearchText]);

  const displayFlatItems = useMemo(() => {
    if (groups) return flatItems;
    if (!searchQuery || !getSearchText) return flatItems;
    const q = searchQuery.toLowerCase();
    return flatItems.filter(item => getSearchText(item).toLowerCase().includes(q));
  }, [groups, flatItems, searchQuery, getSearchText]);

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
    | { kind: "item"; key: string; item: T; focusIndex: number };
  const rowModel = useMemo<RowEntry[]>(() => {
    const rows: RowEntry[] = [];
    if (displayGroups) {
      let fi = 0;
      for (const g of displayGroups) {
        const collapsed = collapsedGroups.has(g.key);
        rows.push({ kind: "header", key: `__hdr_${g.key}`, group: g, collapsed });
        if (!collapsed) {
          for (const item of g.items) {
            rows.push({ kind: "item", key: getItemId(item), item, focusIndex: fi });
            fi++;
          }
        }
      }
    } else {
      displayFlatItems.forEach((item, i) => {
        rows.push({ kind: "item", key: getItemId(item), item, focusIndex: i });
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
      if (e.key === " " && !e.metaKey && !e.ctrlKey && renderPreview) {
        stop();
        if (focusedItem) {
          const id = getItemId(focusedItem);
          setPreviewId((prev) => prev === id ? null : id);
        }
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
    previewId, selectedIds, paletteShortcuts, onTabChange, getItemRoute, getItemId,
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

  const renderItemRow = (item: T, globalIdx: number) => {
    const id = getItemId(item);
    const isFocused = focusIndex === globalIdx;
    const isSelected = selectedIds.has(id);
    const isEditing = editingId === id;
    const isActive = activeItemId === id;

    const state: ItemRowState = {
      isFocused,
      isSelected,
      isEditing,
      onClick: () => { setFocusIndex(globalIdx); router.push(getItemRoute(item)); },
      onSelect: () => toggleSelect(id),
      onContextMenu: (e: React.MouseEvent) => {
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
        className={`w-full flex items-center gap-3 px-4 py-2.5 transition-colors text-left group border-b border-sol-border/20 cursor-pointer select-none ${
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
    <div className="w-full flex items-center gap-2 px-4 py-2 bg-sol-bg-alt/30 border-b border-sol-border/20">
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

  return (
    <div className="h-full flex flex-col">
      {/* Header. The outer wrapper is the container-query context; the inner
          .cq-header row is what adapts (wraps the toolbar below the tabs) as the
          panel narrows — a container can't query its own width, only a child's. */}
      <div className="cq-container border-b border-sol-border/30">
        <div className="cq-header flex flex-wrap items-center justify-between gap-x-3 gap-y-2 px-6 py-3">
        <div className="flex items-center gap-3 flex-1">
          <h1 className="text-lg font-semibold text-sol-text tracking-tight flex-shrink-0 cq-header-collapse">{title}</h1>
          {syncScope && <SyncProgressBadge scope={syncScope} />}
          {/* Wide header: segmented pill row. Once too tight for one row (≤1210px,
              see .cq-tabs-compact in globals.css): a single compact dropdown. */}
          <div className="cq-tabs-pills flex items-center gap-0.5 p-0.5 rounded-lg bg-sol-bg-alt/40 border border-sol-border/30 flex-wrap">
            {tabs.map((tab) => (
              <button
                key={tab.key}
                onClick={() => { onTabChange(tab.key); setFocusIndex(0); }}
                className={`text-xs px-2.5 h-6 rounded-md transition-colors flex items-center gap-1.5 whitespace-nowrap flex-shrink-0 ${
                  activeTab === tab.key
                    ? "bg-sol-bg-highlight text-sol-text shadow-sm"
                    : "text-sol-text-dim hover:text-sol-text hover:bg-sol-bg-alt/60"
                }`}
              >
                {tab.label}
                {tab.count != null && tab.count > 0 && <span className="text-[10px] tabular-nums opacity-60">{tab.count}</span>}
              </button>
            ))}
          </div>
          <div className="cq-tabs-compact">
            <TabDropdown
              tabs={tabs}
              activeTab={activeTab}
              onChange={(key) => { onTabChange(key); setFocusIndex(0); }}
            />
          </div>
        </div>
        <div className="cq-header-toolbar flex items-center gap-1.5 ml-auto">
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
            sortBy={sortBy}
            sortOptions={sortOptions}
            onSortChange={(v) => { onSortChange(v); setFocusIndex(0); }}
            extra={displayExtra}
          />
          <button
            onClick={() => openPalette("root")}
            className="cq-header-collapse flex items-center gap-1.5 text-xs h-7 px-2.5 rounded-md border border-sol-border/40 text-sol-text-dim hover:text-sol-text hover:border-sol-border transition-colors"
            title="Command palette (Cmd+K)"
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
      </div>

      {/* Filter bar — only present once at least one chip-able filter is set (NOT
          filters.hasActive, which also counts the source toggle and would leave an
          empty chipless row). The header "Filter" button adds the first one. */}
      {filters && filters.defs.some((d) => d.value) && (
        <div className="flex items-center flex-wrap gap-x-1.5 gap-y-1.5 px-6 py-2 border-b border-sol-border/20 bg-sol-bg-alt/20">
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
          {filters.hasActive && (
            <button
              onClick={filters.onClear}
              className="text-[10px] text-sol-text-dim hover:text-sol-text ml-1 flex items-center gap-1 transition-colors"
            >
              <X className="w-3 h-3" /> Clear
            </button>
          )}
          {filters.onSaveView && !savingView && (
            <button
              onClick={() => { setSavingView(true); setSaveViewName(""); }}
              className="text-[10px] text-sol-text-dim hover:text-sol-cyan ml-1 flex items-center gap-1 transition-colors"
              title="Save current view as a shortcut"
            >
              <Bookmark className="w-3 h-3" /> Save View
            </button>
          )}
          {filters.onSaveView && savingView && (
            <form
              className="flex items-center gap-1.5 ml-1"
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
                className="text-[11px] px-2 py-0.5 rounded bg-sol-bg border border-sol-border/60 text-sol-text outline-none focus:border-sol-cyan w-32"
                onKeyDown={(e) => { if (e.key === "Escape") setSavingView(false); }}
              />
              <button
                type="submit"
                disabled={!saveViewName.trim()}
                className="text-[10px] text-sol-cyan hover:text-sol-cyan/80 disabled:opacity-30 disabled:cursor-default flex items-center gap-0.5"
              >
                <Check className="w-3 h-3" /> Save
              </button>
              <button
                type="button"
                onClick={() => setSavingView(false)}
                className="text-[10px] text-sol-text-dim hover:text-sol-text"
              >
                <X className="w-3 h-3" />
              </button>
            </form>
          )}
        </div>
      )}

      {/* Content area */}
      {customContent ? customContent({ openPaletteForItems }) : (
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
                        : renderItemRow(row.item, row.focusIndex)}
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
    </div>
  );
}
