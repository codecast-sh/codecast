// Part of the Evals UI's wire contract (docs/architecture/evals-ui.md). Every
// party imports it through ../evalsApi.ts. The multiplayer sim's history and
// artifacts (section 3.7). PURE isomorphic data: no Node or DOM APIs.

// ── Multiplayer sim (section 3.7) ───────────────────────────────────────────

/** report.ts SimMode. */
export type SimMode = "scripted" | "interleave" | "order";

/** A red marker: the run is expected to fail on this invariant (scenario `red`). */
export interface SimMarker {
  task: string;
  invariant: string;
  modes: string[] | null;
  seeds: number[] | null;
}

/** One row of `bun run sim --list --json`. */
export interface SimScenario {
  name: string;
  /** Relative to the sim dir: `scenarios/x.scenario.ts` or `selftests/x.selftest.ts`. */
  file: string;
  selftest: boolean;
  modes: string[];
  red: SimMarker[];
  /** Invariant ids known to fail, each with its tasks (scenario `known`). */
  known: Array<{ invariant: string; tasks: string[] }>;
}

/** One row of `bun run sim --invariants --json`. */
export interface SimInvariant {
  id: string;
  meaning: string;
  /** The store keys it compares, when the static read finds them. */
  keys: string[];
}

/** <session>/session.json. */
export interface SimSession {
  /** The folder name, a stamp. */
  id: string;
  argv: string[];
  gitHead: string | null;
  dirty: boolean;
  treePatch: string | null;
  startedAt: string;
  finishedAt: string | null;
  exit: number | null;
  /** A legacy $TMPDIR/codecast-sim folder with no session: shown read-only. */
  unsessioned?: boolean;
}

/** One line of <session>/runs.jsonl. */
export interface SimRunRow {
  scenario: string;
  mode: SimMode;
  seed: number;
  passed: boolean;
  deliveries: number;
  ms: number;
  /** The artifact folder inside the session, `<scenario>-<mode>-<seed>`, when one was written. */
  dir?: string;
}

/** A session in the history list. */
export interface SimSessionSummary extends SimSession {
  runs: number;
  failed: number;
  scenarios: number;
  /** Its failing rows of runs.jsonl, in run order: each opens as /evals/sim/<session>/<dir> when it left an artifact folder. */
  failing: Array<Pick<SimRunRow, "scenario" | "mode" | "seed" | "dir">>;
}

/** A row of events.jsonl: a delivery (rows written before step markers carry no kind) or a step marker from dsl.ts. */
export type SimEvent =
  | { kind?: "delivery"; seq: number; channel: string; due: number; label: string; producer: string }
  | { kind: "step"; seq: number; verb: string; actor: string; label: string };

/** world.json. */
export interface SimWorld {
  scenario: string;
  mode: SimMode;
  seed: number;
  labels: Record<string, string>;
  devices: Array<{ name: string; windows: Array<{ name: string; role: "host" | "follower"; closed: boolean }> }>;
}

/** final.json. */
export interface SimFinal {
  deliveries: number;
  writesSpent: number;
  producers: Record<string, number>;
  calls: Array<{ seq: number; name: string; kind: string; ok: boolean; error?: string }>;
  actors: Array<{ actor: string; verb: string; ok: boolean; error?: string }>;
  windowErrors: Record<string, string[]>;
}

/** Fields every result.json carries since the session history landed. */
interface SimResultCommon {
  scenario: string;
  mode: SimMode;
  seed: number;
  gitHead?: string | null;
  dirty?: boolean;
  startedAt?: string;
  realMs?: number;
}

/** result.json of a failing run (report.ts reportFailure). */
export interface SimFailureResult extends SimResultCommon {
  passed?: false;
  step: string;
  delivery: number;
  invariant: { id: string; meaning: string };
  message?: string;
  window?: { name: string; principal: string; scope: string };
  /** The row the check names, with the rendered field diff (no raw rows). */
  row?: { table: string; id: string; label: string; diff: Array<{ field: string; server: string; replica: string }> };
  /** The recorded delivery order, as `--order` takes it. */
  order: string;
  labels: Record<string, string>;
  t0?: number;
  replay?: string[];
  /** The task of the red or known marker that expected this failure. */
  expected?: string;
  /** The block printed to the terminal. */
  text: string;
  /** Set once a shrink has run: the minimal order, as `--order` takes it. */
  minimalOrder?: string;
}

/** result.json of a passing run written with --keep or SIM_OUT. */
export interface SimPassResult extends SimResultCommon {
  passed: true;
  deliveries: number;
}

export type SimResult = SimFailureResult | SimPassResult;

/** minimal.json, written by `bun run sim --shrink`. */
export interface SimMinimal {
  /** The channels of the smallest order that still fails the same way. */
  order: string[];
  /** Indexes into the recorded order that the shrink removed. */
  removed: number[];
  attempts: number;
  ms: number;
  /** ddmin finished: no single entry can be removed. False when a cap stopped it. */
  oneMinimal: boolean;
}

/** minimal.json.tmp while a shrink runs. */
export interface SimShrinkProgress {
  phase: "prefix" | "ddmin";
  attempts: number;
  /** The shortest failing order found so far. */
  best: number;
  recorded: number;
}

/** A spawned shrink or sweep, reported through /changes. */
export interface SimJob {
  id: string;
  kind: "shrink" | "sweep";
  status: "running" | "done" | "failed" | "stopped";
  startedAt: string;
  updatedAt: string;
  tmux: string | null;
  progress: { done: number; total: number | null; text: string };
  session: string | null;
  run: string | null;
  /** The last lines the job printed (its log, ANSI stripped), once it has ended: why a failed shrink or sweep stopped. */
  logTail?: string[];
}

/** One cell of the catalog grid: a scenario in one mode. */
export interface SimGridCell {
  scenario: string;
  mode: SimMode;
  latest: { session: string; run: string | null; seed: number; passed: boolean; at: string } | null;
  /** Per session, oldest first: seeds run and seeds failed. */
  history: Array<{ session: string; seeds: number; failed: number }>;
  gitHead: string | null;
  lastRunAt: string | null;
  /**
   * The newest run of this cell that failed and left an artifact folder, with
   * the invariant it broke (its result.json): what a click on the cell opens,
   * even when the latest session passed, and what the invariant filter reads.
   * null when the history holds no failing run with artifacts. The api child's
   * `simGrid` fills it.
   */
  newestFailure: { session: string; run: string; seed: number; invariant: string; at: string } | null;
}
