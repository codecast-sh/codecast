/** The fragment split into plain and matched runs, in order. */
export function highlightRuns(
  fragment: string,
  indices: [number, number][],
): { text: string; hit: boolean }[] {
  const spans = [...indices]
    .filter(([start, end]) => Number.isFinite(start) && Number.isFinite(end) && end > start)
    .sort((a, b) => a[0] - b[0]);

  const runs: { text: string; hit: boolean }[] = [];
  let at = 0;
  for (const [start, end] of spans) {
    // Overlapping spans would otherwise emit the same characters twice.
    if (start < at) continue;
    if (start > at) runs.push({ text: fragment.slice(at, start), hit: false });
    runs.push({ text: fragment.slice(start, end), hit: true });
    at = end;
  }
  if (at < fragment.length) runs.push({ text: fragment.slice(at), hit: false });
  return runs;
}
