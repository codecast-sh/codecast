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

/** A batch name as it sits inside free text (a bisect's steps.jsonl line): the full UTC stamp. */
const BATCH_IN_TEXT_RE = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/g;

/** Free text cut into plain runs and the batch names inside it, so a page can print each batch as batchLabel and link it. */
export function splitBatchNames(text: string): Array<string | { batch: string }> {
  const out: Array<string | { batch: string }> = [];
  let at = 0;
  for (const m of text.matchAll(BATCH_IN_TEXT_RE)) {
    if (Number.isNaN(Date.parse(m[0]))) continue;
    if (m.index! > at) out.push(text.slice(at, m.index));
    out.push({ batch: m[0] });
    at = m.index! + m[0].length;
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
}
