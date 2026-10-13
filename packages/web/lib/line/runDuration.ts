// How long a full line run takes (line-journeys.md LJ6.6): the median of a
// project's finished runs, said on a control that starts one ("Start a new run
// to ask again, about 4h"). Under three finished runs there is no number: an
// anecdote is not a duration. Pure, with one store reader.
import { useMemo } from "react";
import { useInboxStore } from "../../store/inboxStore";

type DurationRun = { status?: string; created_at?: number; updated_at?: number; task_id?: string | null };

/** The fewest finished runs that make a duration. */
export const MIN_RUNS = 3;
const finished = (r: DurationRun) => r.status === "completed" || r.status === "done";

/** The median length of the finished runs given, in ms; null under MIN_RUNS of them. */
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

/** How long a run on one of the project's problems takes, from its finished runs in the store; null with too few. */
export function useRunDuration(projectId: string | null | undefined): number | null {
  const sig = useInboxStore((s) => {
    if (!projectId) return "";
    const tasks = s.tasks as Record<string, { project_id?: string | null }>;
    const own = (Object.values((s as unknown as { workflowRuns?: Record<string, DurationRun> }).workflowRuns ?? {})).filter((r) => r.task_id && tasks[r.task_id]?.project_id === projectId);
    return String(medianRunMs(own) ?? "");
  });
  return useMemo(() => (sig ? Number(sig) : null), [sig]);
}
