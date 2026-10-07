import s from "./BuildLine.module.css";

export type BuildLineState = "building" | "live" | "failed";

/** The 2px line along the top of a build card (DESIGN 1, 5): persimmon and
 *  growing while Clay works, full and green once live, frozen where it
 *  stopped when it fails. The parent is the positioned box it runs along. */
export function BuildLine({ progress, state }: { progress: number; state: BuildLineState }) {
  return <span className={`${s.line} ${s[state]}`} style={{ width: `${Math.min(100, Math.max(0, progress))}%` }} aria-hidden />;
}

const EXPECTED_MS = 30_000;

/** Progress against a 30s expectation, easing toward 90% and never reaching
 *  the end until the version is live. */
export function buildProgress(elapsedMs: number): number {
  return 90 * (1 - Math.exp((-1.6 * elapsedMs) / EXPECTED_MS));
}
