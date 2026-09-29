import { AlarmClock, Compass, ListChecks, MessageCircleQuestionMark, Rss, Settings2, Terminal } from "lucide-react";

export type ScopeTabKey = "scope" | "feed" | "work" | "sessions" | "decisions" | "triggers" | "settings";

/** What the Work tab lists: tasks, the same tasks by status, plans, pages. */
export type ScopeWorkView = "tasks" | "status" | "plans" | "pages";

export const SCOPE_WORK_VIEWS: { key: ScopeWorkView; label: string }[] = [
  { key: "tasks", label: "Tasks" },
  { key: "status", label: "By status" },
  { key: "plans", label: "Plans" },
  { key: "pages", label: "Pages" },
];

/** A role's page has six tabs and the workspace's four. A role opens on its
 *  Overview (what it is for, where things stand, what it is doing, its notes
 *  and what happened lately); the workspace has no role to describe, so it
 *  keeps the activity as a tab of its own. */
export const SCOPE_TABS: { key: ScopeTabKey; label: string; icon: any; roleOnly?: boolean; rootOnly?: boolean }[] = [
  { key: "scope", label: "Overview", icon: Compass, roleOnly: true },
  { key: "feed", label: "Activity", icon: Rss, rootOnly: true },
  { key: "work", label: "Work", icon: ListChecks },
  { key: "sessions", label: "Sessions", icon: Terminal },
  { key: "decisions", label: "Decisions", icon: MessageCircleQuestionMark },
  // The role's triggers (org-staffing.md S25): its check and anything else that wakes it on its own.
  { key: "triggers", label: "Triggers", icon: AlarmClock, roleOnly: true },
  { key: "settings", label: "Settings", icon: Settings2, roleOnly: true },
];

export function scopeTabsFor(hasRole: boolean) {
  return SCOPE_TABS.filter((t) => (hasRole ? !t.rootOnly : !t.roleOnly));
}

/** Links written before the tabs were cut still land on what they named. */
const MOVED: Record<string, { tab: ScopeTabKey; view?: ScopeWorkView }> = {
  tasks: { tab: "work", view: "tasks" },
  line: { tab: "work", view: "status" },
  plans: { tab: "work", view: "plans" },
  docs: { tab: "work", view: "pages" },
  brief: { tab: "scope" },
  charter: { tab: "scope" },
};

/** The tab a scope opens on, and the one its bare URL means: a role's
 *  Overview, the workspace's activity. */
export function scopeDefaultTab(hasRole: boolean): ScopeTabKey {
  return hasRole ? "scope" : "feed";
}

/** The tab a URL names, when it is one this scope shows; else the default. */
export function scopeTabFromParam(param: string | null, hasRole: boolean): ScopeTabKey {
  const key = (param && MOVED[param]?.tab) || param;
  const hit = scopeTabsFor(hasRole).find((t) => t.key === key);
  return hit ? hit.key : scopeDefaultTab(hasRole);
}

/** The Work view a URL written for an older tab means. */
export function scopeWorkViewFromParam(param: string | null): ScopeWorkView {
  return (param && MOVED[param]?.view) || "tasks";
}
