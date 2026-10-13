// How long a full line run takes (line-journeys.md LJ6.6): the median of a
// project's finished runs that built a fix, said on a control that starts one
// ("Start a new run to ask again, about 4h"). A run that stopped at grounding
// in a minute is not what the control starts, so it is not counted. Under
// three such runs there is no number: an anecdote is not a duration. Pure,
// with one store reader.
import { useMemo } from "react";
import { useInboxStore } from "../../store/inboxStore";

type DurationRun = { status?: string; created_at?: number; updated_at?: number; task_id?: string | null; node_statuses?: ReadonlyArray<{ node_id: string; status?: string }> };

/** The fewest finished runs that make a duration. */
export const MIN_RUNS = 3;
/** The steps that build a fix, by their ids in any line. */
const BUILDS = /^(?:build|implement)/;
const finished = (r: DurationRun) => (r.status === "completed" || r.status === "done") && !!r.node_statuses?.some((n) => BUILDS.test(n.node_id) && n.status === "completed");

/** The median length of the given runs that finished having built a fix, in ms; null under MIN_RUNS of them. */
export function medianRunMs(runs: ReadonlyArray<DurationRun>): number | null {
  const ms = runs.filter((r) => finished(r) && r.created_at != null && r.updated_at != null && r.updated_at > r.created_at).map((r) => r.updated_at! - r.created_at!).sort((a, b) => a - b);
  if (ms.length < MIN_RUNS) return null;
  const mid = ms.length >> 1;
  return ms.length % 2 ? ms[mid] : Math.round((ms[mid - 1] + ms[mid]) / 2);
}

/** A run's length as a label says it: "40m", "4h", "1d 2h" rounded to the unit a person plans in. */
export function aboutWords(ms: number): string {
  const min = Math.max(1, Math.round(ms / 60_000));
  if (min < 60) return `${min}m`;
  const h = Math.round(min / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d${h % 24 ? ` ${h % 24}h` : ""}`;
}

/** How long a run on one of the projects' problems takes, from their finished runs in the store; null with too few.
 *  A batch across projects passes them all, so one project with no finished runs does not leave the batch unpriced in time. */
export function useRunDuration(projectIds: string | ReadonlyArray<string> | null | undefined): number | null {
  const key = typeof projectIds === "string" ? projectIds : (projectIds ?? []).join(",");
  const sig = useInboxStore((s) => {
    if (!key) return "";
    const ids = new Set(key.split(","));
    const tasks = s.tasks as Record<string, { project_id?: string | null }>;
    const own = (Object.values((s as unknown as { workflowRuns?: Record<string, DurationRun> }).workflowRuns ?? {})).filter((r) => { const p = r.task_id ? tasks[r.task_id]?.project_id : null; return !!p && ids.has(p); });
    return String(medianRunMs(own) ?? "");
  });
  return useMemo(() => (sig ? Number(sig) : null), [sig]);
}
