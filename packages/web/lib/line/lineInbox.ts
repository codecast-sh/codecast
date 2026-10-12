// What waits on the viewer in the line (line-workspace.md LW1, the Inbox), as
// rows grouped by what to do: fixes to decide (a run's decision, or a trial
// run's card, convex lineTrial.ts, in one group), fixes that shipped past an
// unanswered card, problems holding for a person's answer, runs that
// failed or went silent, and projects whose line cannot start. Each row names
// the concrete thing (the problem, the question, the failure) and carries one
// action. The counts agree with the roll-up (lineFlow lineRollup): the waiting
// problems come from the same flow, split by the same reasons. Pure.
import { cardAsRead, emptyWords, trialHold, trialLane } from "../trialEvidence";
import type { TrialCardRow, TrialEvidence } from "../../hooks/useSyncTrial";
import {
  admissionHold, buildLineFlow, causeAsks, isCause, isLineCard, unapprovedShips, waitingCauseIds, NO_PROJECT,
  type LineAdmission, type LineCauseTask, type LineDecision, type LineFlowRun, type LineProject, type LineSignal, type RollupRow,
} from "../lineFlow";
import { graphKeyOf, newestRunByTask, processIndex, type GraphRun } from "./lineGraphs";
import type { LineIssue } from "./lineModel";
import { isCountedActive } from "./problemTable";
import { failCause, type FailCause } from "./runReport";

export type InboxKind = "decide" | "unapproved" | "confirm" | "question" | "failed" | "stalled" | "watching" | "proposal" | "stuck";

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
  /** The concrete detail, short: why the run failed, the step a silent run sits at, why the line holds. */
  detail: string | null;
  /** What the viewer is asked, for a problem holding on a person (askLine): the row's main line, the problem's title under it. */
  ask?: string | null;
  caseId: string | null;
  runId: string | null;
  cardId: string | null;
  cardRef: string | null;
  /** For a stuck project: problems waiting there, and whether the one fix is the start switch. */
  waiting?: number;
  switchOff?: boolean;
  /** For a failed run: the station it stopped at and what happened, short (runReport failCause). */
  fail?: FailCause;
  /** For a trial card that is its station's own decision: sd-N, whose page holds the session's card and its discussion. */
  decisionRef?: string | null;
  /** Set on a fix to decide that a trial run asks: its card (tc-N) is cardRef. Answering it records what you would do and ships nothing. */
  trial?: boolean;
  /** Why the pipeline would rather a trial card wait (lib/trialEvidence trialHold), in a chip's words: it still waits on you. */
  hold?: string | null;
  /** For a trial card: how many of its checks failed. */
  failing?: number;
  /** For a problem: how many findings it holds. */
  findings?: number;
};

export type InboxGroup = { kind: InboxKind; label: string; rows: InboxRow[] };

export const INBOX_LABELS: Record<InboxKind, string> = {
  decide: "Fixes to decide",
  unapproved: "Not shipped: no answer",
  confirm: "New, confirm",
  question: "Questions",
  failed: "Failed runs",
  stalled: "Silent runs",
  watching: "Watching",
  proposal: "Proposals without a session",
  stuck: "Not starting",
};
/** Most urgent first: the groups' order, and the one group a problem asked for twice is listed under. */
const ORDER: InboxKind[] = ["decide", "question", "unapproved", "failed", "stalled", "confirm", "watching", "proposal", "stuck"];

/** A note that parks a problem until more findings come ("so it waits for more signals"): it asks a person nothing. */
const WAITS_FOR_SIGNALS = /\bwaits? (?:for|on) more (?:signals|findings)\b/i;
/** Whether grounding's note parks the problem for more findings (watched, not asked). The Inbox and the problem's page read it alike. */
export const waitsForFindings = (note: string | null | undefined): boolean => WAITS_FOR_SIGNALS.test(note ?? "");

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
  /** The workspace's trial cards (useSyncTrial useTrialCards): the waiting ones are rows. */
  trialCards?: ReadonlyArray<TrialInboxCard>;
  /** Trial projects: their runs start on their own, so they never wait on a start switch. */
  trialProjects?: ReadonlySet<string>;
  now: number;
};

/** A trial card as the Inbox reads it (hooks/useSyncTrial TrialCardRow). */
export type TrialInboxCard = {
  _id: string;
  short_id: string;
  project_id: string;
  task_id: string;
  task_short_id?: string;
  task_title?: string;
  run_id: string;
  kind: "card" | "gate";
  question: string;
  options: ReadonlyArray<{ key: string; label: string }>;
  card?: { headline?: string; change?: string; checks?: ReadonlyArray<{ ok: boolean }>; recommend?: { verdict: string } } | null;
  status: "waiting" | "answered" | "closed";
  created_at: number;
  /** The session decision the card is (sd-N), when its station posted one. */
  decision?: { _id: string; short_id: string | null; status: string } | null;
  /** Sent back to rebuild on main: on its way to the next card, so it waits on nobody now. */
  rebuilding?: unknown;
  /** The problem's live findings, read now (lib/trialEvidence). */
  evidence?: TrialEvidence | null;
};

/**
 * Whether a trial card waits on a person now. One reading for the Inbox's rows, a run's "Waiting on tc-N" and the
 * Problems banner, so the three agree. A card its station posted as a session decision waits while that decision is
 * pending, read from the decision's own row when the store holds one (`live`, an answer given a moment ago) before the
 * card's copy. A hold the pipeline would put on it (evals owed, one conversation) is a chip on the row, never a reason
 * to hide it: the run still waits on the answer.
 */
export function trialCardWaits(c: Pick<TrialInboxCard, "status" | "decision" | "rebuilding">, live?: string | null): boolean {
  if (c.status !== "waiting" || c.rebuilding) return false;
  return !c.decision || (live ?? c.decision.status) === "pending";
}

/** Why the pipeline would rather a waiting trial card wait, in a chip's few words; null when nothing holds it. */
export function trialHoldWords(c: TrialCardRow): string | null {
  const lane = trialLane(c);
  if (lane === "empty") return emptyWords(c);
  if (lane === "tooling") return "review tooling";
  return trialHold(c)?.words ?? null;
}

const firstSentence = (t: string) => t.match(/^.+?[.!?](?=\s|$)/)?.[0] ?? t;

/** What a trial card asks, short: a change card's headline, else what it changes (its question only wraps the
 *  problem's title in "Ship the fix for …?"), else the question's first sentence. */
export function trialAsk(c: Pick<TrialInboxCard, "kind" | "question" | "card">): string {
  const head = oneLine(c.card?.headline) ?? (c.card?.change ? firstSentence(oneLine(c.card.change) ?? "").replace(/^On this local branch,\s*/i, "").replace(/^./, (x) => x.toUpperCase()) : null);
  if (c.kind === "card" && head) return head;
  const q = oneLine(c.question) ?? "";
  return q.match(/^.+?[?.!](?=\s|$)/)?.[0] ?? q;
}

/** A decision's question as a row says it: its first sentence, on one line. */
const decisionAsk = (q: string | null | undefined) => { const t = oneLine(q); return t ? t.match(/^.+?[?.!](?=\s|$)/)?.[0] ?? t : null; };

const terminal = (s: string) => s === "done" || s === "dropped";
const oneLine = (s: string | null | undefined) => {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t || null;
};

/** The ask itself, out of grounding's note: the sentence that says what a person must answer, said as an instruction
 *  ("A person needs to confirm which state is true." reads "Confirm which state is true."). */
export function askLine(note: string | null | undefined): string {
  return askParts(note).question;
}

/** The ask and what the note says besides it: the sentences before the ask that it did not take in, without the
 *  note's "it can't be worked yet" frame. A card shows the question once and the context under it. */
export function askParts(note: string | null | undefined): { question: string; context: string | null } {
  const text = (note ?? "").replace(/\s+/g, " ").trim();
  if (!text) return { question: "Is this a real problem?", context: null };
  const sentences = text.match(/[^.?!]+[.?!]*/g)?.map((x) => x.trim()).filter(Boolean) ?? [text];
  const at = sentences.findIndex((x) => /\?$/.test(x) || /\b(person|someone|you|a human|the owner)\b[^.]*?\b(needs? to|must|should|has to)\b/i.test(x));
  const i = at >= 0 ? at : sentences.length - 1;
  // The ask without its frame: "a person needs to ...", "it can't be worked yet because ...".
  const bare = sentences[i].replace(/^.*?\b(?:a person|someone|you|a human|the owner)\s+(?:needs? to|must|should|has to)\s+/i, "").replace(/^it (?:can(?:'|no)t|cannot) be worked(?: on)? yet,? because\s+/i, "");
  // "Supply that before ..." names its object in the sentence before: the ask carries it.
  const merged = /^\w+\s+(that|this|it)\b/i.test(bare) && i > 0;
  const said = merged ? `${sentences[i - 1].replace(/[.!]$/, "")}: ${bare.charAt(0).toLowerCase()}${bare.slice(1)}` : bare;
  const context = sentences.slice(0, merged ? i - 1 : i).filter((x) => !/\b(can(?:'|no)t|cannot) be worked\b/i.test(x)).join(" ").trim();
  return { question: said.charAt(0).toUpperCase() + said.slice(1), context: context || null };
}

export function buildLineInbox(input: LineInboxInput): InboxGroup[] {
  const tasks = input.tasks.filter(isCause);
  const byId = new Map(tasks.map((t) => [t._id, t]));
  const rows: InboxRow[] = [];
  const base = (t: LineCauseTask | undefined, kind: InboxKind, key: string): InboxRow => ({
    key: `${kind}:${key}`, kind, at: null, projectId: t?.project_id ?? null, title: t?.title ?? "A problem", ref: t?.short_id ?? null, detail: null, caseId: t?._id ?? null, runId: null, cardId: null, cardRef: null,
  });

  // Fix decisions to make, oldest first: a line card, or any open decision a run asked about one of these problems
  // (lib/line/fixDecision). Each names its problem and asks the decision's own question; a trial run's decision is
  // its trial card's, listed below in the same group.
  const isFix = (x: (typeof input.decisions)[number]) => isLineCard(x) || (x.status === "pending" && !!x.workflow_run_id && !!x.task_id && byId.has(x.task_id));
  for (const d of input.decisions.filter((x) => isFix(x) && !x.trial).sort((a, b) => (a.created_at ?? 0) - (b.created_at ?? 0))) {
    const t = d.task_id ? byId.get(d.task_id) : undefined;
    // A card whose problem is not in view still names itself: its own question and ref.
    const own = t ? null : { title: oneLine(d.question) ?? "A card", ref: d.short_id ?? null };
    rows.push({ ...base(t, "decide", d._id), ...own, at: d.created_at ?? null, ask: t ? decisionAsk(d.question) : null, runId: d.workflow_run_id ?? null, cardId: d._id, cardRef: d.short_id ?? null });
  }

  // Trial cards, oldest first: each is a trial run paused at its gate, waiting on the answer (trialCardWaits). One its
  // station posted as a session decision is a fix to decide like any other: the row opens that decision, where the
  // answer is given beside the session that asked. A card with no decision behind it has nobody to answer, so it is
  // a proposal to read, listed quietly and never counted as waiting on you.
  const live = new Map(input.decisions.map((d) => [d._id, d.status]));
  for (const c of [...(input.trialCards ?? [])].filter((x) => trialCardWaits(x, x.decision ? live.get(x.decision._id) : null)).sort((a, b) => a.created_at - b.created_at)) {
    const t = byId.get(c.task_id);
    const card = cardAsRead(c as Parameters<typeof cardAsRead>[0]) as TrialInboxCard["card"];
    rows.push({
      ...base(t, c.decision ? "decide" : "proposal", c._id), projectId: c.project_id, title: t?.title ?? oneLine(c.task_title) ?? "A problem", ref: t?.short_id ?? c.task_short_id ?? null, caseId: c.task_id,
      at: c.created_at, ask: trialAsk(c), runId: c.run_id, cardId: c._id, cardRef: c.short_id, decisionRef: c.decision?.short_id ?? c.decision?._id ?? null, trial: true,
      hold: trialHoldWords(c as unknown as TrialCardRow), failing: card?.checks?.filter((k) => !k.ok).length ?? 0,
    });
  }

  // Fixes that went live past an unanswered card.
  for (const id of unapprovedShips(tasks, input.runs as Parameters<typeof unapprovedShips>[1], input.now)) {
    const t = byId.get(id);
    if (t) rows.push({ ...base(t, "unapproved", id), at: t.closed_at ?? t.updated_at ?? null });
  }

  // The waiting problems that hold on a person, read from the same flow the roll-up counts. A problem in review asks
  // the viewer nothing (its fix is with a reviewer), so it is not listed.
  const flow = buildLineFlow({ signals: input.signals as LineSignal[], tasks: tasks as LineCauseTask[], runs: input.runs as LineFlowRun[], decisions: input.decisions as LineDecision[], initiatives: [], projects: [], now: input.now });
  for (const id of waitingCauseIds(flow)) {
    const t = byId.get(id);
    if (!t) continue;
    if (t.status === "in_review") continue;
    // A problem one finding filed asks whether it is real; one with more asks what a person knows.
    // A problem parked until more findings come is watched, not asked: no answer unblocks it.
    else if (causeAsks(t) && WAITS_FOR_SIGNALS.test(t.readiness_note ?? "")) rows.push({ ...base(t, "watching", id), at: t.updated_at ?? null, findings: t.cause?.signal_count ?? 0 });
    else if (causeAsks(t)) rows.push({ ...base(t, (t.cause?.signal_count ?? 0) <= 1 ? "confirm" : "question", id), at: t.updated_at ?? null, ask: askLine(t.readiness_note), findings: t.cause?.signal_count ?? 0 });
  }

  // Runs: a problem whose newest run failed, while the problem is still open; and live runs silent for a day.
  for (const [taskId, r] of newestRunByTask(input.runs)) {
    const t = byId.get(taskId);
    if (r.status !== "failed" || !t || terminal(t.status)) continue;
    const fail = failCause(r);
    rows.push({ ...base(t, "failed", r._id), at: r.updated_at ?? null, runId: r._id, detail: fail.label, fail });
  }
  for (const b of flow.build.items.filter((x) => x.stalled)) {
    rows.push({ ...base(b.task, "stalled", b.run._id), at: b.since, runId: b.run._id, detail: b.step });
  }

  // Projects whose line holds its waiting problems.
  const titles = new Map(input.projects.map((p) => [p._id, p.title]));
  for (const r of input.rollups) {
    if (r.key === NO_PROJECT || !r.hold || r.causes === 0 || input.trialProjects?.has(r.key)) continue;
    const a = input.admissions.get(r.key);
    const hold = a ? admissionHold(a) : null;
    rows.push({ key: `stuck:${r.key}`, kind: "stuck", at: null, projectId: r.key, title: titles.get(r.key) ?? r.title, ref: null, detail: hold?.short ?? r.hold, caseId: null, runId: null, cardId: null, cardRef: null, waiting: r.causes, switchOff: r.startingOff });
  }

  // A problem is listed once, under its most urgent group, so the count is the things that wait on you. A trial card
  // is an answer the run waits on: each one is listed, and holds its problem out of the groups after it.
  const seen = new Set<string>();
  const once = (x: InboxRow) => !x.caseId || (x.trial ? (seen.add(x.caseId), true) : !seen.has(x.caseId) && !!seen.add(x.caseId));
  return ORDER.map((kind) => ({
    kind, label: INBOX_LABELS[kind],
    rows: rows.filter((x) => x.kind === kind && once(x)),
  })).filter((g) => g.rows.length > 0);
}

/** Failed runs that stopped the same way at the same station, as one line: most runs first. */
export type FailureGroup = { key: string; step: string | null; label: string; rows: InboxRow[]; newest: number | null };

export function groupFailures(rows: ReadonlyArray<InboxRow>): FailureGroup[] {
  const by = new Map<string, InboxRow[]>();
  for (const r of rows) {
    const k = r.fail?.key ?? `raw:${r.detail ?? ""}`;
    by.set(k, [...(by.get(k) ?? []), r]);
  }
  return [...by].map(([key, rs]) => {
    const labels = new Set(rs.map((r) => r.fail?.label ?? r.detail ?? "Failed"));
    // Runs that agree say it whole ("Out of time, 3h"); runs that differ in the detail say what they share.
    const label = labels.size === 1 ? [...labels][0] : [...labels][0].split(",")[0];
    const newest = rs.reduce<number | null>((n, r) => (r.at != null && (n == null || r.at > n) ? r.at : n), null);
    return { key, step: rs[0].fail?.step ?? null, label, rows: [...rs].sort((a, b) => (b.at ?? 0) - (a.at ?? 0)), newest };
  }).sort((a, b) => b.rows.length - a.rows.length || (b.newest ?? 0) - (a.newest ?? 0));
}

/** Each problem in the Inbox and the group it is listed under, by task id. */
export function inboxKindByCase(groups: ReadonlyArray<InboxGroup>): Map<string, InboxKind> {
  const out = new Map<string, InboxKind>();
  // Only what the "for you" count counts (isProblemRow), so the Problems filter and every badge agree.
  for (const g of groups) for (const r of g.rows) if (r.caseId && isProblemRow(r) && !out.has(r.caseId)) out.set(r.caseId, g.kind);
  return out;
}

/** A row that waits on the viewer: a project whose line cannot start is not a problem, a watched one asks nothing, and
 *  a proposal no session asked has nobody to answer. */
const isProblemRow = (r: InboxRow) => r.kind !== "stuck" && r.kind !== "watching" && r.kind !== "proposal";

/** "For you": the problems waiting on the viewer. One count for the header, the Inbox's nav badge, the picker,
 *  the project filter and the Problems view's For you filter; a project that cannot start is listed, never counted. */
export const inboxCount = (groups: ReadonlyArray<InboxGroup>) => groups.reduce((n, g) => n + g.rows.filter(isProblemRow).length, 0);

type ProcessRun = Pick<GraphRun, "_id" | "task_id" | "workflow_slug" | "workflow_name" | "created_at">;
type ProcessTask = { _id: string; project_id?: string | null };

/** The process (lineGraphs processIndex) each Inbox row, and each problem, belongs to: one reading for the picker's
 *  counts and the project filter's, so they agree. */
export function inboxProcessOf(runs: ReadonlyArray<ProcessRun>, tasks: ReadonlyArray<ProcessTask>) {
  const projectOf = new Map(tasks.map((t) => [t._id, t.project_id ?? null]));
  const process = processIndex(runs, (id) => projectOf.get(id));
  const runById = new Map(runs.map((r) => [r._id, r]));
  return {
    row: (row: Pick<InboxRow, "caseId" | "runId" | "projectId">) => {
      const run = !row.caseId && row.runId ? runById.get(row.runId) : undefined;
      return run ? graphKeyOf(run) : row.caseId ? process.task(row.caseId, row.projectId) : process.project(row.projectId);
    },
    task: (t: ProcessTask) => process.task(t._id, t.project_id ?? null),
  };
}

/** How many problems wait on the viewer in each process: each counts under exactly one, so the counts sum to the total. */
export function inboxByGraph(groups: ReadonlyArray<InboxGroup>, of: ReturnType<typeof inboxProcessOf>): Map<string, number> {
  const out = new Map<string, number>();
  for (const g of groups) for (const row of g.rows) {
    if (!isProblemRow(row)) continue;
    const key = of.row(row);
    out.set(key, (out.get(key) ?? 0) + 1);
  }
  return out;
}

/**
 * Per project, in the process drawn: the problems waiting on the viewer and the problems not closed (problemTable
 * isActiveProblem). Read over every project's rows and model whatever the filter, so a project's numbers never move
 * when it is picked and the projects sum to the whole. A problem waiting on the viewer is open by definition, so
 * For you never exceeds Open.
 */
export function lineProjectCounts(
  groups: ReadonlyArray<InboxGroup>,
  of: ReturnType<typeof inboxProcessOf>,
  drawn: string | null,
  issues: ReadonlyArray<LineIssue>,
  projectOf: (taskId: string) => string | null | undefined,
  lessons?: ReadonlySet<string>,
): Map<string, { forYou: number; open: number }> {
  const forYou = new Map<string, Set<string>>();
  const open = new Map<string, Set<string>>();
  const add = (m: Map<string, Set<string>>, p: string, id: string) => (m.get(p) ?? m.set(p, new Set()).get(p)!).add(id);
  for (const g of groups) for (const r of g.rows) {
    if (!isProblemRow(r) || !r.projectId || of.row(r) !== drawn) continue;
    add(forYou, r.projectId, r.key);
    if (r.caseId) add(open, r.projectId, r.caseId);
  }
  for (const i of issues) {
    const p = projectOf(i.id);
    if (p && isCountedActive(i, lessons)) add(open, p, i.id);
  }
  const out = new Map<string, { forYou: number; open: number }>();
  for (const p of new Set([...forYou.keys(), ...open.keys()])) out.set(p, { forYou: forYou.get(p)?.size ?? 0, open: open.get(p)?.size ?? 0 });
  return out;
}
