import { isValidTaskGroup } from "../../lib/taskGrouping";

// Grouping vs sorting are independent axes (see useTaskUrlState). These name the
// legal values for each, so we can both validate input and migrate the legacy
// single `sort` param that overloaded the two.
// Legal group values are "none" or one or more axis names joined by "+"
// ("assignee", "assignee+project") — lib/taskGrouping owns that vocabulary.
const TASK_SORT_VALUES = new Set(["priority", "created", "updated", "title", "manual"]);
// Natural direction per sort field — picking a field resets to this so "Created"
// lands newest-first and "Priority"/"Title" land most-urgent / A→Z without a
// second click. The user can still flip it with the direction toggle.
const TASK_SORT_DEFAULT_DIR: Record<string, "asc" | "desc"> = {
  priority: "asc", title: "asc", created: "desc", updated: "desc", manual: "asc",
};
export function taskDefaultDir(sort: string): "asc" | "desc" {
  return TASK_SORT_DEFAULT_DIR[sort] ?? "asc";
}
/** Resolve raw (URL or stored) group/sort/dir into a valid triple, migrating the
 *  legacy overloaded `sort`. Legacy values: a grouping word ("plan", "label", …)
 *  became `group=that, sort=priority`; a flat-sort word ("updated", …) became
 *  `group=none`; anything else falls to the default `group=status`. */
export function normalizeTaskSort(rawGroup: string, rawSort: string, rawDir: string) {
  let group = isValidTaskGroup(rawGroup) ? rawGroup : "";
  let sort = TASK_SORT_VALUES.has(rawSort) ? rawSort : "";
  if (!group) {
    if (isValidTaskGroup(rawSort)) { group = rawSort; sort = sort || "priority"; }
    else if (TASK_SORT_VALUES.has(rawSort)) { group = "none"; }
    else group = "status";
  }
  if (!sort) sort = "priority";
  const dir: "asc" | "desc" = rawDir === "asc" || rawDir === "desc" ? rawDir : taskDefaultDir(sort);
  return { group, sort, dir };
}
