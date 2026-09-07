// Pure percentile and histogram math for `cast bench daemon`. No I/O.

export interface LatencySummary {
  n: number;
  p50: number | null;
  p90: number | null;
  p99: number | null;
  max: number | null;
  /** Samples at or above one second: the plan's loop freeze bar. */
  over1s: number;
}

/** Nearest rank percentile over an ascending sorted array; null when empty. */
export function percentile(sortedAsc: number[], q: number): number | null {
  const n = sortedAsc.length;
  if (n === 0) return null;
  const rank = Math.min(n, Math.max(1, Math.ceil(q * n)));
  return sortedAsc[rank - 1];
}

export function summarizeLatency(samples: number[]): LatencySummary {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    n: sorted.length,
    p50: percentile(sorted, 0.5),
    p90: percentile(sorted, 0.9),
    p99: percentile(sorted, 0.99),
    max: sorted.length ? sorted[sorted.length - 1] : null,
    over1s: sorted.filter((v) => v >= 1000).length,
  };
}

export interface HistogramBucket {
  label: string;
  count: number;
  meanMs: number | null;
  maxMs: number | null;
}

/**
 * Buckets values by ascending edges: [<e0, e0..e1, ..., >=eLast]. Every bucket
 * is reported, including empty ones, so two runs line up row for row.
 */
export function histogram(values: number[], edgesMs: number[]): HistogramBucket[] {
  const edges = [...edgesMs].sort((a, b) => a - b);
  const labels: string[] = [];
  for (let i = 0; i <= edges.length; i++) {
    if (i === 0) labels.push(`<${edges[0]}ms`);
    else if (i === edges.length) labels.push(`>=${edges[edges.length - 1]}ms`);
    else labels.push(`${edges[i - 1]}-${edges[i]}ms`);
  }
  const groups: number[][] = labels.map(() => []);
  for (const v of values) {
    let i = 0;
    while (i < edges.length && v >= edges[i]) i++;
    groups[i].push(v);
  }
  return labels.map((label, i) => ({
    label,
    count: groups[i].length,
    meanMs: mean(groups[i]),
    maxMs: groups[i].length ? Math.max(...groups[i]) : null,
  }));
}

export function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return Math.round(values.reduce((a, b) => a + b, 0) / values.length);
}
