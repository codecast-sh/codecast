export const SUSPEND_GAP_MIN_MS = 30_000;
export function clocksDisagree(wallMs: number, monoMs: number, minGapMs: number): boolean {
  return wallMs - monoMs >= minGapMs;
}
export function sawSuspend(wallMs: number, monoMs: number): boolean {
  return clocksDisagree(wallMs, monoMs, SUSPEND_GAP_MIN_MS);
}
