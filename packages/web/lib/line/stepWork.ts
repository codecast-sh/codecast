// A step's work as its page lists it (line-journeys.md LJ8.6): one row per
// visit of a problem to the step, filed under exactly one of Waiting,
// Failed or Passed. The three counts are the page's only filters and each is
// the number of rows it opens, so the Line table and the Map read the same
// counts. Failed rows are grouped by cause, the cause in plain words. Also the
// words a row is read in: an outcome key a person never typed ("red",
// "mechanism") reads as what happened, and a report's fields read under names
// a person uses, with machine paths left out. Pure.
import { decisionSaid, decisionsByCase, tallyKey, type LineStep, type StepDecision, type StepKind } from "./lineModel";
import { DECISION_STATE_WORDS } from "./decisionOutcome";
import { stationCatalogWords } from "./runReport";
import { checkName, scriptChecks } from "./scriptReport";

export const STEP_SHOWS = ["waiting", "failed", "passed"] as const;
export type StepShow = (typeof STEP_SHOWS)[number];
export const isStepShow = (v: string | null | undefined): v is StepShow => !!v && (STEP_SHOWS as readonly string[]).includes(v);

/** How one row stands: `stopped` is a run that finished here with no next step and needs a person's yes; `replaced` one a newer run took over. */
export type WorkState = "waiting" | "running" | "stopped" | "failed" | "passed" | "replaced";
export type WorkCause = { key: string; label: string; /** The cause whole, when the heading had to shorten it. */ whole?: string };
export type WorkRow = {
  /** The problem's id, else the run's. */
  key: string;
  /** The newest visit of this problem at the step. */
  d: StepDecision;
  /** Earlier visits of the same problem, newest first. */
  earlier: StepDecision[];
  state: WorkState;
  /** Why it failed, for a failed row. */
  cause: WorkCause | null;
  /** Older visits of the same problem that failed for the same cause: one row says them all ("failed 2 times"). */
  again?: StepDecision[];
};
export type FailGroup = WorkCause & { rows: WorkRow[] };
export type StepWork = {
  waiting: WorkRow[];
  failed: FailGroup[];
  passed: WorkRow[];
  /** Left waiting or running when a newer run took the problem up: listed last, in no count. */
  replaced: WorkRow[];
  counts: Record<StepShow, number>;
};

export type StepWorkInput = {
  /** Runs that finished at this step with no next step (lineModel run outcome tone "waiting" on a failed run): a need, never a failure. */
  stopped?: ReadonlySet<string>;
  /** Why a run failed, by run id, when its run row says (runReport failCause, only for a run that failed at this step). */
  causes?: ReadonlyMap<string, WorkCause>;
};

const BARE_FAIL = /^(fail|failed|failure|cut off)$/i;
/** A ref leads a sentence as it is written ("ct-59231 has no findings"), never capitalized. */
const LEADING_REF = /^[a-z]{1,4}-\d/;
const sentence = (t: string) => { const s = t.replace(/\s+/g, " ").trim(); return s && !LEADING_REF.test(s) ? s.charAt(0).toUpperCase() + s.slice(1) : s; };

/** Why a failed visit failed: the run's own reason when it failed here, else the outcome the step reported, else none recorded. */
export function failCauseOf(d: StepDecision, causes?: ReadonlyMap<string, WorkCause>): WorkCause {
  const own = d.decided.outcome;
  // The line's own label for a step that failed ("Could not write a test for the problem") is no reason: it claims what nobody said.
  const stepId = d.id.slice(d.runId.length + 1);
  const words = stationCatalogWords(stepId, d.decided.words?.trim()) ? undefined : d.decided.words?.trim();
  const run = causes?.get(d.runId);
  // A timeout, a loop, a red check: the run's own reason says what happened. A dead end ("Prove gave no result") only
  // says the run stopped; the step's own words for the way it failed ("Could not write a test for the problem") say why.
  if (run && !run.key.startsWith("deadend")) return { key: run.key, label: sentence(run.label) };
  // A check runner names what failed: "touched tests failed" groups every visit those checks stopped.
  const red = scriptChecks(d.decided.result)?.rows.filter((r) => !r.ok).map((r) => checkName(r.name)) ?? [];
  if (red.length) return { key: `checks:${red.join(",").toLowerCase()}`, label: sentence(`${red.join(", ")} failed`) };
  if (words && !BARE_FAIL.test(words)) return { key: `said:${words.toLowerCase()}`, label: sentence(plainOutcome(words)) };
  const said = words ? decisionSaid(d).replace(/[.…]+$/, "").trim() : concludedText(d.reasoning)?.split("\n")[0].replace(/[.…]+$/, "").trim();
  if (said && !BARE_FAIL.test(said) && said.length <= 120) return { key: `said:${said.toLowerCase()}`, label: sentence(said) };
  if (run) return { key: run.key, label: sentence(run.label) };
  if (own && !BARE_FAIL.test(own)) return { key: `out:${own.toLowerCase()}`, label: sentence(plainOutcome(own)) };
  return { key: "none", label: "Ended with no reason recorded" };
}

function stateOf(d: StepDecision, stopped?: ReadonlySet<string>): WorkState {
  if (d.superseded) return "replaced";
  if (d.status === "waiting") return "waiting";
  if (d.status === "live") return d.answer?.state === "waiting" ? "waiting" : "running";
  // At a person's step only an answer is an answer: a lapsed or withdrawn decision is "No answer", whatever the run did next.
  if (d.answer) return d.answer.state === "answered" ? "passed" : d.answer.state === "waiting" ? "waiting" : "failed";
  if (stopped?.has(d.runId)) return "stopped";
  return tallyKey(d) === "failed" ? "failed" : "passed";
}

/** The step's rows under its three counts. */
export function stepWork(step: Pick<LineStep, "decisions">, input: StepWorkInput = {}): StepWork {
  const waiting: WorkRow[] = [];
  const passed: WorkRow[] = [];
  const replaced: WorkRow[] = [];
  const groups = new Map<string, FailGroup>();
  // One row per visit: a step that failed a problem twice and then passed it failed twice, and both failures say why.
  for (const g of decisionsByCase(step.decisions)) for (const d of [g.latest, ...g.earlier]) {
    const state = stateOf(d, input.stopped);
    // A problem's older visits name it by run; its newest by the problem, so a link to the problem opens that row.
    const row: WorkRow = { key: d === g.latest ? g.key : `run:${d.runId}`, d, earlier: d === g.latest ? g.earlier : [], state, cause: null };
    if (state === "replaced") replaced.push(row);
    else if (state === "waiting" || state === "running" || state === "stopped") waiting.push(row);
    else if (state === "passed") passed.push(row);
    else {
      row.cause = d.answer ? { key: `answer:${d.answer.state}`, label: DECISION_STATE_WORDS[d.answer.state] } : failCauseOf(d, input.causes);
      const head = causeHead(row.cause.label);
      if (head && head !== row.cause.label) row.cause = { ...row.cause, label: head, whole: row.cause.label };
      const had = groups.get(row.cause.key);
      // A problem that failed the same way twice is one row that says so, never two rows of one title.
      const same = had && d.caseId ? had.rows.find((x) => x.d.caseId === d.caseId) : undefined;
      if (same) (same.again ??= []).push(d);
      else if (had) had.rows.push(row);
      else groups.set(row.cause.key, { ...row.cause, rows: [row] });
    }
  }
  // What a person can act on leads: a wait on them, then a stop, then what is only running. Oldest wait first.
  const rank: Record<string, number> = { waiting: 0, stopped: 1, running: 2 };
  waiting.sort((a, b) => rank[a.state] - rank[b.state] || (a.d.at ?? 0) - (b.d.at ?? 0));
  // Most first; a cause nobody recorded never leads a tie, so the table's top cause is one a person can act on.
  const failed = [...groups.values()].sort((a, b) => b.rows.length - a.rows.length || Number(a.key === "none") - Number(b.key === "none") || a.label.localeCompare(b.label));
  return { waiting, failed, passed, replaced, counts: { waiting: waiting.length, failed: failed.reduce((n, g) => n + g.rows.length, 0), passed: passed.length } };
}

/** The filter a step opens on when the address names none: what waits at a person's step, else everything. */
export function defaultShow(kind: StepKind, counts: Record<StepShow, number>): StepShow | null {
  return kind === "person" && counts.waiting > 0 ? "waiting" : null;
}

/** The three counts' names by the step's kind: a person answers, an agent or a script passes. */
export function showLabels(kind: StepKind): Record<StepShow, string> {
  if (kind === "person") return { waiting: "Waiting", failed: "No answer", passed: "Answered" };
  return { waiting: "Waiting", failed: "Failed", passed: "Passed" };
}

/** Outcome keys the line's files use, as a person says them (LJ11). */
const PLAIN: Record<string, string> = {
  red: "failed its test", green: "passes its test", mechanism: "cause found", dissolved: "turned out not to be a problem",
  "handed on": "passed on", open: "still a problem", refined: "problem restated", proposed: "fix proposed", built: "fix built",
  approved: "review approved", changes: "review asked for changes", "not reproduced": "could not reproduce it", infeasible: "cannot be tested",
  "judge defect": "the judge was wrong", "wrong cause": "cause was wrong", superseded: "replaced by a newer run", "cut off": "failed",
};

/** An outcome as a person reads it: "red" is "failed its test", "not_reproduced" is "could not reproduce it". */
export function plainOutcome(key: string | null | undefined): string {
  const k = (key ?? "").replace(/_/g, " ").trim();
  return PLAIN[k.toLowerCase()] ?? k;
}

/** A report field's name as a person says it; null for a field that is the line's own bookkeeping. */
const FIELD_NAMES: Record<string, string | null> = {
  rung: "Test level", level: "Test level", check: "Command", command: "Command", cmd: "Command", red: "Test output", green: "Test output",
  output: "Test output", evidence: "Why", why: "Why", reason: "Why", detail: "Why", kind: "Why", into: "Folded into", residue: "Left over",
  files: "Files", statement: "Found", mechanism: "Cause", headline: "Change", dir: null, cwd: null, worktree: null, path: null, branch: "Branch",
  outcome: null, summary: null, session_id: null, run_id: null, task_id: null, scoped: null, select: "Tests chosen",
  // A check script's list of checks and its log folder: read as checks (checkRows); the folder is on the machine that ran it.
  steps: null, logs: null, ok: null,
};

/** A path on the machine that ran the step: nothing a reader can open. */
const MACHINE_PATH = /(?:^|[\s"'=(])(?:\/(?:Users|home|private|tmp|var|opt|root|mnt|srv|workspace)\/[^\s"')]+|[A-Za-z]:\\[^\s"')]+)/g;

/** Text without the machine's own paths: a file under the checkout keeps its repo path, a bare temp path goes. */
export function withoutMachinePaths(text: string): string {
  return text.replace(MACHINE_PATH, (m) => {
    const lead = /^[\s"'=(]/.test(m) ? m[0] : "";
    const path = lead ? m.slice(1) : m;
    // Inside a checkout or worktree, the part after it is the repo path a person knows.
    const repo = path.match(/\/(?:src|worktrees?|checkouts?|repos?)\/[^/]+\/(.+)$/)?.[1];
    return repo ? `${lead}${repo}` : lead;
  }).replace(/[ \t]{2,}/g, " ").trim();
}

function fieldText(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (Array.isArray(v)) return v.map((x) => (x && typeof x === "object" ? Object.values(x).map(fieldText).filter(Boolean).join(" · ") : fieldText(x))).filter(Boolean).join("\n");
  return Object.entries(v as Record<string, unknown>).map(([k, x]) => `${k.replace(/_/g, " ")}: ${fieldText(x)}`).join("; ");
}

export type ReportRow = { name: string; value: string; /** Printed text (a command, a test's output): shown in the fixed-width face. */ mono: boolean };

const MONO = new Set(["Command", "Test output", "Files", "Branch"]);

/** What a step reported, as rows a person reads: named in plain words, whole, machine paths and bookkeeping left out. */
export function reportRows(result: Record<string, unknown> | null | undefined): ReportRow[] {
  const out: ReportRow[] = [];
  for (const [k, v] of Object.entries(result ?? {})) {
    const known = k.toLowerCase() in FIELD_NAMES;
    const name = known ? FIELD_NAMES[k.toLowerCase()] : sentence(k.replace(/_/g, " "));
    // A yes or no under a key that names printed text ("red: false") says nothing a reader can use.
    if (!name || typeof v === "boolean" || v === "" || v == null || (Array.isArray(v) && !v.length)) continue;
    let value = withoutMachinePaths(fieldText(v));
    if (k === "kind") value = plainOutcome(value);
    if (k === "into" && /^[0-9a-f]{7,40}$/i.test(value)) continue;
    if (k === "residue" && value === "0") continue;
    if (!value) continue;
    const had = out.find((r) => r.name === name);
    if (had) had.value = `${had.value}\n${value}`;
    else out.push({ name, value, mono: MONO.has(name) });
  }
  return out;
}

/** A failure cause as a heading reads it: its first line, without machine paths, short enough to scan (the row shows it whole). */
export function causeHead(label: string): string {
  // A tool's printout leads with what passed ("✓ backend: 0 errors"): the heading is its first line that names a failure.
  const lines = label.split(/\n|(?=✓)|(?<=\))\s+(?=\.{0,2}\/)/).map((l) => l.trim()).filter((l) => l && !/^\d+$/.test(l));
  const bad = lines.length > 1 && lines[0].startsWith("✓") ? lines.find((l) => !l.startsWith("✓") && /\berror\b|✗|\bfail(?:ed|s)?\b/i.test(l)) : undefined;
  const first = withoutMachinePaths(bad ?? lines[0] ?? "").replace(/\s+/g, " ").trim();
  return first.length > 120 ? `${first.slice(0, 119).trimEnd()}…` : first;
}

/** A step's own words without the JSON block it reported beside them, and without machine paths. */
export function concludedText(reasoning: string | null | undefined): string | null {
  const t = withoutMachinePaths((reasoning ?? "").replace(/```(?:json)?[ \t]*\n[\s\S]*?\n[ \t]*```/g, "").replace(/\n{3,}/g, "\n\n").trim());
  if (!t || /^[{[]/.test(t)) return null;
  return t;
}

/** The decision a session presented for one waiting visit: the pending card of that run at that step, the newest when several. */
export function visitDecision<C extends { _id: string; short_id?: string; status: string; workflow_run_id?: string; gate_node_id?: string; created_at?: number }>(
  cards: Iterable<C>, runId: string, stepId: string, status: "pending" | "any" = "pending",
): C | null {
  let best: C | null = null;
  for (const c of cards) {
    if (c.workflow_run_id !== runId || (status === "pending" && c.status !== "pending")) continue;
    // A card that names its gate must name this one; an older card with no gate belongs to its run's one person step.
    if (c.gate_node_id && c.gate_node_id !== stepId) continue;
    if (!best || (c.created_at ?? 0) > (best.created_at ?? 0)) best = c;
  }
  return best;
}
