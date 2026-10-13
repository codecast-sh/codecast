// What a run's page (line-journeys.md LJ8.4) reads that no other view does,
// pure and tested: how the run ended as one of eight endings, the step that
// carries that ending (the one the page opens on), and the head's one line of
// state. A failed run reads at the step it really failed in (stageTrack
// firstFailedVisit, LJ9 item 8): the engine names the step that received
// nothing ("no outgoing edge from prove"), a reader needs "Failed at Ground
// after 7s".
import type { LineModel, LineRunModel, LineVisit } from "./lineModel";
import type { TraceStep } from "./runTrace";
import { runEndWords } from "./replay";
import { failCause, finishedAtDeadEnd, shortDay, stoppedOnPurpose, type FailCause, type ReportRun } from "./runReport";
import { closeOutcome, closeSentence } from "./scriptReport";
import { STAGE_DOING, firstFailedVisit } from "./stageTrack";
import { unansweredWords } from "./problemPage";

/** How a run ended, as the page's primary action reads it (LJ8.4's table, with the two ends the table folds:
 *  `lapsed`, a decision nobody answered, and `closed`, a run that ended its problem without a change). */
export type RunEnding = "waiting" | "lapsed" | "failed" | "silent" | "parked" | "stopped" | "landed" | "running" | "closed";

export type RunStop = {
  ending: RunEnding;
  /** The visit the page opens on: the step that carries the ending. -1 for a run with no visits. */
  at: number;
  /** The head's one line of state: "Failed at Ground after 7s". */
  line: string;
  tone: "person" | "bad" | "warn" | "ok" | "live" | "none";
  /** Why it failed (runReport failCause), for a failed or silent run: its key groups runs of one cause. */
  cause: FailCause | null;
};

/** What the page knows beside the run: who holds the answer, and when its fix merged and reached production. */
export type RunStopFacts = {
  /** The need's holder: the viewer, someone else, or not known. */
  holder?: "you" | "other" | null;
  mergedAt?: number | null;
  liveAt?: number | null;
  /** A parked problem that waits for more findings, and one that asks a person for a fact (a question need). */
  waitsForFindings?: boolean;
  /** The run stopped at a step whose words ask a person for a yes (a `stopped` need, lineNeeds): the ask in its one line
   *  (lineNeeds stoppedAsk), the same words its problem's band says. */
  asksYes?: string | null;
  asksFact?: boolean;
  /** The run ended at its fix decision and nobody answered it (problemPage endedAtDecision): its words are the problem
   *  band's own, "Fix withdrawn Oct 12, unanswered". */
  unanswered?: { withdrawn: boolean; at: number | null } | null;
  now?: number;
};

type Steps = Pick<LineModel, "steps">;

const real = (v: LineVisit) => !v.inferred;
const lastWhere = (vs: ReadonlyArray<LineVisit>, ok: (v: LineVisit) => boolean): number => {
  for (let i = vs.length - 1; i >= 0; i--) if (ok(vs[i])) return i;
  return -1;
};
const lastStep = (vs: ReadonlyArray<LineVisit>): number => { const i = lastWhere(vs, (v) => v.kind !== "end"); return i >= 0 ? i : vs.length - 1; };

/** A duration as a step's time reads: "7s", "4m", "2h 5m". */
export function spanShort(ms: number | null | undefined): string | null {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return null;
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s`;
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  return h % 24 ? `${Math.floor(h / 24)}d ${h % 24}h` : `${Math.floor(h / 24)}d`;
}

/** A close without a change, as the head says it. */
function closedWords(run: Pick<LineRunModel, "visits">, end: string): string {
  const c = closeOutcome(run.visits);
  const said = c && closeSentence(c);
  if (said) return `Closed: ${said.charAt(0).toLowerCase()}${said.slice(1)}`;
  if (c) return `Closed: ${c.word}${c.into ? `, ${c.into}` : ""}`;
  if (end === "dissolved") return "Closed: turned out not to be a problem";
  if (end === "dropped") return "Dropped";
  if (end === "superseded") return "A newer run took over";
  return "Ended with no change";
}

/**
 * How a run ended, the step that carries it and the head's line. `raw` is the run's own row (its failure, its
 * gate); without it a failed run still reads by its first failed visit.
 */
export function runStop(model: Steps, run: LineRunModel, raw: ReportRun | null | undefined, facts: RunStopFacts = {}): RunStop {
  const vs = run.visits;
  const label = (i: number) => (i >= 0 && vs[i] ? model.steps[vs[i].node]?.label ?? vs[i].label : "the run");
  const end = runEndWords(run);
  const out = (ending: RunEnding, at: number, line: string, tone: RunStop["tone"], cause: FailCause | null = null): RunStop => ({ ending, at: vs.length ? Math.max(0, at) : -1, line, tone, cause });
  const day = (at: number | null | undefined) => (at ? shortDay(at) : null);
  // A spend limit refused the step's work: the run stopped for money, as Problems and the band say, not on its work.
  const spendStop = (at: number, cause: FailCause) => out("failed", at, `Stopped by a spend limit at ${label(at)}`, "warn", cause);

  if (end === "running") {
    const at = lastWhere(vs, (v) => v.status === "live");
    const i = at >= 0 ? at : vs.length - 1;
    const stage = vs[i] ? model.steps[vs[i].node]?.stage : null;
    const since = vs[i]?.startedAt ?? vs[i]?.at ?? null;
    const span = since && facts.now ? spanShort(facts.now - since) : null;
    return out("running", i, `${(stage && STAGE_DOING[stage]) || "Running"}${span ? `, ${span}` : ""}`, "live");
  }
  if (facts.unanswered) {
    const i = lastWhere(vs, (v) => v.kind === "person");
    return out("lapsed", i >= 0 ? i : lastStep(vs), unansweredWords(facts.unanswered.withdrawn, facts.unanswered.at), "warn");
  }
  if (raw && stoppedOnPurpose(raw)) {
    const why = (raw.fail_reason ?? "").replace(/^Stopped:\s*/, "").replace(/\.$/, "");
    return out("closed", lastStep(vs), why ? `Stopped: ${why}` : "Stopped", "none");
  }
  // A step finished and the line had no next step for it: nothing failed, a person's yes is what it waits on
  // (lineNeeds stoppedNeedingYes). An older run that stopped this way was answered by the runs after it.
  if (raw && finishedAtDeadEnd(raw)) {
    const node = raw.fail_reason?.trim().match(/^no outgoing edge from (\S+)/)?.[1] ?? null;
    const i = node ? lastWhere(vs, (v) => v.node === node) : -1;
    const at = i >= 0 ? i : lastStep(vs);
    const c = failCause(raw);
    if (c.key.startsWith("budget:")) return spendStop(at, c);
    if (facts.asksYes) return out("stopped", at, facts.asksYes, "person");
    // It said nothing: nothing to say yes to, and starting again is the act.
    if (c.key.startsWith("deadend-silent")) return out("failed", at, `${label(at)} ended without a report`, "bad", c);
    return out("stopped", at, `Stopped at ${label(at)} after it finished`, "none");
  }
  if (end === "waiting") {
    const person = lastWhere(vs, (v) => v.kind === "person" && (v.status === "waiting" || v.status === "live"));
    const i = person >= 0 ? person : lastWhere(vs, (v) => v.kind === "person");
    const at = i >= 0 ? i : lastStep(vs);
    const since = day(vs[at]?.startedAt ?? vs[at]?.at ?? run.updatedAt);
    const who = facts.holder === "you" ? "Waiting on you" : facts.holder === "other" ? "Waiting on someone else" : "Waiting for an answer";
    return out("waiting", at, `${who}${since ? ` since ${since}` : ""}`, "person");
  }
  // A decision nobody answered: the run went on past it and nothing was approved.
  if (end === "not shipped") {
    const i = lastWhere(vs, (v) => v.kind === "person");
    const asked = day(vs[i]?.startedAt ?? vs[i]?.at ?? run.at);
    return out("lapsed", i >= 0 ? i : lastStep(vs), asked ? `Asked ${asked}, no answer` : "Asked, no answer", "warn");
  }
  if (end === "parked") {
    const i = lastWhere(vs, (v) => /(^|_)park($|_)/.test(v.node));
    const at = i >= 0 ? i : lastStep(vs);
    if (facts.waitsForFindings) return out("parked", at, "Waiting for more findings", "none");
    if (facts.asksFact) return out("parked", at, "Needs a fact from you", "person");
    // Parked for a reason that asks nobody anything (already fixed elsewhere, nothing to change): the reason is on the step.
    const on = day(vs[at]?.at ?? run.updatedAt);
    return out("parked", at, on ? `Parked ${on}` : "Parked", "none");
  }
  if (end === "failed" || end === "stuck") {
    const cause = raw ? failCause(raw as Parameters<typeof failCause>[0]) : null;
    const kind = cause?.key.split(":")[0] ?? "";
    // A builder that handed its work off for review: the run waits on that review, whatever the gate said.
    if (kind === "review") {
      const i = cause?.step ? lastWhere(vs, (v) => v.node === cause.step && real(v)) : -1;
      return out("waiting", i >= 0 ? i : lastStep(vs), "Waiting on a review", "person", cause);
    }
    // A check that sent a finished station back: the run failed at the check.
    if (kind === "sentback" || kind === "infra") {
      const i = cause?.step ? lastWhere(vs, (v) => v.node === cause.step && real(v)) : -1;
      const at = i >= 0 ? i : lastStep(vs);
      const said = cause!.label.startsWith(`${label(at)} `) ? cause!.label.slice(label(at).length + 1) : cause!.label;
      return out("failed", at, `Failed at ${label(at)}: ${lowerFirst(said)}`, "bad", cause);
    }
    // A loop opens on the check that kept sending the step back: its output is why the run stopped.
    if (/^looped/.test(kind)) {
      const times = Number(kind.replace("looped", "")) || null;
      const check = cause?.check ? lastWhere(vs, (v) => v.node === cause.check!.step && real(v)) : -1;
      const failedLast = firstFailedVisit(run);
      const trailing = failedLast ? vs.indexOf(failedLast) : -1;
      const capped = cause?.step ? lastWhere(vs, (v) => v.node === cause.step && real(v)) : -1;
      const at = check >= 0 ? check : trailing >= 0 ? trailing : capped >= 0 ? capped : lastStep(vs);
      // "Evals failed 3 times" at Eval reads "Failed at Eval 3 times", "Verify: typecheck red" reads "typecheck red": the
      // step is named once, and "failed" is said once.
      const said = cause?.check ? cause.label.replace(/,\s*[^,]*stopped retrying$/, "") : null;
      const named = said ? new RegExp(`^${label(at).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}s?:?\\s+`, "i").exec(said) : null;
      const why = said ? lowerFirst(named ? said.slice(named[0].length) : said) : null;
      const line = !why ? `Failed at ${label(at)}${times ? ` after ${times} tries` : ""}` : /^failed\b/.test(why) ? `Failed at ${label(at)}${why.slice(6)}` : `Failed at ${label(at)}: ${why}`;
      return out("failed", at, line, "bad", cause);
    }
    if (kind === "budget") {
      const i = cause?.step ? lastWhere(vs, (v) => v.node === cause.step) : -1;
      return spendStop(i >= 0 ? i : lastStep(vs), cause!);
    }
    if (kind === "killed" || cause?.satEmpty || /^runner-/.test(kind)) {
      const i = cause?.step ? lastWhere(vs, (v) => v.node === cause.step) : -1;
      const at = i >= 0 ? i : lastStep(vs);
      return out("failed", at, `Failed at ${label(at)}: ${lowerFirst(cause!.detail ?? cause!.label)}`, "bad", cause);
    }
    // The step it really failed at (stageTrack firstFailedVisit), never the one that only received nothing after it.
    const failedVisit = firstFailedVisit(run);
    const first = failedVisit ? vs.indexOf(failedVisit) : -1;
    if (first >= 0) {
      const span = spanShort(vs[first].durationMs);
      return out("failed", first, `Failed at ${label(first)}${span ? ` after ${span}` : ""}`, "bad", cause);
    }
    // No step failed and the run is not moving: silent past its threshold.
    const at = lastStep(vs);
    if (end === "stuck") {
      const span = facts.now ? spanShort(facts.now - run.updatedAt) : null;
      return out("silent", at, `No progress${span ? ` for ${span}` : ""} at ${label(at)}`, "warn", cause);
    }
    return out("failed", at, `Failed at ${label(at)}`, "bad", cause);
  }
  // A fix that was built and approved: where it is now, in the three words a fix has (built, merged, in production).
  if (end === "deployed" || end === "merged" || end === "shipped" || end === "reopened" || /, not deployed$/.test(end)) {
    const build = lastWhere(vs, (v) => real(v) && v.kind === "agent" && model.steps[v.node]?.stage === "build");
    const at = build >= 0 ? build : lastStep(vs);
    const merged = day(facts.mergedAt);
    const live = day(facts.liveAt);
    if (end === "deployed" || (end === "reopened" && live)) return out("landed", at, live ? `In production ${live}` : "In production", "ok");
    if (/, not deployed$/.test(end)) return out("landed", at, `${merged ? `Merged ${merged}` : end.startsWith("merged") ? "Merged" : "Approved"}, not in production`, "warn");
    if (end === "merged") return out("landed", at, merged ? `Merged ${merged}` : "Merged", "ok");
    return out("landed", at, merged ? `Merged ${merged}` : "Approved, not merged", "ok");
  }
  return out("closed", lastStep(vs), closedWords(run, end), "none");
}

const lowerFirst = (t: string) => (/^[A-Z][a-z]/.test(t) ? t[0].toLowerCase() + t.slice(1) : t);

/** A run's number among its problem's runs, oldest first: "Run 3" of 3. */
export function runNumber(runs: ReadonlyArray<Pick<LineRunModel, "id" | "at" | "caseId">>, run: Pick<LineRunModel, "id" | "caseId">): { n: number; of: number; prev: string | null; next: string | null } {
  const own = run.caseId ? runs.filter((r) => r.caseId === run.caseId).sort((a, b) => a.at - b.at) : [];
  const i = own.findIndex((r) => r.id === run.id);
  if (i < 0) return { n: 1, of: 1, prev: null, next: null };
  return { n: i + 1, of: own.length, prev: own[i - 1]?.id ?? null, next: own[i + 1]?.id ?? null };
}

/** A trace row's state as one of five marks, so the list reads by shape before words. */
export type StepMark = "done" | "failed" | "waiting" | "live" | "skipped";

/** `t` is the visit's trace step: one nobody answered, or a landing step that never ran because its decision was taken back, is no failure. */
export function stepMark(v: Pick<LineVisit, "status" | "inferred" | "kind" | "decided">, t?: Pick<TraceStep, "unanswered" | "notRun">): StepMark {
  if (v.inferred) return "skipped";
  if (t?.unanswered || t?.notRun) return "skipped";
  if (v.status === "failed" || /^fail/.test(v.decided.outcome ?? "")) return "failed";
  if (v.status === "waiting") return "waiting";
  if (v.status === "live") return v.kind === "person" ? "waiting" : "live";
  return "done";
}
