// Status tone for a utilization percent: quiet while there's headroom, loud as
// the window pegs. Values are shown alongside — color never carries alone.
// Lives outside the meter component so importers don't make that module a
// mixed export (component + helper), which React Fast Refresh cannot hot-swap.
export function usageTone(pct: number): string {
  if (pct >= 100) return "var(--sol-red)";
  if (pct >= 85) return "var(--sol-orange)";
  if (pct >= 60) return "var(--sol-yellow)";
  return "var(--sol-blue)";
}
