import type { ListTab } from "./GenericListView";

/** The tab a value stands on, or none. A tab is a PRESET — a whole state of the
 *  list, not a member of a set — so it lights up only when the value is exactly
 *  its key. Anything finer is a filter, and says so as a chip in the filter bar. */
export function activeTabOf(tabs: ListTab[], activeTab: string): ListTab | null {
  return tabs.find((t) => t.key === activeTab) ?? null;
}

/** The pill/row label for the current selection. */
export function tabSelectionSummary(tabs: ListTab[], activeTab: string): { label: string; count?: number; icons: any[] } {
  const t = activeTabOf(tabs, activeTab);
  // A value no tab stands for (tasks: a hand-picked set of statuses, which
  // renders as a chip in the filter bar). Naming the first tab there would be a
  // lie — the list is filtered, just not to a preset.
  if (!t) return { label: activeTab ? "Filtered" : tabs[0]?.label ?? "", icons: [] };
  return { label: t.label, count: t.count, icons: t.icon ? [t.icon] : [] };
}
