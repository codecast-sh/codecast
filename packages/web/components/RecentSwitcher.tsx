import { useRef } from "react";
import { useWatchEffect } from "../hooks/useWatchEffect";
import type { ResolvedVisit } from "../lib/recentVisits";
import { RecentVisitRow } from "./RecentVisitRow";
import { KeyCap } from "./KeyboardShortcutsHelp";

// The Ctrl+Tab overlay: the recents list with one row framed. Rows carry the
// object's own detail (RecentVisitRow) so a task, a plan and a session with
// similar titles read apart at a glance.
export function RecentSwitcher({
  items,
  selectedIndex,
}: {
  items: ResolvedVisit[];
  selectedIndex: number;
}) {
  const selectedRef = useRef<HTMLDivElement>(null);

  useWatchEffect(() => {
    selectedRef.current?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  if (items.length === 0) return null;

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center pointer-events-none">
      <div className="pointer-events-auto w-[460px] max-h-[min(560px,75vh)] flex flex-col rounded-lg border border-sol-border/60 bg-sol-bg/95 backdrop-blur-xl shadow-2xl shadow-black/40 overflow-hidden">
        <div className="px-3 py-2 border-b border-sol-border/40 flex items-center gap-2">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-sol-text-dim">
            Recently viewed
          </span>
          <span className="ml-auto flex items-center gap-1 text-[10px] text-sol-text-dim/60">
            <KeyCap size="xs">Tab</KeyCap>
            <span>next</span>
            <KeyCap size="xs">Shift</KeyCap>
            <KeyCap size="xs">Tab</KeyCap>
            <span>back</span>
          </span>
        </div>
        <div className="flex-1 overflow-y-auto py-1 scrollbar-auto">
          {items.map((item, i) => {
            const isSelected = i === selectedIndex;
            return (
              <div
                key={item.key}
                ref={isSelected ? selectedRef : undefined}
                className={`mx-1 px-2.5 py-1.5 rounded-md flex items-center gap-2.5 transition-colors ${
                  isSelected ? "bg-sol-cyan/20 border border-sol-cyan/40" : "border border-transparent"
                }`}
              >
                <RecentVisitRow
                  item={item}
                  selected={isSelected}
                  trailing={i === 0 ? <span className="text-[10px] text-sol-text-dim/50 flex-shrink-0">current</span> : undefined}
                />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
