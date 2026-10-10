// A ref the line knows, resolved (docs/architecture/line-workspace.md LW1):
// a signal, a fingerprint, a cause task, a run or a card decision names its
// cause, and where it opens in the project's workspace. Also the words a
// finding and a cause's doubt read in, shared by the task's story, the
// decision page and the workspace's model. Pure: no store, no React.
import type { LineCauseTask } from "../lineFlow";
import type { MapDecision, MapRun, MapSignal } from "./lineMap";

/** An earlier visit of a loop: a run row keeps one status per station, its newest. */
export const EARLIER_ROUND_WORDS = "An earlier round: the line keeps the details of a station's newest visit only";

export type TraceTask = LineCauseTask & { review_verdict?: { verdict: string } | null; comments?: Array<{ text?: string; content?: string }> | null };

export type TraceRows = { signals: MapSignal[]; tasks: TraceTask[]; runs: MapRun[]; decisions: MapDecision[] };

// ── resolving a ref ──────────────────────────────────────────────────────────

export type TraceRefKind = "cause" | "signal" | "fingerprint" | "run" | "decision";
export type ResolvedTrace = { cause: TraceTask; via: TraceRefKind; focusId: string };

/**
 * The cause any ref names (LX4): a task's id or short id, a signal's id or
 * short id, a fingerprint (a signal's, or one the cause row keeps), a run id,
 * a decision's id or short id. Null when the rows hold no cause for it.
 */
export function resolveTraceRef(ref: string, rows: TraceRows): ResolvedTrace | null {
  const key = ref.trim();
  if (!key) return null;
  const taskById = new Map(rows.tasks.map((t) => [t._id, t]));
  const hit = (taskId: string | null | undefined, via: TraceRefKind, focusId: string): ResolvedTrace | null => {
    const cause = taskId ? taskById.get(taskId) : undefined;
    return cause ? { cause, via, focusId } : null;
  };
  const task = rows.tasks.find((t) => t._id === key || t.short_id === key);
  if (task) return { cause: task, via: "cause", focusId: task._id };
  const signal = rows.signals.find((s) => s._id === key || s.short_id === key);
  if (signal) return hit(signal.task_id, "signal", signal._id);
  const run = rows.runs.find((r) => r._id === key);
  if (run) return hit(run.task_id, "run", run._id);
  const decision = rows.decisions.find((d) => d._id === key || d.short_id === key);
  if (decision) return hit(decision.task_id ?? rows.runs.find((r) => r._id === decision.workflow_run_id)?.task_id, "decision", decision._id);
  // A fingerprint: the newest signal carrying it, else the cause that keeps it.
  const fp = rows.signals.filter((s) => s.fingerprint === key).sort((a, b) => b.created_at - a.created_at)[0];
  if (fp) return hit(fp.task_id, "fingerprint", fp._id);
  const holder = rows.tasks.find((t) => t.cause?.fingerprints?.includes(key));
  return holder ? { cause: holder, via: "fingerprint", focusId: holder._id } : null;
}

/**
 * Where a resolved ref opens in its project's workspace (line-workspace.md
 * LW1): a run opens Replay on it; a card opens Replay on the run that asked
 * it, at the card; a problem, a finding or a fingerprint opens the problem's
 * Timeline (no run).
 */
export function lineWorkspaceTarget(resolved: ResolvedTrace, rows: Pick<TraceRows, "decisions">): { run: string | null; atCard: boolean } {
  if (resolved.via === "run") return { run: resolved.focusId, atCard: false };
  if (resolved.via === "decision") {
    const d = rows.decisions.find((x) => x._id === resolved.focusId);
    return { run: d?.workflow_run_id ?? null, atCard: true };
  }
  return { run: null, atCard: false };
}

/** Markdown's inline marks taken off, so a finder's words read as words. */
export const plainWords = (s: string) => s.replace(/(\*\*|__)(.+?)\1/g, "$2").replace(/`([^`]+)`/g, "$1").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/^[>*-]\s+/, "").trim();
/** The first line of prose in a finder's markdown: headings are its labels, not its words. */
const firstLine = (s: string | null | undefined): string | null => {
  const line = s?.split("\n").map((l) => l.trim()).find((l) => l && !l.startsWith("#"));
  return line ? plainWords(line) || null : null;
};
/** What the finder saw, in its words: when the finding breaks an expectation,
 *  the finder's markdown opens with that expectation's own sentence
 *  ("**<line>** (severity 7/10, <id>)"), which the title and the Breaks chip
 *  already say, so the words are the first line after it. */
export const finderWords = (md: string | null | undefined, breaks: string | null): string | null => readableFinding(finderLine(md, breaks));
/** A finder's tally tail in words: "(severity 9/10, party_confidence)" reads "(severity 9 of 10)"; the judge's field name is its own. */
const readableFinding = (s: string | null) => s?.replace(/\s*\(severity (\d+)\s*\/\s*10(?:,\s*[\w.:-]+)?\)/i, " (severity $1 of 10)") ?? null;
const finderLine = (md: string | null | undefined, breaks: string | null): string | null => {
  if (!md || !breaks) return firstLine(md);
  const lines = md.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  const own = lines.filter((l) => !(l.startsWith("**") && l.includes(breaks)));
  return firstLine(own.join("\n")) ?? firstLine(md);
};

/** A doubt the record raised about the cause that a reviewer must see: the
 *  grounding or review read the signal as not matching the cause, or
 *  grounding said a person must confirm it before it is built. `words` is
 *  the chip, `why` the note that raised it. Null when nothing doubts it. */
export type CauseDoubt = { words: string; why: string };
const MISMATCH = /\b(?:may|might|does(?:n't| not)|did(?:n't| not)) (?:not )?match\b|\btitle (?:claims|should be corrected|is wrong)|\bconfirm whether\b|\bcause (?:should be )?split\b|\bnot the same (?:problem|cause)\b|\bunrelated to the (?:signal|cause)\b/i;
export function causeDoubt(cause: { readiness?: string | null; readiness_note?: string | null; review_verdict?: { verdict?: string; note?: string } | null }): CauseDoubt | null {
  const ground = cause.readiness_note?.trim() ?? "";
  const review = cause.review_verdict?.note?.trim() ?? "";
  const said = [ground, review].find((t) => MISMATCH.test(t));
  if (said) return { words: "The finding may not match this problem", why: said };
  if (cause.readiness === "needs_context") return { words: "Grounding asked a person to confirm this problem", why: ground || "Grounding marked the problem as needing more context." };
  return null;
}
