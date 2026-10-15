// The decision a line run puts in front of the owner about its problem
// (line-workspace.md): a session_decisions row whose task_id is the problem and
// whose workflow_run_id is the run, asked by the run's own session. Inbox and
// Problems both ask "what decision waits on this problem?" through here, over
// the two store homes a fix decision can sit in: sessionDecisions (the viewer's
// own queue, the full row) and lineCards (every line card in the workspace,
// a slim row). Pure, so a test reads it.
import { PHASE_ORDER, guessPhase } from "@codecast/shared/contracts/linePhases";

export type FixDecisionRow = { _id: string; short_id?: string; status: string; task_id?: string; workflow_run_id?: string; gate_node_id?: string; created_at?: number; card?: unknown };
type Rows = Record<string, FixDecisionRow> | undefined;

/** A decision is a fix decision when a run asked it about a problem. */
export const isFixDecision = (d: FixDecisionRow): boolean => !!d.task_id && !!d.workflow_run_id;

const cache = new WeakMap<object, WeakMap<object, Map<string, FixDecisionRow>>>();
const EMPTY = {};

/**
 * Every open fix decision by its problem's task id, the newest when a problem
 * has several (a later run's card supersedes an earlier one). Cached by the two
 * collections' refs, so a selector may call it on every store change.
 */
export function openFixDecisions(own: Rows, line: Rows): Map<string, FixDecisionRow> {
  const a = own ?? EMPTY;
  const b = line ?? EMPTY;
  let inner = cache.get(a);
  if (!inner) { inner = new WeakMap(); cache.set(a, inner); }
  const hit = inner.get(b);
  if (hit) return hit;
  const out = new Map<string, FixDecisionRow>();
  // The own row wins over the line's slim copy of the same decision: it is the one answers land on first.
  const seen = new Map<string, FixDecisionRow>();
  for (const d of Object.values(b as Record<string, FixDecisionRow>)) seen.set(d._id, d);
  for (const d of Object.values(a as Record<string, FixDecisionRow>)) seen.set(d._id, d);
  for (const d of seen.values()) {
    if (d.status !== "pending" || !isFixDecision(d)) continue;
    const was = out.get(d.task_id!);
    if (!was || (d.created_at ?? 0) > (was.created_at ?? 0)) out.set(d.task_id!, d);
  }
  inner.set(b, out);
  return out;
}

/** The open fix decision waiting on one problem (its task id), or null. */
export function openFixDecisionFor(own: Rows, line: Rows, taskId: string | null | undefined): FixDecisionRow | null {
  return taskId ? openFixDecisions(own, line).get(taskId) ?? null : null;
}

/** A gate before the fix is built (a run from when the line asked for its plan's approval, or let its builder ask):
 *  what it asked is not the fix presented. */
const asksBeforeTheFix = (gate: string | undefined): boolean => !!gate && PHASE_ORDER.indexOf(guessPhase(gate)) < PHASE_ORDER.indexOf("decide");

/**
 * The decision a run presented its fix as, whatever became of it since (still open, answered, lapsed): the newest of
 * that run's about the problem, from either store home. Null when no session of the run has presented one.
 */
export function runFixDecision(own: Rows, line: Rows, taskId: string | null | undefined, runId: string | null | undefined): FixDecisionRow | null {
  if (!taskId || !runId) return null;
  let best: FixDecisionRow | null = null;
  for (const rows of [line, own]) for (const d of Object.values(rows ?? EMPTY) as FixDecisionRow[]) {
    if (d.task_id !== taskId || d.workflow_run_id !== runId || asksBeforeTheFix(d.gate_node_id)) continue;
    if (!best || (d.created_at ?? 0) >= (best.created_at ?? 0)) best = d;
  }
  return best;
}

/**
 * The problem a decision named by ref (short id or row id) is about, from either store home; undefined when
 * neither holds it. A view that leads a problem with a decision from the address checks this first, so a
 * decision never leads a problem it is not about.
 */
export function decisionTask(own: Rows, line: Rows, ref: string): string | null | undefined {
  for (const rows of [own, line]) for (const d of Object.values(rows ?? EMPTY) as FixDecisionRow[]) if (d._id === ref || d.short_id === ref) return d.task_id ?? null;
  return undefined;
}

/** How the line's address names a decision: its short id when it has one. */
export const decisionRef = (d: Pick<FixDecisionRow, "_id" | "short_id">): string => d.short_id ?? d._id;

/**
 * A trial run's decision in the words a trial answer means: it records what you
 * would have done and ships nothing, so the question asks what you would do and
 * each option says it as "Would ...". A live run's decision reads as asked.
 */
export function trialWords<D extends { question: string; options: ReadonlyArray<{ label: string }> }>(d: D): D {
  const question = d.question
    .replace(/^ship this change\?\s*/i, "Would you ship this? ")
    .replace(/^(ship|build|merge|apply)\b/i, (m) => `Would you ${m.toLowerCase()}`)
    .trim();
  // An answer the session wrote in its own words keeps what it wrote under it: the fact that sizes the choice and
  // what happens next. A bare verb (Ship, Revise, Drop) stays bare: what it does shows after the press, and
  // "nothing ships" is said once, by the trial mark, never on every option.
  return { ...d, question, options: d.options.map((o: { label: string; description?: string }) => { if (!BARE_VERB.test(o.label.trim())) return o; const { description: _d, ...bare } = o; return bare; }) as unknown as D["options"] };
}

/** Whether a decision's answers are only routing verbs, with no words of the session's own: the fixed controls may stand in for them. */
export const bareVerbAnswers = (options: ReadonlyArray<{ label: string }>): boolean => options.every((o) => BARE_VERB.test(o.label.trim()));

/** An option that is only a routing verb. */
const BARE_VERB = /^(?:\[[^\]]*\]\s*)?(?:ship|revise|drop|publish|not now|build it|approve|skip)$/i;

const WOULD: Record<string, string> = { "not now": "Would hold off", "build it": "Would build it", approve: "Would approve", skip: "Would skip" };

/** One option as a trial answer: "Ship" reads "Would ship", "Not now" reads "Would hold off". */
export function wouldLabel(label: string): string {
  const bare = label.replace(/^\[[^\]]*\]\s*/, "").trim();
  if (/^would\b/i.test(bare)) return bare;
  const known = WOULD[bare.toLowerCase()];
  if (known) return known;
  return `Would ${bare.charAt(0).toLowerCase()}${bare.slice(1)}`;
}

/** The option key each verdict of a line card answers: a change card's Ship, Revise, Drop; a proposal's Build it, Revise, Not now. */
const VERDICT_KEY: Record<string, { key: string; label: RegExp }> = {
  ship: { key: "S", label: /^(would )?ship\b/i }, revise: { key: "R", label: /^(would )?revise\b/i }, drop: { key: "D", label: /^(would )?drop\b/i },
  build: { key: "A", label: /^(would )?(build|approve)\b/i }, wait: { key: "D", label: /^(would )?(not now|hold off|wait)\b/i },
};

/**
 * Which of a decision's options its run recommends: the option the card's verdict names, found by its key on the
 * trial card's own options (same order as the decision's), else by how its label starts. Null when the run
 * recommends nothing or no option says it, so nothing is marked on a guess.
 */
export function recommendedOption(verdict: string | null | undefined, options: ReadonlyArray<{ label: string }>, keyed?: ReadonlyArray<{ key: string }> | null): number | null {
  const v = verdict ? VERDICT_KEY[verdict] : undefined;
  if (!v) return null;
  const byLabel = options.findIndex((o) => v.label.test(o.label.replace(/^\[[^\]]*\]\s*/, "").trim()));
  if (byLabel >= 0) return byLabel;
  const byKey = keyed && keyed.length === options.length ? keyed.findIndex((o) => o.key.toUpperCase() === v.key) : -1;
  return byKey >= 0 ? byKey : null;
}
