// The Line page's Steps table (line-journeys.md LJ8.5): one row per step in
// the line's own order, grouped by phase (Understand, Prove, Build, Check,
// Decide, Ship), each with the counts its own page opens on (stepWork counts,
// so a number clicked is the number of rows the step page lists under it),
// what waits split into "on you" and "running", and the top cause of its
// failures in plain words. A person's step never fails: its unanswered
// decisions are "No answer", counted apart from what is red.
// Also the run facts every step page reads: why each run that failed at a step
// failed, and which of them only stopped needing a person's yes. Pure.
import { LINE_PHASES, PHASE_ORDER } from "@codecast/shared/contracts/linePhases";
import { failCause } from "./runReport";
import { stoppedNeedingYes } from "./lineNeeds";
import { stepWork, withoutMachinePaths, type StepShow, type WorkCause } from "./stepWork";
import type { LineModel, StepKind } from "./lineModel";
import type { LinePhaseKey } from "@codecast/shared/contracts/linePhases";

export type StepRunFacts = { causes: Map<string, WorkCause>; stopped: Set<string> };
type FactRun = Parameters<typeof failCause>[0] & { _id: string; status: string };

const NO_FACTS: StepRunFacts = { causes: new Map(), stopped: new Set() };

/** Per step: why each run that failed there failed, and the runs that stopped there needing a yes (a need, never a failure). */
export function runFactsByStep(runs: ReadonlyArray<FactRun>): Map<string, StepRunFacts> {
  const out = new Map<string, StepRunFacts>();
  for (const r of runs) {
    if (r.status !== "failed") continue;
    const c = failCause(r);
    if (!c.step) continue;
    let f = out.get(c.step);
    if (!f) out.set(c.step, (f = { causes: new Map(), stopped: new Set() }));
    if (stoppedNeedingYes(c)) f.stopped.add(r._id);
    else f.causes.set(r._id, { key: c.key, label: c.label });
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
  /** Of `counts.waiting`: what waits on a person (a decision, a run that stopped needing a yes), and what is only running. */
  onYou: number;
  running: number;
  /** Its most common reason for failing, when it failed. */
  topCause: string | null;
};

/** A cause as a table cell reads it: its first line, without the machine's paths (the step page shows it whole). */
const causeLine = (label: string | undefined): string | null => (label ? withoutMachinePaths(label.split("\n")[0]) || null : null);

const PHASE_LABEL = new Map(LINE_PHASES.map((p) => [p.key, p.label]));

/** Every step a person can act on: agents and people always, a script only once work has reached it. In the line's
 *  order: by phase, then by the step's place in the graph. */
export function stepTable(model: Pick<LineModel, "steps" | "order">, facts: ReadonlyMap<string, StepRunFacts>): StepTableRow[] {
  const at = new Map(model.order.map((id, i) => [id, i]));
  const rows: StepTableRow[] = [];
  for (const step of Object.values(model.steps)) {
    if (step.kind === "end") continue;
    const work = stepWork(step, factsFor(facts, step.id));
    const total = work.counts.waiting + work.counts.failed + work.counts.passed;
    if (step.kind === "script" && !total) continue;
    const onYou = work.waiting.filter((r) => r.state === "stopped" || (step.kind === "person" && r.state === "waiting")).length;
    const stage = step.stage ?? null;
    rows.push({ id: step.id, label: step.label, kind: step.kind, phase: PHASE_LABEL.get(step.stage) ?? "", stage, counts: work.counts, onYou, running: work.counts.waiting - onYou, topCause: step.kind === "person" ? null : causeLine(work.failed[0]?.label) });
  }
  const phaseAt = (r: StepTableRow) => { const i = r.stage ? PHASE_ORDER.indexOf(r.stage) : -1; return i < 0 ? PHASE_ORDER.length : i; };
  const pos = (id: string) => at.get(id) ?? Number.MAX_SAFE_INTEGER;
  return rows.sort((a, b) => phaseAt(a) - phaseAt(b) || pos(a.id) - pos(b.id));
}

/** The figures over the table, each the sum of the column it names: what waits on you, what is running, what failed
 *  (red), and the decisions nobody answered (never red: no step went wrong). */
export function stepTableFigures(rows: ReadonlyArray<StepTableRow>): { onYou: number; running: number; failed: number; noAnswer: number } {
  const f = { onYou: 0, running: 0, failed: 0, noAnswer: 0 };
  for (const r of rows) {
    f.onYou += r.onYou;
    f.running += r.running;
    if (r.kind === "person") f.noAnswer += r.counts.failed;
    else f.failed += r.counts.failed;
  }
  return f;
}
