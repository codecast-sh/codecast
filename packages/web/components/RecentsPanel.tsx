import { useMemo, useRef, type ReactNode } from "react";
import { Command as CommandPrimitive } from "cmdk";
import { Search } from "lucide-react";
import { useWatchEffect } from "../hooks/useWatchEffect";
import { useInboxStore } from "../store/inboxStore";
import type { ResolvedVisit } from "../lib/recentVisits";
import { paletteItemScore } from "../lib/paletteActions";
import { RecentVisitRow } from "./RecentVisitRow";
import { visitDetailParts } from "../lib/recentVisitDetails";
import { KeyCap, MenuKeyCaps } from "./KeyboardShortcutsHelp";

// walk:   the held Ctrl+Tab overlay. Tab moves the frame; the search field is
//         there from the first paint, full size, waiting for R.
// search: the same panel with the field live — typing filters, arrows move,
//         Enter opens. Reached from the walk on R, or straight from Ctrl+R.
// menu:   search, anchored under the header button, with the chords in the
//         header so the mouse path teaches the keyboard one.
export type RecentsPanelMode = "walk" | "search" | "menu";

// cmdk matches on the text before `|||` (lib/paletteActions.paletteItemScore)
// and needs the whole value unique, so the visit key rides after the marker.
// The detail words are searchable so "union" finds a session by project and
// "claude" by agent, the same words the row shows.
function itemValue(item: ResolvedVisit, teams: any[]): string {
  return `${item.title} ${visitDetailParts(item, teams).join(" ")}|||${item.key}`;
}

const HINT = "flex items-center gap-1";

// The one recents list every keyboard and mouse path renders: header with the
// chords, the search field, the rows, the key legend. Selection is the
// caller's (an index into `items`), so the Ctrl+Tab walk can drive it from a
// held key while the search mode lets cmdk drive it from the field.
export function RecentsPanel({
  items,
  selectedIndex,
  onSelectedIndexChange,
  onSelect,
  mode,
  className,
  onItemContextMenu,
}: {
  items: ResolvedVisit[];
  selectedIndex: number;
  onSelectedIndexChange: (index: number) => void;
  onSelect: (item: ResolvedVisit) => void;
  mode: RecentsPanelMode;
  className: string;
  onItemContextMenu?: (e: React.MouseEvent, item: ResolvedVisit) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  // Snapshot at the same moment as the rows: the search text derives from the
  // store the rows were resolved from.
  const values = useMemo(() => {
    const teams = useInboxStore.getState().teams;
    return items.map((item) => itemValue(item, teams));
  }, [items]);
  const searching = mode !== "walk";

  useWatchEffect(() => {
    if (searching) inputRef.current?.focus();
  }, [searching]);

  return (
    <CommandPrimitive
      filter={paletteItemScore}
      value={values[selectedIndex] ?? ""}
      onValueChange={(v) => {
        const i = values.indexOf(v);
        if (i >= 0 && i !== selectedIndex) onSelectedIndexChange(i);
      }}
      loop
      className={`flex flex-col overflow-hidden ${className}`}
    >
      <div className="flex items-center gap-2 px-3 pt-2 pb-1">
        <span className="text-[10px] font-semibold uppercase tracking-widest text-sol-text-dim/70">
          Recently viewed
        </span>
        <span className="ml-auto flex items-center gap-2.5 text-[10px] text-sol-text-dim/60">
          {mode === "walk" && (
            <>
              <span className={HINT}><KeyCap size="xs">Tab</KeyCap><span>next</span></span>
              <span className={HINT}><KeyCap size="xs">Shift</KeyCap><KeyCap size="xs">Tab</KeyCap><span>back</span></span>
              <span className={HINT}><KeyCap size="xs">R</KeyCap><span>search</span></span>
            </>
          )}
          {mode === "menu" && (
            <span className={HINT}>
              <MenuKeyCaps action="recents.open" className="flex items-center gap-[2px]" />
              <span>search</span>
            </span>
          )}
          {mode !== "walk" && (
            <span className={HINT}>
              <MenuKeyCaps action="session.mruSwitch" className="flex items-center gap-[2px]" />
              <span>switch</span>
            </span>
          )}
        </span>
      </div>
      <div className="flex items-center gap-2.5 px-3 h-10 border-b border-sol-border/40">
        <Search className="w-4 h-4 flex-shrink-0 text-sol-text-dim" />
        <CommandPrimitive.Input
          ref={inputRef}
          tabIndex={searching ? 0 : -1}
          placeholder={mode === "walk" ? "Press R to search" : "Search recent…"}
          className="flex-1 min-w-0 bg-transparent text-[14px] text-sol-text placeholder:text-sol-text-dim/60 outline-none"
        />
      </div>
      <CommandPrimitive.List className="flex-1 overflow-y-auto overscroll-contain py-1 scrollbar-auto">
        <CommandPrimitive.Empty className="px-3 py-4 text-center text-xs text-sol-text-dim">
          {items.length === 0 ? "Nothing visited yet" : "No recent view matches"}
        </CommandPrimitive.Empty>
        {items.map((item, i) => (
          <CommandPrimitive.Item
            key={item.key}
            value={values[i]}
            onSelect={() => onSelect(item)}
            onContextMenu={onItemContextMenu ? (e) => onItemContextMenu(e, item) : undefined}
            className="mx-1 px-2 py-1.5 rounded-md flex items-center gap-2.5 cursor-default border border-transparent data-[selected=true]:bg-sol-cyan/15 data-[selected=true]:border-sol-cyan/30 transition-colors"
          >
            <RecentVisitRow
              item={item}
              trailing={i === 0 ? <span className="text-[10px] text-sol-text-dim/50 flex-shrink-0">current</span> : undefined}
            />
          </CommandPrimitive.Item>
        ))}
      </CommandPrimitive.List>
      <div className="flex items-center gap-3 px-3 py-1.5 border-t border-sol-border/30 text-[10px] text-sol-text-dim">
        {mode === "walk" ? (
          <span className={HINT}><span>release</span><KeyCap size="xs">Ctrl</KeyCap><span>to open</span></span>
        ) : (
          <>
            <span className={HINT}><KeyCap size="xs">&uarr;</KeyCap><KeyCap size="xs">&darr;</KeyCap>navigate</span>
            <span className={HINT}><KeyCap size="xs">&#9166;</KeyCap>open</span>
            <span className={HINT}><KeyCap size="xs">Esc</KeyCap>close</span>
          </>
        )}
      </div>
    </CommandPrimitive>
  );
}
