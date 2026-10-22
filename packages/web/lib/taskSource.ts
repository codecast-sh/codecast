import { isActiveTask, isOnHumanBoard } from "@codecast/shared/tasks";

/** The Source value of the Huddles view: tasks pulled from a call. */
export const CALLS_SOURCE = "calls";

/**
 * The rows a Source choice lists, before status and the other filters. The
 * default ("", and a legacy "human" link) is the human's board, the shared
 * isOnHumanBoard rule over active rows: the same rows projectTaskCounts counts
 * for a project's sheet and line (it leaves Dropped out, which the board shows
 * only under All). Every machine-made unpromoted task sits behind "agent";
 * "all" shows both. Insight suggestions stay behind triage. "calls" is every
 * active task pulled from a call (tasks.from_call), the Huddles view's rows.
 */
export function tasksForSource<T extends { source?: string | null; promoted?: boolean | null; assignee?: string | null; triage_status?: string | null; status?: string | null; from_call?: string | null }>(rows: T[], sourceFilter: string): T[] {
  const isTriage = (t: T) => (t.source === "insight" ? t.triage_status !== "dismissed" : t.triage_status === "suggested");
  switch (sourceFilter) {
    case "agent": return rows.filter((t) => !isOnHumanBoard(t) && isActiveTask(t));
    case "all": return rows.filter(isActiveTask);
    case CALLS_SOURCE: return rows.filter((t) => !!t.from_call && isActiveTask(t));
    case "triage": return rows.filter(isTriage);
    case "dismissed": return rows.filter((t) => t.triage_status === "dismissed");
    default: return rows.filter((t) => isOnHumanBoard(t) && isActiveTask(t));
  }
}
