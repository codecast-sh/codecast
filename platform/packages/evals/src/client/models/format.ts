// How the Evals pages write a time and a batch, in one place, so one batch
// reads the same on every page. Pure and free of imports: the models and the
// views share it, in whichever app they render.

const WHEN: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" };
/** One clock for every page: a time in the viewer's local zone, "Oct 2, 07:23 PM". */
export const whenLabel = (at: string | number) => new Date(at).toLocaleString(undefined, WHEN);

/** One day as every page names it, "Oct 2", in the viewer's local zone. */
export const dayLabel = (at: string | number) => new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });

const ISO_BATCH_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
/** A machine id no person reads (a product whose batch is its run's UUID). */
const OPAQUE_BATCH_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const validTime = (at: string | null | undefined): at is string => !!at && !Number.isNaN(Date.parse(at));
/**
 * A batch as every page names it, so one batch reads the same on the wall,
 * the drawer, the bisect pages and a run: when it began, in local time. A
 * batch named by a time, or by an opaque id whose start is known, reads as
 * that time. A batch a person named (a named or bisect batch) keeps its name.
 */
export function batchLabel(batch: string, batchAt?: string | null): string {
  if (ISO_BATCH_RE.test(batch) && validTime(batch)) return whenLabel(validTime(batchAt) ? batchAt : batch);
  return OPAQUE_BATCH_RE.test(batch) && validTime(batchAt) ? whenLabel(batchAt) : batch;
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

export const shortSha = (sha: string | null | undefined, n = 8) => (sha ? sha.slice(0, n) : "none");
/**
 * Dollars as codecast's change cards write them (formatUsd in
 * shared/render/changeCardHtml: cents under $10, whole dollars above), with
 * the sub-dime precision a single rep needs. The foundation test holds the
 * two rules together.
 */
export const usd = (v: number) => (v >= 10 ? `$${Math.round(v).toLocaleString("en-US")}` : v >= 0.1 ? `$${v.toFixed(2)}` : v > 0 ? `$${v.toFixed(3)}` : "$0");

/** What a product calls one case its evals replay: codecast's freeze, union's scenario. */
export interface CaseNoun {
  one: string;
  many: string;
}
/** The case of a product that keeps freezes. */
export const FREEZE_NOUN: CaseNoun = { one: "freeze", many: "freezes" };
/** The case of a product that keeps no freeze pages and names its case no other way. */
export const CASE_NOUN: CaseNoun = { one: "case", many: "cases" };
/** "Freezes", for a heading. */
export const capitalized = (s: string) => s.replace(/^./, (c) => c.toUpperCase());

/** A list as a sentence's tail: "a, b or c". */
export const orList = (words: readonly string[]) => (words.length > 1 ? `${words.slice(0, -1).join(", ")} or ${words[words.length - 1]}` : words.join(""));

/** A count with its noun: "1 class", "3 classes". */
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
export const score2 = (v: number | null | undefined) => (v === null || v === undefined ? "n/a" : v.toFixed(2));
/** A model as a person names it: no vendor prefix, no date stamp. */
export const shortModel = (m: string | null | undefined) => (m ? m.replace(/^claude-/, "").replace(/-\d{8}$/, "") : "none");
/** A judge ruler (`<model>#<rubric>`) as its rubric, else the short model. */
export const shortRuler = (r: string | null | undefined) => (r ? (r.includes("#") ? r.slice(r.indexOf("#") + 1) : shortModel(r)) : "none");

/** A p value as every page prints it: two significant figures, and anything under 0.001 as "<0.001". */
export const pLabel = (p: number) => (p < 0.001 ? "<0.001" : String(Number(p.toPrecision(2))));

/**
 * An off-branch head as every chip names it: its main-line twin, or that it
 * has none and, when the commit page read heads.json, why (and the near commit).
 */
export function offBranchWords(t: { sha?: string; mainSha: string | null; twinReason?: string; near?: string }): { label: string; title: string } {
  const twin = t.mainSha && t.mainSha !== t.sha ? t.mainSha : null;
  if (twin) return { label: `off-branch, main ${shortSha(twin)}`, title: `On no branch; main-line commit ${shortSha(twin)} carries the same patch` };
  const near = t.near && !t.twinReason?.includes(t.near.slice(0, 9)) ? ` Nearest on main: ${shortSha(t.near)}.` : "";
  return { label: "off-branch, no main twin", title: `On no branch, and no main-line commit carries its patch${t.twinReason ? `: ${t.twinReason}` : ""}.${near}` };
}
