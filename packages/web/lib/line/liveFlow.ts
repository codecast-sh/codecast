// A live flow as the flows page reads it (flows doc of Oct 23): its queue's
// rows from the task rows the store holds (title, ref, score, family,
// findings, area), and what the switch's review shows. The live flow row carries only task ids in start
// order; every fact about a problem is its task's. Pure: no store, no React.
import type { SwitchLedger } from "../../components/consequential/ConsequentialSwitch";
import type { LiveFlow } from "../../hooks/useLiveFlow";
import { causeName } from "../lineFlow";
import { problemListName } from "./problemTable";
import { scoreOf, type ProblemScoreFacts, type ScoredTask } from "./problemScore";

type QueueTask = ScoredTask & { _id: string; short_id?: string; title?: string; project_id?: string | null; cause?: { signal_count?: number; named?: { name: string; for: string } | null } | null };

/** One problem in a live flow's queue, in start order. */
export type LiveQueueRow = {
  taskId: string;
  ref: string | null;
  name: string;
  score: ProblemScoreFacts | null;
  findings: number;
  projectId: string | null;
  /** Why it is not starting, when it is not next. */
  waiting: string | null;
};

/** The queue's rows, in the live flow's start order. A task the store does not hold yet still has its place, by id. */
export function liveQueue(flow: Pick<LiveFlow, "queue">, tasks: Readonly<Record<string, QueueTask | undefined>>): LiveQueueRow[] {
  return flow.queue.map((q) => {
    const t = tasks[q.task_id];
    return {
      taskId: q.task_id,
      ref: t?.short_id ?? null,
      name: t ? problemListName({ title: t.title ?? t.short_id ?? "", name: causeName(t as never) }) : "Loading",
      score: scoreOf(t),
      findings: t?.cause?.signal_count ?? 0,
      projectId: t?.project_id ?? null,
      waiting: q.waiting,
    };
  });
}

/** What turning the live flow on starts, for the one consequential review. */
export function liveFlowLedger(flow: LiveFlow, queued: number): SwitchLedger {
  const perDay = flow.caps.hands_per_day;
  return {
    name: "Live flow",
    subject: flow.flow.label,
    figures: [
      { value: String(queued), label: "in the queue" },
      { value: String(flow.load.cap), label: "at once" },
      { value: perDay == null ? "No limit" : String(perDay), label: "a day", ...(perDay == null ? { tone: "warn" as const } : {}) },
    ],
    rows: [
      { k: "Runs", v: flow.flow.label },
      { k: "Takes from", v: flow.sources ? `${flow.sources.length} ${flow.sources.length === 1 ? "source" : "sources"}` : "Every source", ...(flow.sources ? { list: flow.sources } : {}) },
      { k: "Order", v: "Best score first" },
      { k: "Cards go to", v: "Each problem's area lead" },
    ],
    stop: "One press here; runs under way finish",
    confirm: "Turn on",
  };
}

/** The review before a library flow becomes the team's live flow: what it runs and takes, and the state it starts in,
 *  which is the leads' lines' (convex createLiveFlowCore): on when any lead's line is on. */
export function startFlowLedger(label: string, steps: number): SwitchLedger {
  return {
    name: "Live flow",
    subject: label,
    shift: ["None", label],
    figures: [{ value: String(steps), label: steps === 1 ? "step" : "steps" }],
    rows: [
      { k: "Runs", v: label },
      { k: "Takes from", v: "Every source" },
      { k: "Order", v: "Best score first" },
      { k: "Starts", v: "On if a lead's line is on, else off", tone: "warn" },
      { k: "Leads", v: "Stop starting problems on their own" },
    ],
    stop: "Its switch, one press",
    confirm: "Make live",
    keep: "Not now",
  };
}
