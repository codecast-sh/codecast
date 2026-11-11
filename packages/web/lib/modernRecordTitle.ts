// Modern's names for the object pages that Classic's tab titles leave to
// their kind ("Doc", "Plan", "Trigger", "Call"): the object's own title, read
// by key (or the store's memoized short id index, never a scan), so a tab
// title can derive on every store tick. lib/tabTitle asks this first while
// Modern is on, and lib/placeTitle reads it, so a page has one name in the
// tab, the header's crumbs, the back control, the trail and the history menu.

import { lookup } from "./liveEntities";

type Rows = Record<string, any> | undefined;

/** The name of the object a path shows, or null when the store does not hold it. */
export function modernRecordTitle(path: string, s: { [key: string]: unknown } | undefined): string | null {
  if (!s) return null;
  const [, kind, ref, sub] = path.split("#")[0].split("?")[0].split("/");
  if (!ref) return null;
  const rows = (key: string) => s[key] as Rows;
  const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.replace(/\s+/g, " ").trim() : null);
  switch (kind) {
    case "tasks":
      return text(lookup(rows("tasks"), ref)?.title);
    case "projects":
      // A task opened inside its project is named by the task.
      return sub ? text(lookup(rows("tasks"), sub)?.title) : null;
    case "docs": {
      const d = rows("docDetails")?.[ref] ?? lookup(rows("docs"), ref);
      return text(d?.display_title) ?? text(d?.title);
    }
    case "plans":
      return text(lookup(rows("plans"), ref)?.title);
    case "triggers":
    case "schedules": {
      const t = lookup(rows("agentTasks"), ref);
      return text(t?.display_title) ?? text(t?.title);
    }
    case "calls": {
      const c = rows("callDetails")?.[ref] ?? rows("callList")?.[ref];
      return text(c?.title);
    }
    default:
      return null;
  }
}
