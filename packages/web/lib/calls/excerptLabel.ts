// Seqs are the transcript's own counter, never shown, so an excerpt reads by
// its size and when it was sent.
export function excerptLabel(e: { from_seq: number; to_seq: number }): string {
  const n = e.to_seq - e.from_seq + 1;
  return `Excerpt · ${n} line${n === 1 ? "" : "s"}`;
}
