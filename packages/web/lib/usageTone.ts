// Status tone for a utilization percent: green while there's headroom, orange
// as the window nears its limit, red once it has pegged and sessions on it are
// blocked. Values are shown alongside — color never carries alone. Lives
// outside the meter component so importers don't make that module a mixed
// export (component + helper), which React Fast Refresh cannot hot-swap.
export function usageTone(pct: number): string {
  if (pct >= 100) return "var(--sol-red)";
  if (pct >= 80) return "var(--sol-orange)";
  return "var(--sol-green)";
}
