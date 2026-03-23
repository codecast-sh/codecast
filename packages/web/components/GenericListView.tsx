"use client";
import { ReactNode, useState, useCallback, useMemo } from "react";
import { useRouter } from "next/navigation";
import { useWatchEffect } from "../hooks/useWatchEffect";
import { FilterDropdown } from "./FilterDropdown";
import { useInboxStore } from "../store/inboxStore";
import { KeyCap } from "./KeyboardShortcutsHelp";
import {
  Plus,
  SlidersHorizontal,
  X,
  Command,
  Check,
  Search,
} from "lucide-react";

export interface ListTab {
  key: string;
  label: string;
  count?: number;
}

export interface ListSortOption {
  value: string;
  label: string;
}

export interface ListFilterDef {
  key: string;
  label: string;
  icon: ReactNode;
  value: string;
  options: { key: string; label: string; icon?: any; color?: string }[];
  onChange: (v: string) => void;
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
  onLoadMore?: () => void;

  paletteTargetType?: 'task' | 'doc';
  paletteShortcuts?: { key: string; mode: string; label: string }[];
  paletteProps?: { teamMembers?: any[]; currentUser?: any };

  renderPreview?: (item: T, onClose: () => void, onOpen: () => void) => ReactNode;

  onItemEdit?: (item: T, newTitle: string) => void;

  getSearchText?: (item: T) => string;
  headerExtra?: ReactNode;
  customContent?: (helpers: { openPaletteForItems: (items: T[], mode?: string) => void }) => ReactNode;
  extraShortcuts?: { key: string; label: string }[];
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
  onLoadMore,
  paletteTargetType,
  paletteShortcuts,
  paletteProps,
  renderPreview,
  onItemEdit,
  getSearchText,
  headerExtra,
  customContent,
  extraShortcuts,
  extraKeyHandler,
  disableKeyboard,
  activeItemId,
  children,
}: GenericListViewProps<T>) {
  const router = useRouter();

  const [focusIndex, setFocusIndex] = useState(0);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [showFilters, setShowFilters] = useState(() => !!filters?.hasActive);
  const storeOpenPalette = useInboxStore((s) => s.openPalette);
  const paletteIsOpen = useInboxStore((s) => s.palette.open);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const shortcutsPanelOpen = useInboxStore(s => s.shortcutsPanelOpen);
  const [searchQuery, setSearchQuery] = useState("");
  const [showSearch, setShowSearch] = useState(false);

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
    const el = document.querySelector('[data-list-focused="true"]');
    if (el) (el as HTMLElement).scrollIntoView({ block: "nearest" });
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

      const stop = () => { e.preventDefault(); e.stopImmediatePropagation(); };

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

    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [shortcutsPanelOpen, disableKeyboard, paletteIsOpen, editingId, focusedItem, visibleItems, focusIndex, tabs,
    previewId, selectedIds, paletteShortcuts, onTabChange, getItemRoute, getItemId,
    onCreate, openPalette, toggleSelect, router, extraKeyHandler, onItemEdit, renderPreview, getSearchText]);

  const previewItem = previewId ? flatItems.find((item) => getItemId(item) === previewId) || null : null;

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
      onClick: () => router.push(getItemRoute(item)),
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

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-sol-border/30 min-h-0">
        <div className="flex items-center gap-4 min-w-0 overflow-hidden">
          <h1 className="text-lg font-semibold text-sol-text tracking-tight flex-shrink-0 cq-hide-compact">{title}</h1>
          <div className="flex gap-1 flex-nowrap overflow-hidden">
            {tabs.map((tab) => (
              <button
                key={tab.key}
                onClick={() => { onTabChange(tab.key); setFocusIndex(0); }}
                className={`text-xs px-2.5 py-1 rounded-md transition-colors flex items-center gap-1.5 whitespace-nowrap flex-shrink-0 ${
                  activeTab === tab.key ? "bg-sol-bg-highlight text-sol-text" : "text-sol-text-dim hover:text-sol-text"
                }`}
              >
                {tab.label}
                {tab.count != null && tab.count > 0 && <span className="text-[10px] tabular-nums opacity-60">{tab.count}</span>}
              </button>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-2">
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
              className="text-xs w-40 px-2.5 py-1.5 rounded-md bg-sol-bg-alt border border-sol-cyan/40 text-sol-text placeholder:text-sol-text-dim focus:outline-none"
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
          {filters && (
            <button
              onClick={() => setShowFilters((f) => !f)}
              className={`flex items-center gap-1.5 text-xs px-2 py-1.5 rounded-md border transition-colors ${
                showFilters || filters.hasActive
                  ? "border-sol-cyan/40 text-sol-cyan bg-sol-cyan/5"
                  : "border-sol-border/40 text-sol-text-dim hover:text-sol-text hover:border-sol-border"
              }`}
              title="Toggle filters"
            >
              <SlidersHorizontal className="w-3 h-3" />
              Filter
              {filters.hasActive && <span className="w-1.5 h-1.5 rounded-full bg-sol-cyan" />}
            </button>
          )}
          <select
            value={sortBy}
            onChange={(e) => { onSortChange(e.target.value); setFocusIndex(0); }}
            className="text-xs px-2 py-1 rounded-md bg-sol-bg-alt border border-sol-border/40 text-sol-text-dim focus:outline-none focus:border-sol-cyan cursor-pointer"
          >
            {sortOptions.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
          <button
            onClick={() => openPalette("root")}
            className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg border border-sol-border/40 text-sol-text-dim hover:text-sol-text hover:border-sol-border transition-colors"
            title="Command palette (Cmd+K)"
          >
            <Command className="w-3 h-3" />K
          </button>
          <button
            onClick={onCreate}
            className="flex items-center justify-center w-7 h-7 rounded-full border border-sol-border/40 text-sol-text-dim hover:text-sol-text hover:border-sol-border transition-colors"
            title="Create new"
          >
            <Plus className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Filter bar */}
      {filters && showFilters && (
        <div className="flex items-center gap-3 px-6 py-2.5 border-b border-sol-border/20 bg-sol-bg-alt/20">
          {filters.defs.map((f) => (
            <FilterDropdown
              key={f.key}
              label={f.label}
              icon={f.icon}
              value={f.value}
              options={f.options}
              onChange={f.onChange}
            />
          ))}
          {filters.hasActive && (
            <button
              onClick={filters.onClear}
              className="text-[10px] text-sol-text-dim hover:text-sol-text ml-1 flex items-center gap-1 transition-colors"
            >
              <X className="w-3 h-3" /> Clear
            </button>
          )}
        </div>
      )}

      {/* Content area */}
      {customContent ? customContent({ openPaletteForItems }) : (
        <div className="flex-1 flex overflow-hidden">
          <div className="flex-1 overflow-y-auto">
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
            ) : displayGroups ? (
              <GroupedList
                groups={displayGroups}
                collapsedGroups={collapsedGroups}
                onToggleGroup={toggleGroup}
                renderRow={renderItemRow}
              />
            ) : (
              <div>
                {displayFlatItems.map((item, i) => renderItemRow(item, i))}
              </div>
            )}

            {hasMore && onLoadMore && (
              <div className="px-6 py-3 border-t border-sol-border/20">
                <button onClick={onLoadMore} className="text-xs text-sol-text-dim hover:text-sol-text transition-colors">
                  Load more
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

      {/* Shortcut footer */}
      <div className="flex items-center gap-3 px-6 py-2 border-t border-sol-border/20 text-[10px] text-sol-text-dim overflow-hidden">
        <span className="flex items-center gap-1 shrink-0"><span className="flex items-center gap-[2px]"><KeyCap size="xs">J</KeyCap><KeyCap size="xs">K</KeyCap></span> navigate</span>
        <span className="flex items-center gap-1 shrink-0"><KeyCap size="xs">{"\u23CE"}</KeyCap> open</span>
        <span className="flex items-center gap-1 shrink-0"><KeyCap size="xs">C</KeyCap> create</span>
        <span className="flex items-center gap-1 shrink-0"><KeyCap size="xs">X</KeyCap> select</span>
        {(paletteShortcuts || []).map(({ key, label }) => (
          <span key={key} className="flex items-center gap-1 shrink-0"><KeyCap size="xs">{key}</KeyCap> {label}</span>
        ))}
        {renderPreview && (
          <span className="flex items-center gap-1 shrink-0"><KeyCap size="xs">{"\u2423"}</KeyCap> peek</span>
        )}
        <span className="flex items-center gap-1 shrink-0"><span className="flex items-center gap-[2px]"><KeyCap size="xs">{"\u2318"}</KeyCap><KeyCap size="xs">K</KeyCap></span> cmd</span>
        <span className="flex items-center gap-1 shrink-0"><KeyCap size="xs">?</KeyCap> help</span>
        {(extraShortcuts || []).map(({ key, label }) => (
          <span key={key} className="flex items-center gap-1 shrink-0"><KeyCap size="xs">{key}</KeyCap> {label}</span>
        ))}
      </div>

      {children}
    </div>
  );
}

function GroupedList<T>({
  groups,
  collapsedGroups,
  onToggleGroup,
  renderRow,
}: {
  groups: ListGroup<T>[];
  collapsedGroups: Set<string>;
  onToggleGroup: (key: string) => void;
  renderRow: (item: T, globalIdx: number) => ReactNode;
}) {
  let globalIdx = 0;
  return (
    <>
      {groups.map((g) => {
        const isCollapsed = collapsedGroups.has(g.key);
        const startIdx = globalIdx;
        if (!isCollapsed) globalIdx += g.items.length;
        return (
          <div key={g.key}>
            <div className="w-full flex items-center gap-2 px-4 py-2 bg-sol-bg-alt/30 border-b border-sol-border/20">
              <button
                onClick={() => onToggleGroup(g.key)}
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
            {!isCollapsed && g.items.map((item, i) => renderRow(item, startIdx + i))}
          </div>
        );
      })}
    </>
  );
}
