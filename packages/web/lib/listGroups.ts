// Nested groups in a flat list (GenericListView). A group's `depth` nests it
// under the nearest earlier group with a smaller depth; the list itself stays
// one flat stream of headers and rows, so these two rules are all nesting
// costs: what a collapsed parent hides, and what a search keeps.
import type { ListGroup } from "../components/GenericListView";

/** The groups a reader can see: a collapsed group keeps its header and hides
 *  every group nested under it. */
export function visibleGroups<T>(groups: ListGroup<T>[], collapsed: Set<string>): { group: ListGroup<T>; collapsed: boolean }[] {
  const out: { group: ListGroup<T>; collapsed: boolean }[] = [];
  let hiddenBelow: number | null = null;
  for (const group of groups) {
    const depth = group.depth ?? 0;
    if (hiddenBelow !== null && depth > hiddenBelow) continue;
    const isCollapsed = collapsed.has(group.key);
    hiddenBelow = isCollapsed ? depth : null;
    out.push({ group, collapsed: isCollapsed });
  }
  return out;
}

/** Drop the groups a search emptied, keeping an empty one that still has a
 *  match nested under it: a nested group with nothing over it cannot be read. */
export function groupsWithItems<T>(groups: ListGroup<T>[]): ListGroup<T>[] {
  return groups.filter((g, i) => {
    if (g.items.length > 0) return true;
    for (let j = i + 1; j < groups.length && (groups[j].depth ?? 0) > (g.depth ?? 0); j++) {
      if (groups[j].items.length > 0) return true;
    }
    return false;
  });
}
