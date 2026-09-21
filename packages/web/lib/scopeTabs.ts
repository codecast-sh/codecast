import { BellRing, CheckSquare, Compass, FileText, Layers, ListChecks, MessageCircleQuestionMark, Rss, ScrollText, Settings2, Terminal, Workflow } from "lucide-react";

export type ScopeTabKey = "scope" | "feed" | "tasks" | "line" | "plans" | "docs" | "sessions" | "decisions" | "brief" | "charter" | "wakes" | "settings";

export const SCOPE_TABS: { key: ScopeTabKey; label: string; icon: any; roleOnly?: boolean }[] = [
  { key: "scope", label: "Scope", icon: Compass, roleOnly: true },
  { key: "feed", label: "Feed", icon: Rss },
  { key: "tasks", label: "Tasks", icon: ListChecks },
  // The line (the-line.md L10): the scope's tasks by station.
  { key: "line", label: "Line", icon: Workflow },
  { key: "plans", label: "Plans", icon: Layers },
  { key: "docs", label: "Docs", icon: FileText },
  { key: "sessions", label: "Sessions", icon: Terminal },
  { key: "decisions", label: "Decisions", icon: MessageCircleQuestionMark },
  { key: "brief", label: "Brief", icon: ScrollText, roleOnly: true },
  { key: "charter", label: "Charter", icon: CheckSquare, roleOnly: true },
  { key: "wakes", label: "Wakes", icon: BellRing, roleOnly: true },
  { key: "settings", label: "Settings", icon: Settings2, roleOnly: true },
];

/** The tab a scope opens on, and the one its bare URL means: a role's Scope,
 *  the workspace root's feed. */
export function scopeDefaultTab(hasRole: boolean): ScopeTabKey {
  return hasRole ? "scope" : "feed";
}

/** The tab a URL names, when it is one this scope shows; else the default. */
export function scopeTabFromParam(param: string | null, hasRole: boolean): ScopeTabKey {
  const hit = SCOPE_TABS.find((t) => t.key === param && (!t.roleOnly || hasRole));
  return hit ? hit.key : scopeDefaultTab(hasRole);
}
