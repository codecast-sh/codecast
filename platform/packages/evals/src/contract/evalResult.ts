// What the line's eval station writes (eval-result.json, design LE8): each
// surface a branch touches, replayed on the base and on the branch, with the
// separation verdict, the gates that failed, and the freezes whose verdict
// flipped. The change card (LE10) reads its eval check and its examples here.

export type EvalSeparation = "better" | "worse" | "not-separated" | "too-few";

/** One rep set: every scored rep of a surface in one `check` batch. */
export interface EvalRunSet {
  batch: string;
  reps: number;
  passed: number;
  median: number | null;
  mean: number | null;
  costUsd: number;
}

/** A freeze whose majority verdict differs between base and branch. */
export interface EvalFlip {
  freeze: string;
  name: string;
  direction: "fixed" | "broke";
  /** The moment the surface answered, bounded: what the card shows as the input. */
  input: string;
  before: string;
  after: string;
  /** The judge's reasoning on the branch's reply (or the failed gate). */
  note: string;
}

export interface EvalSurfaceResult {
  surface: string;
  title: string;
  separation: EvalSeparation;
  /** One-sided p for better/worse/not-separated. */
  p: number | null;
  base: EvalRunSet | null;
  branch: EvalRunSet | null;
  /** Gate ids that failed on any branch rep. */
  gatesFailed: string[];
  crashes: number;
  /**
   * Proven freezes (the miss the run showed first), each with its majority
   * verdict on the base (null when the base scored no rep of it) and on the
   * branch. A proven freeze must fail on the base and pass on the branch.
   */
  proven: Array<{ freeze: string; basePasses: boolean | null; passes: boolean }>;
  flips: EvalFlip[];
  ok: boolean;
  /** Why the surface failed the station, one line each. */
  reasons: string[];
  /** Set when the surface had no freeze to replay: nothing ran, and it does not count against ok. */
  skipped?: string;
}

export interface EvalResult {
  version: 1;
  base: { ref: string; sha: string };
  head: { sha: string; dirty: boolean };
  createdAt: string;
  dry: boolean;
  reps: number;
  surfaces: EvalSurfaceResult[];
  /** Suite gates the project's eval ran beside the replays (reps.json gates_failed) that failed. */
  gatesFailed?: string[];
  /** True only when every proven freeze passes, no gate fails and nothing separates worse; a skipped surface does not count. */
  ok: boolean;
  costUsd: number;
}

// ── reps.json (line-profile.md LP4) ──
// What a project's eval command writes: per surface, per freeze, per side
// (base, branch), the reps as they scored, and the suite gates that failed.
// It does no statistics; `cast line eval-result` turns it into the EvalResult
// above with the one separation rule (`separate` in analysis/stats.ts), and
// codecast's own `./evals line` writes it and calls the same builder.

/** One rep. A rep with `error` crashed: it is no verdict either way and counts as a crash. */
export interface EvalRep {
  passed: boolean;
  /** 0..1. Null when the rep has only a verdict: it then scores 1 when passed, else 0. */
  score: number | null;
  reply: string;
  judge_note: string;
  cost_usd: number;
  error?: string;
  /** Gate ids this rep failed, when the eval grades gates per rep. */
  gates_failed?: string[];
}

/** One side's replay of one freeze. */
export interface EvalRepsSide {
  /** The run set the reps were recorded under. */
  batch: string;
  /** The tree the reps ran on. */
  sha: string;
  reps: EvalRep[];
  /** The moment's input as the replay saw it, bounded. */
  input?: string;
}

export interface EvalRepsFreeze {
  freeze: string;
  name: string;
  kind: "miss" | "guard";
  /** A miss prove showed failing on the base: it must fail there and pass on the branch. */
  proven: boolean;
  /** The moment the surface answered (its last input), bounded. */
  input: string;
  base: EvalRepsSide | null;
  branch: EvalRepsSide | null;
}

export interface EvalRepsSurface {
  surface: string;
  title: string;
  route?: string | null;
  freezes: EvalRepsFreeze[];
  /** Set when nothing replayed for the surface, with why. */
  skipped?: string;
  /** Why the base side has no reps, when the eval knows (the base could not load the surface, crashed). */
  base_failure?: string;
}

export interface EvalRepsFile {
  version: 1;
  base: { ref: string; sha: string };
  head: { sha: string; dirty: boolean };
  created_at: string;
  dry: boolean;
  reps: number;
  surfaces: EvalRepsSurface[];
  gates_failed: string[];
  /** The suite gate run, when one ran; its note is shown with a failure. */
  gate?: { select?: string; run_id?: string | null; exit?: number | null; failed?: string[]; note?: string } | null;
  cost_usd: number;
}
