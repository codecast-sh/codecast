// The Line page's Steps table (line-journeys.md LJ8.5): one row per step in
// the line's own order, grouped by phase (Understand, Prove, Build, Check,
// Decide, Ship), each with the counts its own page opens on (stepWork counts,
// so a number clicked is the number of rows the step page lists under it),
// what waits split into "on you" (the viewer's own needs), "someone else" (a
// decision another person holds) and "running", and the top cause of its
// failures in plain words. A person's step never fails: its unanswered
// decisions are "No answer", counted apart from what is red.
// Also the run facts every step page reads: why each run that failed at a step
// failed, and which of them only stopped needing a person's yes. Pure.
import { LINE_PHASES, PHASE_ORDER } from "@codecast/shared/contracts/linePhases";
import { failCause } from "./runReport";
import { stoppedNeedingYes } from "./lineNeeds";
import { stepWork, withoutMachinePaths, type ReviewWait, type RunEnd, type StepShow, type StepWorkInput, type WorkCause, type WorkRow } from "./stepWork";
import type { LineModel, StepKind } from "./lineModel";
import type { LinePhaseKey } from "@codecast/shared/contracts/linePhases";

export type StepRunFacts = { causes: Map<string, WorkCause>; stopped: Set<string>; /** Runs that hit their time limit here: when, where, and whether the session ever ran a turn. */ ends: Map<string, RunEnd>;
  /** Runs whose station here handed its work off for review: a wait on a person, never a failure. */
  review: Map<string, ReviewWait>;
  /** Runs that stopped here only because a later check sent this station back: the failure is filed at that check. */
  cleared: Set<string> };
type FactRun = Parameters<typeof failCause>[0] & { _id: string; status: string; runner_device?: string | null; updated_at?: number };

const blank = (): StepRunFacts => ({ causes: new Map(), stopped: new Set(), ends: new Map(), review: new Map(), cleared: new Set() });
const NO_FACTS: StepRunFacts = blank();

/** Per step: why each run that failed there failed, and the runs that stopped there needing a yes (a need, never a failure). */
export function runFactsByStep(runs: ReadonlyArray<FactRun>): Map<string, StepRunFacts> {
  const out = new Map<string, StepRunFacts>();
  for (const r of runs) {
    if (r.status !== "failed") continue;
    const c = failCause(r);
    if (!c.step) continue;
    const at = (step: string) => out.get(step) ?? out.set(step, blank()).get(step)!;
    const f = at(c.step);
    // A check that sent a finished station round failed the run: the station's own visit is cleared.
    const sentFrom = c.key.startsWith("sentback:") ? r.fail_reason?.match(/exceeded on (\S+)/)?.[1] : null;
    if (sentFrom) at(sentFrom).cleared.add(r._id);
    if (c.review) f.review.set(r._id, c.review);
    else if (stoppedNeedingYes(c)) f.stopped.add(r._id);
    else f.causes.set(r._id, { key: c.key, label: c.label, ...(c.blocked ? { blocked: c.blocked } : {}) });
    if (c.key.startsWith("killed") || c.satEmpty) {
      const node = r.node_statuses?.find((n) => n.node_id === c.step);
      const at = node?.completed_at ?? r.updated_at;
      if (at) f.ends.set(r._id, { at, device: r.runner_device ?? null, empty: !!c.satEmpty });
    }
  }
  return out;
}

export const factsFor = (facts: ReadonlyMap<string, StepRunFacts>, stepId: string | null): StepRunFacts => (stepId ? facts.get(stepId) ?? NO_FACTS : NO_FACTS);

export type StepTableRow = {
  id: string;
  label: string;
  kind: StepKind;
  /** The phase of the line it sits in ("Prove", "Build"), and its key. */
  phase: string;
  stage: LinePhaseKey | null;
  counts: Record<StepShow, number>;
  /** Of `counts.waiting`: what waits on the viewer (their own needs), what waits on someone else (a decision another
   *  person holds), and what is only running. */
  onYou: number;
  others: number;
  running: number;
  /** Its most common reason for failing, when it failed; `thin` when that reason is only that nothing was kept. */
  topCause: string | null;
  topThin?: boolean;
};

/** What the viewer is asked for, by run and by problem (lineNeeds lists only the viewer's): the one source that says a
 *  wait is theirs, the same one For you and the Problems page's Waiting on you read. */
export type ViewerNeeds = ReadonlyArray<{ runId: string | null; caseId: string | null }>;

/** Whose move a waiting row is: the viewer's when one of their needs names its run or its problem; someone else's when
 *  it waits on a person and none does; otherwise it is only running. */
export function waitOwner(r: Pick<WorkRow, "state" | "d">, kind: StepKind, needs: ViewerNeeds): "you" | "others" | "running" {
  const onPerson = r.state === "stopped" || r.state === "review" || (kind === "person" && r.state === "waiting");
  if (!onPerson) return "running";
  return needs.some((n) => (!!n.runId && n.runId === r.d.runId) || (!!n.caseId && n.caseId === r.d.caseId)) ? "you" : "others";
}

/** A cause as a table cell reads it: its first line, without the machine's paths (the step page shows it whole). */
const causeLine = (label: string | undefined): string | null => (label ? withoutMachinePaths(label.split("\n")[0]) || null : null);

const PHASE_LABEL = new Map(LINE_PHASES.map((p) => [p.key, p.label]));

/** Every step work has reached (one nothing reached is a row of dashes with no job). In the line's
 *  order: by phase, then by the step's place in the graph. */
export function stepTable(model: Pick<LineModel, "steps" | "order">, facts: ReadonlyMap<string, StepRunFacts>, closed?: ReadonlySet<string>, needs: ViewerNeeds = [], newest?: ReadonlyMap<string, string>, standing?: StepWorkInput["standing"]): StepTableRow[] {
  const at = new Map(model.order.map((id, i) => [id, i]));
  const rows: StepTableRow[] = [];
  for (const step of Object.values(model.steps)) {
    if (step.kind === "end") continue;
    const work = stepWork(step, { ...factsFor(facts, step.id), closed, newest, standing });
    // A step nothing has reached is not work: its row would be dashes with no job.
    if (!(work.counts.waiting + work.counts.failed + work.counts.passed)) continue;
    const own = { you: 0, others: 0, running: 0 };
    for (const r of work.waiting) own[waitOwner(r, step.kind, needs)]++;
    const stage = step.stage ?? null;
    const top = step.kind === "person" ? undefined : work.failed[0];
    rows.push({ id: step.id, label: step.label, kind: step.kind, phase: PHASE_LABEL.get(step.stage) ?? "", stage, counts: work.counts, onYou: own.you, others: own.others, running: own.running, topCause: causeLine(top?.label), ...(top?.thin ? { topThin: true } : {}) });
  }
  const phaseAt = (r: StepTableRow) => { const i = r.stage ? PHASE_ORDER.indexOf(r.stage) : -1; return i < 0 ? PHASE_ORDER.length : i; };
  const pos = (id: string) => at.get(id) ?? Number.MAX_SAFE_INTEGER;
  return rows.sort((a, b) => phaseAt(a) - phaseAt(b) || pos(a.id) - pos(b.id));
}

/** Each step's failures as the table counts them, for the Map to draw the same number (a person's step has none). */
export function stepFailures(rows: ReadonlyArray<StepTableRow>): Map<string, number> {
  return new Map(rows.map((r) => [r.id, r.kind === "person" ? 0 : r.counts.failed]));
}

/** Each step's waits as the table splits them, for the Map's badge to draw the same numbers: on the viewer, on someone else. */
export type StepWait = { onYou: number; others: number };
export function stepWaits(rows: ReadonlyArray<StepTableRow>): Map<string, StepWait> {
  return new Map(rows.filter((r) => r.onYou + r.others > 0).map((r) => [r.id, { onYou: r.onYou, others: r.others }]));
}

/** The figures over the table, each the sum of the column it names: what waits on you, on someone else, what is
 *  running, what failed (red), and the decisions nobody answered (never red: no step went wrong). */
export function stepTableFigures(rows: ReadonlyArray<StepTableRow>): { onYou: number; others: number; running: number; failed: number; noAnswer: number } {
  const f = { onYou: 0, others: 0, running: 0, failed: 0, noAnswer: 0 };
  for (const r of rows) {
    f.onYou += r.onYou;
    f.others += r.others;
    f.running += r.running;
    if (r.kind === "person") f.noAnswer += r.counts.failed;
    else f.failed += r.counts.failed;
  }
  return f;
}
