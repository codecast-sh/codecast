// What waits on the viewer in the line (line-workspace.md LW1, the Inbox), as
// rows grouped by what to do: cards to decide, fixes that shipped past an
// unanswered card, problems holding for a person's answer or review, runs that
// failed or went silent, and projects whose line cannot start. Each row names
// the concrete thing (the problem, the question, the failure) and carries one
// action. The counts agree with the roll-up (lineFlow lineRollup): the waiting
// problems come from the same flow, split by the same reasons. Pure.
import {
  admissionHold, buildLineFlow, causeAsks, isCause, isLineCard, unapprovedShips, waitingCauseIds, NO_PROJECT,
  type LineAdmission, type LineCauseTask, type LineDecision, type LineFlowRun, type LineProject, type LineSignal, type RollupRow,
} from "../lineFlow";
import { graphKeyOf, newestRunByTask, processIndex, type GraphRun } from "./lineGraphs";

export type InboxKind = "decide" | "unapproved" | "question" | "review" | "failed" | "stalled" | "stuck";

export type InboxRow = {
  key: string;
  kind: InboxKind;
  /** When it started waiting; null when unknown. */
  at: number | null;
  projectId: string | null;
  /** The thing itself: the problem's title, or the project's name for a line that cannot start. */
  title: string;
  /** The problem's ref (ct-N), else null. */
  ref: string | null;
  /** The concrete detail, short: the question asked, why the run failed, why the line holds. */
  detail: string | null;
  caseId: string | null;
  runId: string | null;
  cardId: string | null;
  cardRef: string | null;
  /** For a stuck project: problems waiting there, and whether the one fix is the start switch. */
  waiting?: number;
  switchOff?: boolean;
};

export type InboxGroup = { kind: InboxKind; label: string; rows: InboxRow[] };

export const INBOX_LABELS: Record<InboxKind, string> = {
  decide: "Decide",
  unapproved: "Shipped unapproved",
  question: "Questions",
  review: "In review",
  failed: "Failed runs",
  stalled: "Silent runs",
  stuck: "Not starting",
};
const ORDER: InboxKind[] = ["decide", "unapproved", "question", "review", "failed", "stalled", "stuck"];

export type LineInboxInput = {
  signals: ReadonlyArray<LineSignal>;
  tasks: ReadonlyArray<LineCauseTask>;
  runs: ReadonlyArray<LineFlowRun>;
  /** The viewer's cards (the floor reads only theirs). */
  decisions: ReadonlyArray<LineDecision & { short_id?: string; created_at?: number; gate_node_id?: string; question?: string }>;
  projects: ReadonlyArray<LineProject>;
  /** The roll-up rows in view (one project's, or every project's). */
  rollups: ReadonlyArray<RollupRow>;
  admissions: ReadonlyMap<string, LineAdmission>;
  now: number;
};

const terminal = (s: string) => s === "done" || s === "dropped";
const oneLine = (s: string | null | undefined) => {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t || null;
};

export function buildLineInbox(input: LineInboxInput): InboxGroup[] {
  const tasks = input.tasks.filter(isCause);
  const byId = new Map(tasks.map((t) => [t._id, t]));
  const rows: InboxRow[] = [];
  const base = (t: LineCauseTask | undefined, kind: InboxKind, key: string): InboxRow => ({
    key: `${kind}:${key}`, kind, at: null, projectId: t?.project_id ?? null, title: t?.title ?? "A problem", ref: t?.short_id ?? null, detail: null, caseId: t?._id ?? null, runId: null, cardId: null, cardRef: null,
  });

  // Cards to decide, oldest first.
  for (const d of input.decisions.filter(isLineCard).sort((a, b) => (a.created_at ?? 0) - (b.created_at ?? 0))) {
    const t = d.task_id ? byId.get(d.task_id) : undefined;
    // A card whose problem is not in view still names itself: its own question and ref.
    const own = t ? null : { title: oneLine(d.question) ?? "A card", ref: d.short_id ?? null };
    rows.push({ ...base(t, "decide", d._id), ...own, at: d.created_at ?? null, runId: d.workflow_run_id ?? null, cardId: d._id, cardRef: d.short_id ?? null });
  }

  // Fixes that went live past an unanswered card.
  for (const id of unapprovedShips(tasks, input.runs as Parameters<typeof unapprovedShips>[1], input.now)) {
    const t = byId.get(id);
    if (t) rows.push({ ...base(t, "unapproved", id), at: t.closed_at ?? t.updated_at ?? null });
  }

  // The waiting problems that hold on a person, read from the same flow the roll-up counts.
  const flow = buildLineFlow({ signals: input.signals as LineSignal[], tasks: tasks as LineCauseTask[], runs: input.runs as LineFlowRun[], decisions: input.decisions as LineDecision[], initiatives: [], projects: [], now: input.now });
  for (const id of waitingCauseIds(flow)) {
    const t = byId.get(id);
    if (!t) continue;
    if (t.status === "in_review") rows.push({ ...base(t, "review", id), at: t.updated_at ?? null });
    else if (causeAsks(t)) rows.push({ ...base(t, "question", id), at: t.updated_at ?? null, detail: oneLine(t.readiness_note) });
  }

  // Runs: a problem whose newest run failed, while the problem is still open; and live runs silent for a day.
  for (const [taskId, r] of newestRunByTask(input.runs)) {
    const t = byId.get(taskId);
    if (r.status !== "failed" || !t || terminal(t.status)) continue;
    rows.push({ ...base(t, "failed", r._id), at: r.updated_at ?? null, runId: r._id, detail: oneLine(r.fail_reason) });
  }
  for (const b of flow.build.items.filter((x) => x.stalled)) {
    rows.push({ ...base(b.task, "stalled", b.run._id), at: b.since, runId: b.run._id, detail: b.step });
  }

  // Projects whose line holds its waiting problems.
  const titles = new Map(input.projects.map((p) => [p._id, p.title]));
  for (const r of input.rollups) {
    if (r.key === NO_PROJECT || !r.hold || r.causes === 0) continue;
    const a = input.admissions.get(r.key);
    const hold = a ? admissionHold(a) : null;
    rows.push({ key: `stuck:${r.key}`, kind: "stuck", at: null, projectId: r.key, title: titles.get(r.key) ?? r.title, ref: null, detail: hold?.short ?? r.hold, caseId: null, runId: null, cardId: null, cardRef: null, waiting: r.causes, switchOff: r.startingOff });
  }

  return ORDER.map((kind) => ({ kind, label: INBOX_LABELS[kind], rows: rows.filter((x) => x.kind === kind) })).filter((g) => g.rows.length > 0);
}

/** How many rows wait on the viewer (every group). */
export const inboxCount = (groups: ReadonlyArray<InboxGroup>) => groups.reduce((n, g) => n + g.rows.length, 0);

/** How many rows wait on the viewer in each process (lineGraphs processIndex): every row counts under exactly one, so the counts sum to the total. */
export function inboxByGraph(groups: ReadonlyArray<InboxGroup>, runs: ReadonlyArray<Pick<GraphRun, "_id" | "task_id" | "workflow_slug" | "workflow_name" | "created_at">>, tasks: ReadonlyArray<{ _id: string; project_id?: string | null }>): Map<string, number> {
  const projectOf = new Map(tasks.map((t) => [t._id, t.project_id ?? null]));
  const process = processIndex(runs, (id) => projectOf.get(id));
  const runById = new Map(runs.map((r) => [r._id, r]));
  const out = new Map<string, number>();
  for (const g of groups) for (const row of g.rows) {
    const run = !row.caseId && row.runId ? runById.get(row.runId) : undefined;
    const key = run ? graphKeyOf(run) : row.caseId ? process.task(row.caseId, row.projectId) : process.project(row.projectId);
    out.set(key, (out.get(key) ?? 0) + 1);
  }
  return out;
}
