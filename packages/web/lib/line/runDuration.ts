// How long a full line run takes to reach the person (line-journeys.md LJ6.6): the median working time of a
// project's finished runs that built a fix, said on a control that starts one ("Start a new run to ask again,
// about 40m"). Working time is the steps' own time up to the card, without the steps that wait on a person (the
// plan gate, a builder's question, the card itself): a card that sat unanswered until its 3h limit is a person's
// wait, not the run's length. A run that stopped at grounding in a minute, or failed (a session that sat empty until
// its limit), is not what the control starts, so it is not counted. Under three such runs there is no number: an
// anecdote is not a duration. Pure, with one store reader.
import { useMemo } from "react";
import { CARD_GATE_NODE_ID } from "@codecast/shared/contracts/changeCard";
import { useInboxStore } from "../../store/inboxStore";

type DurationStep = { node_id: string; status?: string; started_at?: number; completed_at?: number };
type DurationRun = { status?: string; created_at?: number; updated_at?: number; task_id?: string | null; node_statuses?: ReadonlyArray<DurationStep> };

/** The fewest finished runs that make a duration. */
export const MIN_RUNS = 3;
/** The steps that build a fix, by their ids in any line. */
const BUILDS = /^(?:build|implement)/;
const finished = (r: DurationRun) => (r.status === "completed" || r.status === "done") && !!r.node_statuses?.some((n) => BUILDS.test(n.node_id) && n.status === "completed");

/** The steps that wait on a person, by their ids in any line: the card, a builder's question, an approval, any gate. */
const WAITS = new RegExp(`^(?:${CARD_GATE_NODE_ID}|ask|approve)$|(?:^|_)gate$`);

/** A run's working time up to its card, in ms: each step's own time, the steps that wait on a person left out. Null
 *  when no step recorded its times. */
export function workMs(run: Pick<DurationRun, "node_statuses">): number | null {
  const steps = run.node_statuses ?? [];
  const card = steps.find((n) => n.node_id === CARD_GATE_NODE_ID)?.started_at;
  let ms = 0, timed = 0;
  for (const n of steps) {
    if (WAITS.test(n.node_id) || n.started_at == null || n.completed_at == null || (card != null && n.started_at > card)) continue;
    ms += Math.max(0, n.completed_at - n.started_at);
    timed++;
  }
  return timed ? ms : null;
}

/** The median working time of the given runs that finished having built a fix, in ms; null under MIN_RUNS of them. */
export function medianRunMs(runs: ReadonlyArray<DurationRun>): number | null {
  const ms = runs.filter(finished).map(workMs).filter((m): m is number => m != null && m > 0).sort((a, b) => a - b);
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
