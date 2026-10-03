// How the Evals pages write a time and a batch, in one place, so one batch
// reads the same on every page. Pure: the bisect model and the views share it.

const WHEN: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" };
/** One clock for every page: a time in the viewer's local zone, "Oct 2, 07:23 PM". */
export const whenLabel = (at: string | number) => new Date(at).toLocaleString(undefined, WHEN);

const ISO_BATCH_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
/**
 * A batch as every page names it, so one batch reads the same on the wall,
 * the drawer, the bisect pages and a run: when it began, in local time. A
 * batch whose name is not a time (a named or bisect batch) keeps its name.
 */
export function batchLabel(batch: string, batchAt?: string | null): string {
  if (!ISO_BATCH_RE.test(batch) || Number.isNaN(Date.parse(batch))) return batch;
  return whenLabel(batchAt && !Number.isNaN(Date.parse(batchAt)) ? batchAt : batch);
}
