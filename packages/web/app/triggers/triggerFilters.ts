import { isTriggerFailing } from "../../components/triggerTasks";

// The triggers page's filters: what the filter bar and the overview line set,
// and the one test that drives the list and the rail.

export interface Filters {
  search: string;
  mode: string; // all | apply | propose
  type: string; // all | recurring | once | event
  project: string; // all | <path>
  agent: string; // all | claude | codex
  failing: boolean; // only triggers whose last run failed
}

export const EMPTY_FILTERS: Filters = { search: "", mode: "all", type: "all", project: "all", agent: "all", failing: false };

export function filtersActive(f: Filters): boolean {
  return f.search.trim() !== "" || f.mode !== "all" || f.type !== "all" || f.project !== "all" || f.agent !== "all" || f.failing;
}

export function matchesFilters(t: any, f: Filters): boolean {
  if (f.failing && !isTriggerFailing(t)) return false;
  if (f.mode !== "all" && (t.mode ?? "propose") !== f.mode) return false;
  if (f.type !== "all" && t.schedule_type !== f.type) return false;
  if (f.agent !== "all" && (t.agent_type || "claude") !== f.agent) return false;
  if (f.project !== "all" && t.project_path !== f.project) return false;
  const q = f.search.trim().toLowerCase();
  if (q) {
    const hay = `${t.title ?? ""} ${t.display_title ?? ""} ${t.display_summary ?? ""} ${t.prompt ?? ""} ${t.last_run_summary ?? ""}`.toLowerCase();
    if (!hay.includes(q)) return false;
  }
  return true;
}
