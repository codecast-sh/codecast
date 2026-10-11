// The Problems view's table (line-workspace.md LW1 Problems): one row per
// problem with where it came from, where it stands in five words a person
// acts on, whether it came back after a close, and how to sort and filter the
// lot. Pure; the state underneath is timeline.ts problemState over the model's
// history, so the table and a problem's page never disagree.
import type { LineIssue } from "./lineModel";
import { attemptEndWords, cameBackCount, problemState, type ProblemState } from "./timeline";
import { sourceLabel } from "./loopSteps";

/** Where a problem stands, as a person acts on it. */
export type ProblemStatus = "waiting" | "running" | "open" | "watching" | "closed";

export const PROBLEM_STATUSES: ReadonlyArray<ProblemStatus> = ["waiting", "running", "open", "watching", "closed"];

export const PROBLEM_STATUS_WORDS: Record<ProblemStatus, string> = {
  waiting: "Waiting on you",
  running: "Running",
  open: "Open",
  watching: "Watching",
  closed: "Closed",
};

/**
 * The five-way status from the finer state: running while an attempt is live;
 * waiting on you when its last run stopped for a person (a card, a question) or
 * it shipped past a card nobody answered, or it is in review; watching while a shipped fix is under
 * watch; closed once a close held (or it folded into another cause); open
 * otherwise, which includes a problem that came back (the row flags that apart).
 */
export function problemStatus(issue: Pick<LineIssue, "history" | "status"> & { ask?: string | null }, state: ProblemState): ProblemStatus {
  const h = issue.history;
  if (h.attempts.some((a) => a.live)) return "running";
  if (issue.ask) return "waiting";
  if (state === "unapproved") return "waiting";
  if (state === "watching") return "watching";
  if (state === "held" || state === "closed" || state === "folded") return "closed";
  const last = h.attempts[h.attempts.length - 1];
  if (last && !last.ended && last.outcome.tone === "waiting") return "waiting";
  // In review is the person's (the inbox lists it); a problem the line has not started is open, whatever held it.
  if (issue.status === "in_review") return "waiting";
  return "open";
}

/** Why a problem waits on you, in a word or two: what the person opens to act on it. Null when it does not wait on you. */
export function waitingWhy(issue: Pick<LineIssue, "history" | "status"> & { ask?: string | null }, status: ProblemStatus): string | null {
  if (status !== "waiting") return null;
  if (issue.ask) return "question";
  const last = issue.history.attempts[issue.history.attempts.length - 1];
  if (last?.unapproved && last.ended === "shipped") return "shipped unapproved";
  if (last && !last.ended && last.outcome.tone === "waiting") return last.card && !last.card.answer ? "card" : "question";
  return issue.status === "in_review" ? "in review" : null;
}

/**
 * Where the problem stands now, as a few facts read off its newest attempt, in the order they happened:
 * "#3", "merged, not deployed", "unapproved". One reading every surface of the problem's header shows,
 * so the pill, the chart and the run card never say three different things.
 */
export function problemNow(issue: Pick<LineIssue, "history">): string[] {
  const h = issue.history;
  const last = h.attempts[h.attempts.length - 1];
  if (!last) return [];
  const out = [`#${last.n}`];
  if (last.live) return [...out, "running"];
  const shipped = last.ended === "shipped" || !!last.merge || h.ships.some((s) => s.runId === last.runId);
  // The run's one outcome (attemptVerdict): the same words its chip, its Runs row and its chart mark say.
  out.push(attemptEndWords(last, h));
  const card = last.card;
  // A fix past a card nobody answered is unapproved, whatever became of the card; any other card says its state.
  if (shipped && last.unapproved) out.push("unapproved");
  else if (card) {
    const st = card.status.toLowerCase();
    out.push(card.answer ? `card: ${card.answer.toLowerCase()}` : st === "pending" ? "card waiting" : `card ${st}`);
  }
  if (h.regressed) out.push("came back");
  return out;
}

export type ProblemSource = { key: string; label: string; n: number };

export type ProblemTableRow = {
  id: string;
  issue: LineIssue;
  state: ProblemState;
  status: ProblemStatus;
  /** How many times it came back after any close; 0 when every close held. */
  back: number;
  /** Where its findings came from, most first. */
  sources: ProblemSource[];
  projectId: string | null;
  /** Findings in all: what the cause holds, or the occurrences read when more. */
  findings: number;
  /** The newest thing that happened to it: a finding, a run, a ship. */
  lastAt: number;
};

type SignalLike = { task_id: string; source: string };
type TaskLike = { _id: string; project_id?: string | null };

/** Every problem's row, its sources counted from the findings in view (and the quotes the model kept, for one whose findings are older). */
export function buildProblemRows(issues: ReadonlyArray<LineIssue>, signals: ReadonlyArray<SignalLike>, tasks: ReadonlyArray<TaskLike>): ProblemTableRow[] {
  const bySource = new Map<string, Map<string, number>>();
  for (const s of signals) {
    if (!s.task_id) continue;
    const m = bySource.get(s.task_id) ?? new Map<string, number>();
    m.set(s.source, (m.get(s.source) ?? 0) + 1);
    bySource.set(s.task_id, m);
  }
  const projectOf = new Map(tasks.map((t) => [t._id, t.project_id ?? null]));
  return issues.map((issue) => {
    const state = problemState(issue.history, issue.status);
    const counts = new Map(bySource.get(issue.id) ?? []);
    if (!counts.size) for (const q of issue.quotes) counts.set(q.source, (counts.get(q.source) ?? 0) + 1);
    const sources = [...counts].map(([key, n]) => ({ key, label: sourceLabel(key), n })).sort((a, b) => b.n - a.n || a.label.localeCompare(b.label));
    return {
      id: issue.id,
      issue,
      state,
      status: problemStatus(issue, state),
      back: cameBackCount(issue.history),
      sources,
      projectId: projectOf.get(issue.id) ?? null,
      findings: Math.max(issue.findings, issue.history.occurrences.length),
      lastAt: Math.max(issue.history.lastActivity || 0, issue.lastRunAt || 0),
    };
  });
}

/** A status filter: one status, every problem not closed (the default, what the nav counts), or all of them. */
export type StatusFilter = ProblemStatus | "active" | "all";

export type ProblemFilter = { status: StatusFilter; source: string | null; back: boolean; query: string };

export const NO_FILTER: ProblemFilter = { status: "all", source: null, back: false, query: "" };

const statusMatch = (f: StatusFilter, s: ProblemStatus) => f === "all" || (f === "active" ? s !== "closed" : s === f);

/** The problems still open in any sense (not closed): the count the workspace's nav shows for Problems. */
export const activeProblemCount = (issues: ReadonlyArray<LineIssue>): number =>
  issues.filter((i) => problemStatus(i, problemState(i.history, i.status)) !== "closed").length;

/** The rows a filter keeps; each filter part narrows, the query matches the title, the ref or a source's name. */
export function filterProblems(rows: ReadonlyArray<ProblemTableRow>, f: ProblemFilter): ProblemTableRow[] {
  const q = f.query.trim().toLowerCase();
  return rows.filter((r) =>
    statusMatch(f.status, r.status)
    && (!f.source || r.sources.some((s) => s.key === f.source))
    && (!f.back || r.back > 0)
    && (!q || r.issue.title.toLowerCase().includes(q) || (r.issue.ref ?? "").toLowerCase().includes(q) || r.sources.some((s) => s.label.toLowerCase().includes(q))));
}

/** Counts for the filter controls, each over the rows the other filter parts keep, so a count says what a click will show. */
export function problemCounts(rows: ReadonlyArray<ProblemTableRow>, f: ProblemFilter) {
  const status = new Map<StatusFilter, number>();
  for (const r of filterProblems(rows, { ...f, status: "all" })) {
    status.set(r.status, (status.get(r.status) ?? 0) + 1);
    status.set("all", (status.get("all") ?? 0) + 1);
    if (r.status !== "closed") status.set("active", (status.get("active") ?? 0) + 1);
  }
  const sources = new Map<string, ProblemSource>();
  for (const r of filterProblems(rows, { ...f, source: null })) {
    for (const s of r.sources) {
      const was = sources.get(s.key);
      sources.set(s.key, { key: s.key, label: s.label, n: (was?.n ?? 0) + 1 });
    }
  }
  return {
    status,
    sources: [...sources.values()].sort((a, b) => b.n - a.n || a.label.localeCompare(b.label)),
    back: filterProblems(rows, { ...f, back: true }).length,
  };
}

export type ProblemSortKey = "last" | "title" | "source" | "findings" | "attempts" | "status" | "back";
export type ProblemSort = { key: ProblemSortKey; desc: boolean };
export const DEFAULT_SORT: ProblemSort = { key: "last", desc: true };

/** The direction a column sorts on its first click: numbers and time biggest first, words A to Z. */
export const firstDesc = (key: ProblemSortKey) => key !== "title" && key !== "source" && key !== "status";

const STATUS_RANK: Record<ProblemStatus, number> = { waiting: 0, running: 1, open: 2, watching: 3, closed: 4 };

/** Sorted by a column; ties fall to the newest activity, then the ref, so the order is stable across a rebuild. */
export function sortProblemRows(rows: ReadonlyArray<ProblemTableRow>, s: ProblemSort): ProblemTableRow[] {
  const dir = s.desc ? -1 : 1;
  const key = (r: ProblemTableRow): number | string => {
    switch (s.key) {
      case "title": return r.issue.title.toLowerCase();
      case "source": return r.sources[0]?.label.toLowerCase() ?? "￿";
      case "findings": return r.findings;
      case "attempts": return r.issue.history.attempts.length;
      case "status": return STATUS_RANK[r.status];
      case "back": return r.back;
      default: return r.lastAt;
    }
  };
  return [...rows].sort((a, b) => {
    const x = key(a);
    const y = key(b);
    const c = x < y ? -1 : x > y ? 1 : 0;
    return c * dir || b.lastAt - a.lastAt || (a.issue.ref ?? a.id).localeCompare(b.issue.ref ?? b.id);
  });
}

/** Everything a row draws, so a model rebuild keeps the rows that did not move. */
export function problemTableSig(r: ProblemTableRow): string {
  const h = r.issue.history;
  return [
    r.id, r.issue.title, r.issue.ref ?? "", r.status, r.state, r.back, r.findings, r.lastAt, r.projectId ?? "",
    r.sources.map((s) => `${s.key}:${s.n}`).join(","),
    h.occurrences.length, h.occurrences[h.occurrences.length - 1]?.at ?? 0,
    h.closes.map((c) => `${c.kind}${c.at}`).join(","),
    h.attempts.map((a) => `${a.runId}:${a.live ? 1 : 0}:${a.ended ?? ""}:${a.outcome.tone}`).join(","),
  ].join("|");
}
