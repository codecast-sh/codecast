// The watch after ship (docs/architecture/the-line-end-to-end.md LE12). A leaf
// module: tasks.ts and signals.ts both read it, and signals.ts imports tasks.ts.

const DAY_MS = 86_400_000;

/** `cast task update --watch-days N`: when the watch ends; 0 ends it now. */
export function watchUntilFor(days: number, now: number): number | undefined {
  if (!Number.isFinite(days) || days < 0) throw new Error("--watch-days takes a number of days, 0 or more");
  return days > 0 ? now + Math.round(days * DAY_MS) : undefined;
}
