"use client";

import React, { useCallback, useMemo, useRef, useState } from "react";
import { ArrowUpDown, MonitorSmartphone, Search, Store, X } from "lucide-react";
import { FilterDropdown } from "../FilterDropdown";
import { SegmentedToggle, type SegmentedItem } from "../SegmentedToggle";
import { KeyCap, ShortcutTooltip } from "../KeyboardShortcutsHelp";
import { useShortcutAction, useShortcutContext } from "../../shortcuts";
import { useTabContext } from "../../lib/tabParams";
import {
  CapabilityCard,
  CAPABILITY_KINDS,
  KIND_META,
  type CapabilityDevice,
  type CapabilityKind,
  type CatalogEntry,
} from "./CapabilityCard";
import { alwaysOnTotal } from "./TokenCostBadge";
import { CatalogUnavailable, LoadingCards, NoMatches, SurfaceError } from "./EmptyStates";

/**
 * Browse the catalogs — Claude Code's own plugin marketplaces, and whatever else
 * has been ingested — with the one column no other browser has: where each entry
 * already lives across YOUR machines.
 *
 * `/plugin`, claude.com/plugins and skills.sh all render the same public rows.
 * The reason to look at them here is the cross-reference and the context cost,
 * so both are on every card and neither is behind a click.
 *
 * The catalog is public data and deliberately NOT a synced store collection —
 * thousands of rows per user in IndexedDB is a class of bug this repo has paid
 * for before. It arrives as a paginated page and this component renders whatever
 * page it is handed.
 */

export type LibrarySort = "relevance" | "name" | "installed" | "cost";
export type InstallFilter = "" | "installed" | "missing";

export interface LibraryBrowseProps {
  entries: CatalogEntry[] | undefined;
  devices: CapabilityDevice[];
  /** True while the first page is still in flight. */
  loading?: boolean;
  /** A failure to fetch — never conflated with an empty catalog. */
  error?: string | null;
  onRetry?: () => void;
  onOpen?: (entry: CatalogEntry) => void;
  /** Trailing controls per card — the equip control lands here. */
  renderActions?: (entry: CatalogEntry) => React.ReactNode;
  /** Paging, when the source has more. */
  hasMore?: boolean;
  loadingMore?: boolean;
  onLoadMore?: () => void;
}

/** Rank a search hit. Name matches beat description matches, and a prefix beats
 *  a substring, so typing three letters of a slug puts it first. */
function score(entry: CatalogEntry, q: string): number {
  const name = entry.name.toLowerCase();
  const slug = entry.slug.toLowerCase();
  if (name === q || slug === q) return 100;
  if (name.startsWith(q) || slug.startsWith(q)) return 80;
  if (name.includes(q) || slug.includes(q)) return 60;
  if ((entry.publisher ?? "").toLowerCase().includes(q)) return 40;
  if ((entry.marketplace ?? "").toLowerCase().includes(q)) return 35;
  if ((entry.description ?? "").toLowerCase().includes(q)) return 20;
  return 0;
}

/** How many of your machines actually have the bytes. A switched-off install
 *  still counts — it is downloaded and one toggle away — but a broken one does
 *  not, because nothing was ever downloaded there. */
function installedCount(entry: CatalogEntry, reportingIds: Set<string>): number {
  const seen = new Set<string>();
  for (const site of entry.installs ?? []) {
    if (!site.broken && reportingIds.has(site.deviceId)) seen.add(site.deviceId);
  }
  return seen.size;
}

export function LibraryBrowse({
  entries,
  devices,
  loading,
  error,
  onRetry,
  onOpen,
  hasMore,
  loadingMore,
  onLoadMore,
  renderActions,
}: LibraryBrowseProps) {
  const [query, setQuery] = useState("");
  // A kind we do not model is still a filter value, so this is a string.
  const [kind, setKind] = useState<CapabilityKind | string>("all");
  const [publisher, setPublisher] = useState("");
  const [install, setInstall] = useState<InstallFilter>("");
  const [sort, setSort] = useState<LibrarySort>("relevance");
  const [focusIndex, setFocusIndex] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);

  // Borrow the registered list shortcuts instead of inventing a second key
  // vocabulary: `/` focuses search, j/k walk the grid, Enter opens.
  //
  // Every handler declines when this pane is not the visible tab. Background
  // tabs stay mounted with `display:none` (TabContent.tsx:11-14), and the
  // dispatcher walks handlers until one returns true — so an invisible grid that
  // answered `j` would steal the key from the list the user is actually looking
  // at. Returning false passes it on.
  const tabCtx = useTabContext();
  const visible = tabCtx ? tabCtx.isActive : true;
  useShortcutContext("list", visible);
  useShortcutAction("list.search", () => {
    if (!visible) return false;
    searchRef.current?.focus();
    searchRef.current?.select();
    return true;
  });

  const reportingIds = useMemo(
    () => new Set(devices.filter((d) => d.reportedAt !== null).map((d) => d.deviceId)),
    [devices],
  );

  // Kind tabs are built from what the catalog actually holds — an "MCP servers"
  // tab that always shows zero is noise. Kinds this release has never modelled
  // come last, under their own name: Claude Code grows them faster than we do,
  // and a tab is the only way to reach one.
  const kindItems: SegmentedItem[] = useMemo(() => {
    const present = new Set((entries ?? []).map((e) => String(e.kind)));
    const items: SegmentedItem[] = [{ key: "all", label: "All" }];
    for (const k of CAPABILITY_KINDS) {
      if (!present.has(k)) continue;
      items.push({ key: k, label: KIND_META[k].plural, icon: KIND_META[k].icon, title: KIND_META[k].blurb });
      present.delete(k);
    }
    for (const k of [...present].sort()) {
      items.push({ key: k, label: k, title: `Reported by a machine as "${k}"` });
    }
    return items;
  }, [entries]);

  const publisherOptions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const e of entries ?? []) {
      const key = e.marketplace ?? e.publisher;
      if (!key) continue;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return [
      { key: "", label: "Any source" },
      ...[...counts.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([key, n]) => ({ key, label: `${key} (${n})` })),
    ];
  }, [entries]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = (entries ?? []).filter((e) => {
      if (kind !== "all" && String(e.kind) !== kind) return false;
      if (publisher && (e.marketplace ?? e.publisher) !== publisher) return false;
      if (install) {
        const n = installedCount(e, reportingIds);
        if (install === "installed" && n === 0) return false;
        if (install === "missing" && n > 0) return false;
      }
      if (q && score(e, q) === 0) return false;
      return true;
    });

    const cmp: Record<LibrarySort, (a: CatalogEntry, b: CatalogEntry) => number> = {
      relevance: (a, b) =>
        q
          ? score(b, q) - score(a, q) || a.name.localeCompare(b.name)
          : installedCount(b, reportingIds) - installedCount(a, reportingIds) ||
            a.name.localeCompare(b.name),
      name: (a, b) => a.name.localeCompare(b.name),
      installed: (a, b) =>
        installedCount(b, reportingIds) - installedCount(a, reportingIds) ||
        a.name.localeCompare(b.name),
      // Cheapest rent first, and entries with no reported cost sort last rather
      // than sorting as free.
      cost: (a, b) => {
        const ca = alwaysOnTotal([a.cost]);
        const cb = alwaysOnTotal([b.cost]);
        if (ca.known === 0 && cb.known === 0) return a.name.localeCompare(b.name);
        if (ca.known === 0) return 1;
        if (cb.known === 0) return -1;
        return ca.total - cb.total || a.name.localeCompare(b.name);
      },
    };
    return [...filtered].sort(cmp[sort]);
  }, [entries, kind, publisher, install, query, sort, reportingIds]);

  const clampedFocus = shown.length === 0 ? -1 : Math.min(focusIndex, shown.length - 1);

  const move = useCallback(
    (delta: number) => {
      if (!visible || shown.length === 0) return false;
      setFocusIndex((i) => {
        const next = Math.min(shown.length - 1, Math.max(0, (i < 0 ? 0 : i) + delta));
        // Keep the focused card on screen — a keyboard walk that scrolls out of
        // view is worse than no keyboard walk.
        requestAnimationFrame(() => {
          document
            .querySelector(`[data-catalog-index="${next}"]`)
            ?.scrollIntoView({ block: "nearest" });
        });
        return next;
      });
      return true;
    },
    [shown.length, visible],
  );

  useShortcutAction("list.down", () => move(1));
  useShortcutAction("list.up", () => move(-1));
  useShortcutAction("list.open", () => {
    const entry = shown[clampedFocus];
    if (!visible || !entry || !onOpen) return false;
    onOpen(entry);
    return true;
  });

  const clearAll = () => {
    setQuery("");
    setKind("all");
    setPublisher("");
    setInstall("");
  };
  const hasFilters = Boolean(query.trim() || kind !== "all" || publisher || install);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-sol-text-dim pointer-events-none" />
          <input
            ref={searchRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setFocusIndex(0);
            }}
            // The global dispatcher already skips shortcuts fired inside an
            // input, but Escape has to blur locally or the field keeps the
            // keyboard after the user is done with it.
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.stopPropagation();
                if (query) setQuery("");
                else searchRef.current?.blur();
              }
            }}
            placeholder="Search skills, plugins, MCP servers"
            className="w-full h-7 pl-7 pr-16 text-xs bg-sol-bg-alt border border-sol-border rounded text-sol-text placeholder:text-sol-text-dim outline-none focus:border-sol-magenta/60"
          />
          <span className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1">
            {query ? (
              <button
                type="button"
                onClick={() => setQuery("")}
                className="text-sol-text-dim hover:text-sol-text"
                aria-label="Clear search"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            ) : (
              <KeyCap size="xs">/</KeyCap>
            )}
          </span>
        </div>

        <FilterDropdown
          label="Source"
          icon={<Store className="w-3.5 h-3.5" />}
          value={publisher}
          options={publisherOptions}
          onChange={setPublisher}
        />
        <FilterDropdown
          label="Installed"
          icon={<MonitorSmartphone className="w-3.5 h-3.5" />}
          value={install}
          options={[
            { key: "", label: "Anywhere" },
            { key: "installed", label: "On a machine of mine" },
            { key: "missing", label: "On none of my machines" },
          ]}
          onChange={(v) => setInstall(v as InstallFilter)}
        />
        <FilterDropdown
          label="Sort"
          icon={<ArrowUpDown className="w-3.5 h-3.5" />}
          value={sort}
          options={[
            { key: "relevance", label: "Relevance" },
            { key: "installed", label: "Most installed" },
            { key: "name", label: "Name" },
            { key: "cost", label: "Cheapest context" },
          ]}
          onChange={(v) => setSort((v || "relevance") as LibrarySort)}
        />
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <SegmentedToggle
          value={kind}
          onChange={(k) => {
            setKind(k);
            setFocusIndex(0);
          }}
          items={kindItems}
          collapse
        />
        <div className="flex-1" />
        <span className="text-[11px] text-sol-text-dim font-mono">
          {shown.length}
          {entries && shown.length !== entries.length ? ` / ${entries.length}` : ""}
        </span>
        {hasFilters && (
          <button
            type="button"
            onClick={clearAll}
            className="text-[11px] text-sol-magenta hover:underline"
          >
            Clear
          </button>
        )}
        <ShortcutTooltip label="Move" action="list.down" hint="and k for up" side="bottom">
          <span className="hidden sm:inline-flex items-center gap-1 text-[10px] text-sol-text-dim cursor-default">
            <KeyCap size="xs">j</KeyCap>
            <KeyCap size="xs">k</KeyCap>
          </span>
        </ShortcutTooltip>
      </div>

      {error ? (
        <SurfaceError title="Couldn't load the catalog" detail={error} onRetry={onRetry} />
      ) : loading && !entries ? (
        <LoadingCards />
      ) : !entries ? (
        <CatalogUnavailable />
      ) : entries.length === 0 ? (
        <CatalogUnavailable />
      ) : shown.length === 0 ? (
        <NoMatches query={query.trim() || undefined} onClear={hasFilters ? clearAll : undefined} />
      ) : (
        <>
          <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(320px,1fr))]">
            {shown.map((entry, i) => (
              <div key={entry.slug} data-catalog-index={i}>
                <CapabilityCard
                  entry={entry}
                  devices={devices}
                  focused={i === clampedFocus}
                  onOpen={onOpen}
                  actions={renderActions?.(entry)}
                />
              </div>
            ))}
          </div>
          {hasMore && (
            <div className="flex justify-center py-2">
              <button
                type="button"
                onClick={onLoadMore}
                disabled={loadingMore}
                className="text-xs text-sol-magenta hover:underline disabled:text-sol-text-dim disabled:no-underline"
              >
                {loadingMore ? "Loading…" : "Load more"}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
