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
import { LANDING_STATIONS, failCause } from "./runReport";
import { stoppedNeedingYes } from "./lineNeeds";
import { stepWork, withoutMachinePaths, type NeedPlace, type ReviewWait, type RunEnd, type StepShow, type StepWorkInput, type WorkCause, type WorkRow } from "./stepWork";
import type { LineModel, LineRunModel, StepKind } from "./lineModel";
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
  /** Of `onYou`: problems a run found main already fixes, waiting only on a close (never a go-on). */
  toClose: number;
  others: number;
  running: number;
  /** Its most common reason for failing, when it failed; `thin` when that reason is only that nothing was kept. */
  topCause: string | null;
  topThin?: boolean;
};

/** What the viewer is asked for, by run and by problem (lineNeeds lists only the viewer's): the one source that says a
 *  wait is theirs, the same one For you and the Problems page's Waiting on you read. */
export type ViewerNeeds = ReadonlyArray<PlaceableNeed & { caseId: string | null }>;

/** Whose move a waiting row is: the viewer's when one of their needs names its run or its problem; someone else's when
 *  it waits on a person and none does; otherwise it is only running. */
export function waitOwner(r: Pick<WorkRow, "state" | "d"> & Partial<Pick<WorkRow, "ask">>, kind: StepKind, needs: ViewerNeeds): "you" | "others" | "running" {
  // A row placed from For you (needSteps) is the viewer's wait by construction.
  if (r.ask) return "you";
  const onPerson = r.state === "stopped" || r.state === "review" || r.state === "unlanded" || (kind === "person" && r.state === "waiting");
  if (!onPerson) return "running";
  // A need names its run when it has one: an older run of the same problem waits on nobody, so it is never counted twice.
  return needs.some((n) => (n.runId ? n.runId === r.d.runId : !!n.caseId && n.caseId === r.d.caseId)) ? "you" : "others";
}

/** A For you item as a step reads it: the run it waits on, its kind, and for a finished or handed-off step, that step. */
export type PlaceableNeed = { runId: string | null; kind?: string; counted?: boolean; fail?: { step?: string | null } | null };

/** Where each For you item waits on the line drawn: the one step that holds it, by its run. A finished step's yes and a
 *  build handed off for review wait at the step that stopped; an approved fix nothing merged at the ship (or merge) step
 *  that left it; a decision at its person's step; anything else at its run's last step. `elsewhere`: the counted items with no
 *  run on this line (asked before a run, or on another line), which the Steps table names apart. */
export function needSteps<N extends PlaceableNeed>(needs: ReadonlyArray<N>, runs: ReadonlyArray<Pick<LineRunModel, "id" | "visits">>): { at: Map<string, NeedPlace>; elsewhere: N[] } {
  const byId = new Map(runs.map((r) => [r.id, r]));
  const at = new Map<string, NeedPlace>();
  const elsewhere: N[] = [];
  for (const n of needs) {
    if (!n.counted) continue;
    const visits = (n.runId ? byId.get(n.runId)?.visits ?? [] : []).filter((v) => !v.inferred && v.node !== "start" && v.node !== "exit");
    const last = (ok: (v: (typeof visits)[number]) => boolean = () => true) => [...visits].reverse().find(ok)?.node;
    const own = n.fail?.step && (n.kind === "stopped" || n.kind === "review") && visits.some((v) => v.node === n.fail!.step) ? n.fail.step : undefined;
    const step = own ?? (n.kind === "unlanded" ? last((v) => v.node === "ship" || v.node === "merge") ?? last((v) => LANDING_STATIONS.has(v.node)) : n.kind === "decision" ? last((v) => v.kind === "person") : undefined) ?? last();
    if (!n.runId || !step || at.has(n.runId)) { if (!n.runId || !step) elsewhere.push(n); continue; }
    at.set(n.runId, { step, kind: n.kind ?? "" });
  }
  return { at, elsewhere };
}

/** A cause as a table cell reads it: its first line, without the machine's paths (the step page shows it whole). */
const causeLine = (label: string | undefined): string | null => (label ? withoutMachinePaths(label.split("\n")[0]) || null : null);

const PHASE_LABEL = new Map(LINE_PHASES.map((p) => [p.key, p.label]));

/** Every step work has reached (one nothing reached is a row of dashes with no job). In the line's
 *  order: by phase, then by the step's place in the graph. */
/** Where For you's items wait, as counts: at each step of this line, before any run (a question, is this real, assigned),
 *  and on each other line. The three add up to For you's count, so every place that splits it says the same. */
export type NeedSpread = { byStep: Map<string, number>; before: number; lines: Map<string, number> };
export function needSpread(needs: ReadonlyArray<PlaceableNeed & { process?: string | null }>, runs: ReadonlyArray<Pick<LineRunModel, "id" | "visits">>, graphKey: string | null): NeedSpread {
  const { at, elsewhere } = needSteps(needs, runs);
  const byStep = new Map<string, number>();
  for (const p of at.values()) byStep.set(p.step, (byStep.get(p.step) ?? 0) + 1);
  const lines = new Map<string, number>();
  let before = 0;
  for (const n of elsewhere) {
    if (n.process && n.process !== graphKey) lines.set(n.process, (lines.get(n.process) ?? 0) + 1);
    else before++;
  }
  return { byStep, before, lines };
}

export function stepTable(model: Pick<LineModel, "steps" | "order"> & Partial<Pick<LineModel, "runs">>, facts: ReadonlyMap<string, StepRunFacts>, closed?: ReadonlySet<string>, needs: ViewerNeeds = [], newest?: ReadonlyMap<string, string>, standing?: StepWorkInput["standing"]): StepTableRow[] {
  const at = new Map(model.order.map((id, i) => [id, i]));
  const rows: StepTableRow[] = [];
  const asks = needSteps(needs, model.runs ?? []).at;
  for (const step of Object.values(model.steps)) {
    if (step.kind === "end") continue;
    const work = stepWork(step, { ...factsFor(facts, step.id), closed, newest, standing, asks });
    // A step nothing has reached is not work: its row would be dashes with no job.
    if (!(work.counts.waiting + work.counts.failed + work.counts.passed)) continue;
    const own = { you: 0, others: 0, running: 0 };
    for (const r of work.waiting) own[waitOwner(r, step.kind, needs)]++;
    const toClose = work.waiting.filter((r) => r.ask?.kind === "fixed").length;
    const stage = step.stage ?? null;
    const top = step.kind === "person" ? undefined : work.failed[0];
    rows.push({ id: step.id, label: step.label, kind: step.kind, phase: PHASE_LABEL.get(step.stage) ?? "", stage, counts: work.counts, onYou: own.you, toClose, others: own.others, running: own.running, topCause: causeLine(top?.label), ...(top?.thin ? { topThin: true } : {}) });
  }
  const phaseAt = (r: StepTableRow) => { const i = r.stage ? PHASE_ORDER.indexOf(r.stage) : -1; return i < 0 ? PHASE_ORDER.length : i; };
  const pos = (id: string) => at.get(id) ?? Number.MAX_SAFE_INTEGER;
  return rows.sort((a, b) => phaseAt(a) - phaseAt(b) || pos(a.id) - pos(b.id));
}

/** Each step's failures as the table counts them, for the Map to draw the same number (a person's step has none). */
export function stepFailures(rows: ReadonlyArray<StepTableRow>): Map<string, number> {
  return new Map(rows.map((r) => [r.id, r.kind === "person" ? 0 : r.counts.failed]));
}

/** Each step's passes as the table counts them (problems, never visits), for the Map's count under a node. */
export function stepPassed(rows: ReadonlyArray<StepTableRow>): Map<string, number> {
  return new Map(rows.map((r) => [r.id, r.counts.passed]));
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
