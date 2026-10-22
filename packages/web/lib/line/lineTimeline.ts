// The line's timeline (ct-68152): everything that entered a workspace's line,
// newest first, each event with where it came from and what it became. Pure.
// Events come from the lineTimeline collection (convex lineTimeline.page) and,
// for decisions, from their one home, the decision collection: a line card and
// a card any other session asked read the same way, each naming who asked.
import type { TimelineEvent, TimelineKind } from "@codecast/shared/contracts/lineTimeline";
import { sourceName } from "./sourceNames";

export type { TimelineEvent, TimelineKind };

/** The groups a reader filters by, in the order the bar lists them. */
export const TIMELINE_GROUPS = ["conversations", "findings", "problems", "errors", "runs", "decisions", "deploys"] as const;
export type TimelineGroup = (typeof TIMELINE_GROUPS)[number];

export const GROUP_OF: Record<TimelineKind, TimelineGroup> = {
  moment: "conversations", judged: "conversations", review: "conversations",
  finding: "findings",
  problem_opened: "problems", problem_merged: "problems", problem_closed: "problems",
  error: "errors", replay: "errors",
  run_started: "runs", station: "runs", run_ended: "runs",
  decision_asked: "decisions", decision_answered: "decisions",
  deploy: "deploys",
};

export const GROUP_LABELS: Record<TimelineGroup, string> = {
  conversations: "Conversations", findings: "Findings", problems: "Problems", errors: "Errors", runs: "Runs", decisions: "Decisions", deploys: "Deploys",
};

/** What happened, in two or three words. */
export function kindWords(e: Pick<TimelineEvent, "kind" | "detail" | "split_from">): string {
  switch (e.kind) {
    case "moment": return "Conversation";
    case "judged": return "Judge read";
    case "review": return "Agent review";
    case "finding": return "Finding";
    case "problem_opened": return e.split_from ? "Split off" : "Problem opened";
    case "problem_merged": return "Merged";
    case "problem_closed": return e.detail === "fixed" ? "Fixed" : "Dropped";
    case "error": return e.detail === "regressed" ? "Error came back" : e.detail?.startsWith("metric") ? "Metric" : "Error";
    case "replay": return "Replay";
    case "run_started": return "Run started";
    case "station": return "Step";
    case "run_ended": return e.detail === "completed" ? "Run done" : e.detail === "failed" ? "Run failed" : "Run stopped";
    case "decision_asked": return "Asked you";
    case "decision_answered": return "Answered";
    case "deploy": return "Deploy";
  }
}

/** Where it came from, as a person names it: the finder, the judge, the event source, the session that asked. */
export function sourceWords(e: Pick<TimelineEvent, "kind" | "source" | "session_title">): string {
  if (e.kind === "decision_asked" || e.kind === "decision_answered") return e.source === "line" ? "Line" : e.session_title || "A session";
  if (e.source === "line") return "Line";
  return sourceName(e.source);
}

/** A decision row as the decision collection holds it (the fields the timeline reads). */
export type TimelineDecision = {
  _id: string;
  short_id?: string;
  question: string;
  status: string;
  created_at: number;
  resolved_at?: number;
  task_id?: string;
  workflow_run_id?: string;
  conversation_id?: string;
  session_title?: string;
  answer_index?: number;
  answer_text?: string;
  options?: ReadonlyArray<{ label: string }>;
};

/** A decision's events: asked, and answered once it was. A line card's source is the line; any other's is its session. */
export function decisionEvents(d: TimelineDecision, workspace: string, taskRef: (id: string) => string | undefined): TimelineEvent[] {
  const line = !!(d.workflow_run_id && d.task_id);
  const base = {
    workspace, source: line ? "line" : "session", title: d.question, decision: d._id, decision_ref: d.short_id,
    ...(d.task_id ? { task: d.task_id, task_ref: taskRef(d.task_id) } : {}),
    ...(d.workflow_run_id ? { run: d.workflow_run_id } : {}),
    ...(d.conversation_id ? { conversation: d.conversation_id } : {}),
    ...(d.session_title ? { session_title: d.session_title } : {}),
  };
  const out: TimelineEvent[] = [{ ...base, _id: `decision:${d._id}:asked`, at: d.created_at, kind: "decision_asked" }];
  if (d.resolved_at && d.status !== "pending") {
    const answer = typeof d.answer_index === "number" ? d.options?.[d.answer_index]?.label : undefined;
    out.push({ ...base, _id: `decision:${d._id}:answered`, at: d.resolved_at, kind: "decision_answered", detail: answer ?? d.answer_text?.slice(0, 80) ?? d.status });
  }
  return out;
}

export type TimelineFilter = {
  groups?: ReadonlySet<TimelineGroup> | null;
  /** Source keys as events carry them ("judge:comms", "union.desk", "line", "session"). */
  sources?: ReadonlySet<string> | null;
  project?: string | null;
  /** Events at or after this time only: the floor the feed is complete down to. */
  floor?: number | null;
  /** Station events are folded into their run unless asked for. */
  stations?: boolean;
};

/** The events to list, newest first: deduplicated, inside the complete range, narrowed by the filter. */
export function timelineRows(events: ReadonlyArray<TimelineEvent>, f: TimelineFilter): TimelineEvent[] {
  const out: TimelineEvent[] = [];
  for (const e of events) {
    if (f.floor != null && e.at < f.floor) continue;
    if (e.kind === "station" && !f.stations) continue;
    if (f.groups?.size && !f.groups.has(GROUP_OF[e.kind])) continue;
    if (f.sources?.size && !f.sources.has(e.source)) continue;
    // A project narrows to its own events; one that names no project (a workspace deploy, a session's card) stays.
    if (f.project && e.project_id && e.project_id !== f.project) continue;
    out.push(e);
  }
  return out.sort((a, b) => b.at - a.at || a._id.localeCompare(b._id));
}

/** Each source the events name with its count, most first: the source filter's options. */
export function timelineSources(events: ReadonlyArray<TimelineEvent>, floor: number | null): Array<{ source: string; label: string; n: number }> {
  const n = new Map<string, { label: string; n: number }>();
  for (const e of events) {
    if (floor != null && e.at < floor) continue;
    const row = n.get(e.source) ?? { label: e.source === "session" ? "Sessions" : sourceWords({ ...e, session_title: undefined }), n: 0 };
    row.n++;
    n.set(e.source, row);
  }
  return [...n].map(([source, r]) => ({ source, ...r })).sort((a, b) => b.n - a.n || a.label.localeCompare(b.label));
}

/** Counts per group inside the complete range (the bar's numbers). */
export function groupCounts(events: ReadonlyArray<TimelineEvent>, floor: number | null): Record<TimelineGroup, number> {
  const c = Object.fromEntries(TIMELINE_GROUPS.map((g) => [g, 0])) as Record<TimelineGroup, number>;
  for (const e of events) if ((floor == null || e.at >= floor) && e.kind !== "station") c[GROUP_OF[e.kind]]++;
  return c;
}

// ── forward: what an event became ────────────────────────────────────────────

export type ChainStep =
  | { kind: "finding"; ref: string; id?: string; n?: number }
  | { kind: "problem"; ref: string; id?: string; state: string }
  | { kind: "run"; id: string; state: string }
  | { kind: "decision"; id: string; ref?: string; state: string }
  | { kind: "deploy"; ref: string; state: string };

/** The store rows the forward chain reads, by id. */
export type ChainIndex = {
  /** Problems by task id: its ref, status, and the problem it merged into. */
  tasks: ReadonlyMap<string, { short_id?: string; status: string; merged_into_ref?: string; watch_until?: number }>;
  /** Each problem's newest run. */
  runOf: ReadonlyMap<string, { _id: string; status: string }>;
  /** Each problem's newest decision. */
  decisionOf: ReadonlyMap<string, { _id: string; short_id?: string; status: string }>;
  /** Each problem's newest deploy that carried its fix. */
  deployOf: ReadonlyMap<string, { short_id?: string; status: string }>;
  /** Findings by the moment they came from. */
  findingsOfMoment: ReadonlyMap<string, ReadonlyArray<{ ref?: string; id?: string; task?: string }>>;
  /** Findings by the error group they came from. */
  findingsOfGroup: ReadonlyMap<string, ReadonlyArray<{ ref?: string; id?: string; task?: string }>>;
};

const problemState = (t: { status: string; merged_into_ref?: string; watch_until?: number }, now: number) =>
  t.merged_into_ref ? `merged into ${t.merged_into_ref}` : t.status === "done" ? (t.watch_until && t.watch_until > now ? "watching" : "fixed") : t.status === "in_review" ? "waiting on you" : t.status === "in_progress" ? "being fixed" : t.status === "dropped" ? "dropped" : "open";

/** From a problem on: the problem, its newest run, its newest decision, the deploy that carried it. */
function fromProblem(taskId: string, ix: ChainIndex, now: number, seen: { problem?: boolean; run?: boolean; decision?: boolean }): ChainStep[] {
  const t = ix.tasks.get(taskId);
  if (!t) return [];
  const out: ChainStep[] = [];
  if (!seen.problem) out.push({ kind: "problem", ref: t.short_id ?? taskId, id: taskId, state: problemState(t, now) });
  const run = ix.runOf.get(taskId);
  if (run && !seen.run) out.push({ kind: "run", id: run._id, state: run.status });
  const d = ix.decisionOf.get(taskId);
  if (d && !seen.decision) out.push({ kind: "decision", id: d._id, ref: d.short_id, state: d.status === "pending" ? "waiting on you" : d.status });
  const dp = ix.deployOf.get(taskId);
  if (dp) out.push({ kind: "deploy", ref: dp.short_id ?? "deploy", state: dp.status });
  return out;
}

/** What an event became, one step per object, in the order the line moves: finding, problem, run, decision, deploy. */
export function becameOf(e: TimelineEvent, ix: ChainIndex, now: number): ChainStep[] {
  const viaFindings = (fs: ReadonlyArray<{ ref?: string; id?: string; task?: string }> | undefined): ChainStep[] => {
    if (!fs?.length) return [];
    const tasks = [...new Set(fs.map((f) => f.task).filter((t): t is string => !!t))];
    const head: ChainStep = fs.length === 1 ? { kind: "finding", ref: fs[0].ref ?? "finding", id: fs[0].id } : { kind: "finding", ref: `${fs.length} findings`, n: fs.length };
    // One problem: follow it. Several: name each.
    if (tasks.length === 1) return [head, ...fromProblem(tasks[0], ix, now, {})];
    return [head, ...tasks.slice(0, 3).flatMap((t) => fromProblem(t, ix, now, { run: true, decision: true }).filter((s) => s.kind === "problem"))];
  };
  switch (e.kind) {
    case "moment": case "judged": case "review":
      return e.moment ? viaFindings(ix.findingsOfMoment.get(e.moment)) : [];
    case "error":
      return e.group ? viaFindings(ix.findingsOfGroup.get(e.group)) : [];
    case "finding":
      return e.task ? fromProblem(e.task, ix, now, {}) : [];
    case "problem_opened": case "problem_merged": case "problem_closed":
      return e.task ? fromProblem(e.task, ix, now, { problem: true }) : [];
    case "run_started": case "station": case "run_ended":
      return e.task ? fromProblem(e.task, ix, now, { problem: true, run: true }) : [];
    case "decision_asked": case "decision_answered":
      return e.task ? fromProblem(e.task, ix, now, { problem: true, run: true, decision: true }) : [];
    default:
      return [];
  }
}

/** The findings index of the events: by moment and by error group. */
export function findingIndex(events: ReadonlyArray<TimelineEvent>) {
  const byMoment = new Map<string, Array<{ ref?: string; id?: string; task?: string }>>();
  const byGroup = new Map<string, Array<{ ref?: string; id?: string; task?: string }>>();
  for (const e of events) {
    if (e.kind !== "finding") continue;
    const f = { ref: e.signal_ref, id: e.signal, task: e.task };
    if (e.moment) byMoment.set(e.moment, [...(byMoment.get(e.moment) ?? []), f]);
    if (e.group) byGroup.set(e.group, [...(byGroup.get(e.group) ?? []), f]);
  }
  return { byMoment, byGroup };
}
