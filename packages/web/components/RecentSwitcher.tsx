import type { ResolvedVisit } from "../lib/recentVisits";
import { RecentsPanel, type RecentsPanelMode } from "./RecentsPanel";

// The centered recents overlay (hooks/useRecentSwitcher): the held Ctrl+Tab
// walk, and the same panel with its search field live once R is pressed or
// Ctrl+R opened it directly.
export function RecentSwitcher({
  items,
  selectedIndex,
  mode,
  onSelectedIndexChange,
  onSelect,
}: {
  items: ResolvedVisit[];
  selectedIndex: number;
  mode: Exclude<RecentsPanelMode, "menu">;
  onSelectedIndexChange: (index: number) => void;
  onSelect: (item: ResolvedVisit) => void;
}) {
  if (items.length === 0) return null;

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center pointer-events-none">
      <RecentsPanel
        items={items}
        selectedIndex={selectedIndex}
        onSelectedIndexChange={onSelectedIndexChange}
        onSelect={onSelect}
        mode={mode}
        className="pointer-events-auto w-[480px] max-h-[min(560px,75vh)] rounded-lg border border-sol-border/60 bg-sol-bg/95 backdrop-blur-xl shadow-2xl shadow-black/40"
      />
    </div>
  );
}
