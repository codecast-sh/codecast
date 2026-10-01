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
  /** True only when every proven freeze passes, no gate fails and nothing separates worse; a skipped surface does not count. */
  ok: boolean;
  costUsd: number;
}
