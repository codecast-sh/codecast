// What a script step's printed report says, read one way for the rail, the
// step's RAN panel and the card beside its run (line-workspace.md LW3): a
// check runner's `steps` as a checks table (each check, pass or fail, the
// files it found failing that this change never touched, the one log line
// that matters), a builder's `errors` as the fields it could not fill, and
// the file paths a script prints for the next step left out, since a path
// says nothing at a glance. Pure.

import { checksPassWords } from "@codecast/shared/contracts/changeCard";

export type CheckRow = { name: string; ok: boolean; detail: string | null };
export type ScriptChecks = {
  rows: CheckRow[];
  /** Files with errors this change never touched: a check passed over them. */
  preexisting: string[];
  /** The first log line after the report that names an error. */
  log: string | null;
};

/** A check's name without its parenthesised scope: "prompt fidelity (a, b)" reads "prompt fidelity". */
export const checkName = (name: string) => name.replace(/\s*\(.*$/, "").trim() || name;

const fileName = (p: string) => p.split("/").pop() ?? p;

/** A check runner's report (`{ok, steps: [{name, ok, detail}], preexisting}`) as rows; null when the report holds no checks. */
export function scriptChecks(result: Record<string, unknown> | null | undefined, printed?: string | null): ScriptChecks | null {
  const steps = Array.isArray(result?.steps) ? (result!.steps as Array<{ name?: unknown; ok?: unknown; detail?: unknown }>) : null;
  if (!steps?.length) return null;
  const rows = steps.filter((s) => s && typeof s.name === "string").map((s) => ({ name: s.name as string, ok: s.ok !== false, detail: typeof s.detail === "string" && s.detail.trim() ? s.detail.trim() : null }));
  if (!rows.length) return null;
  const preexisting = Array.isArray(result!.preexisting) ? (result!.preexisting as unknown[]).filter((x): x is string => typeof x === "string").map(fileName) : [];
  const after = (printed ?? "").split("\n").slice(1);
  const log = after.map((l) => l.trim()).find((l) => /\berror\b|✗|\bfail(ed)?\b/i.test(l)) ?? null;
  return { rows, preexisting, log };
}

/** The checks in one glance: "4/4 pass", "3/4 pass, 1 red"; `bad` when any failed. A card's Verify check says the same (checksPassWords). */
export const checksSummary = (c: Pick<ScriptChecks, "rows">): { text: string; bad: boolean } => checksPassWords(c.rows);

/** The errors a script reported while exiting 0 (a card built with fields missing). Empty when it reported none. */
export function scriptErrors(result: Record<string, unknown> | null | undefined): string[] {
  const e = result?.errors;
  return Array.isArray(e) ? e.filter((x): x is string => typeof x === "string" && !!x.trim()) : [];
}

/** "4 missing fields" when every error names an empty or wrong field ("wrong: is empty"), else "2 errors". */
export function errorsWords(errors: readonly string[]): string {
  const n = errors.length;
  const fields = errors.every((e) => /^[\w.[\]-]+:\s/.test(e));
  return fields ? `${n} missing ${n === 1 ? "field" : "fields"}` : `${n} ${n === 1 ? "error" : "errors"}`;
}

/** The field an error names: "recommend.verdict: expected…" names "recommend.verdict". */
export const errorField = (e: string) => /^([\w.[\]-]+):\s*(.*)$/.exec(e);

/** A value that is only a file path (or one cut off by the record's cap): left out of what a step shows. */
export const isPathValue = (v: unknown): boolean => typeof v === "string" && /^(?:~\/|\/)[^\s]*$/.test(v.trim());

/** What an eval scope picked, in words: "4 files, gate evals". Null when the report is not one. */
export function evalScopeWords(result: Record<string, unknown> | null | undefined): string | null {
  if (!result || typeof result.select !== "string" || !Array.isArray(result.paths)) return null;
  const n = result.paths.length;
  const prompts = n > 0 && (result.paths as unknown[]).every((p) => typeof p === "string" && /\.(njk|md|txt|prompt)$/.test(p));
  return `${n} ${prompts ? "prompt " : ""}${n === 1 ? "file" : "files"}, ${result.select} evals`;
}

/** Evals a run owes and never ran: its eval scope selected some, and no eval step ran after it. Null when none are owed. */
export function evalsOwed(visits: ReadonlyArray<{ node: string; inferred?: boolean; result: Record<string, unknown> | null }>): { at: number; select: string; files: number } | null {
  for (let i = 0; i < visits.length; i++) {
    const r = visits[i].result;
    if (!r || r.scoped !== true || typeof r.select !== "string" || !Array.isArray(r.paths)) continue;
    const ran = visits.slice(i + 1).some((v) => /(^|_)evals?($|_)/.test(v.node) && v.node !== visits[i].node);
    if (!ran) return { at: i, select: r.select, files: r.paths.length };
  }
  return null;
}

/** A reviewer's verdict as it recorded it (`cast task verdict`): the verdict and each numbered point with pass or fail and its reason. */
export type ReviewVerdict = { verdict: string; points: Array<{ n: number; ok: boolean; why: string }>; at: number | null };

export function parseReviewVerdict(text: string | null | undefined, verdict?: string | null, at?: number | null): ReviewVerdict | null {
  const t = text ?? "";
  const v = verdict ?? /^\s*Verdict:\s*(\w+)/i.exec(t)?.[1] ?? null;
  const points: ReviewVerdict["points"] = [];
  for (const m of t.matchAll(/^\s*(\d+)\.\s*(PASS|FAIL)\b\s*[—:-]*\s*(.+)$/gim)) {
    points.push({ n: Number(m[1]), ok: m[2].toUpperCase() === "PASS", why: firstSentence(m[3]) });
  }
  if (!v && !points.length) return null;
  return { verdict: (v ?? (points.every((p) => p.ok) ? "approve" : "changes")).toLowerCase(), points, at: at ?? null };
}

/** The verdict in one glance: "approved 4/4", "changes: 1 fail". */
export function reviewWords(r: ReviewVerdict): { text: string; bad: boolean } {
  const fail = r.points.filter((p) => !p.ok).length;
  const n = r.points.length;
  if (r.verdict === "approve") return { text: n ? `approved ${n - fail}/${n}` : "approved", bad: false };
  return { text: `${r.verdict}${fail ? `: ${fail} fail` : ""}`, bad: true };
}

function firstSentence(s: string): string {
  const t = s.trim();
  const m = /^(.+?\.)(\s|$)/.exec(t);
  const one = m ? m[1] : t;
  return one.length > 220 ? `${one.slice(0, 219).trimEnd()}…` : one;
}

/** The task fields a reviewer's verdicts are read from: its review comments, and the verdict it holds now. */
export type ReviewSource = {
  comments?: ReadonlyArray<{ comment_type?: string; conversation_id?: string; text?: string; created_at?: number }> | null;
  review_verdict?: { verdict: string; by_conversation_id?: string; at: number; note?: string } | null;
};

/** Every verdict reviewers recorded on a task, by the session that recorded it. */
export function reviewsOf(task: ReviewSource | null | undefined): Map<string, ReviewVerdict> {
  const out = new Map<string, ReviewVerdict>();
  for (const c of task?.comments ?? []) {
    if (c.comment_type !== "review" || !c.conversation_id) continue;
    const r = parseReviewVerdict(c.text, null, c.created_at ?? null);
    if (r) out.set(c.conversation_id, r);
  }
  const rv = task?.review_verdict;
  if (rv?.by_conversation_id) {
    const r = parseReviewVerdict(rv.note, rv.verdict, rv.at);
    if (r) out.set(rv.by_conversation_id, r);
  }
  return out;
}

const CLOSE_KIND: Record<string, string> = {
  already_fixed: "fixed on main", fixed: "fixed on main", judge_defect: "judge defect", historical: "historical",
  known_cause: "known cause", in_flight: "fix in flight", duplicate: "duplicate", not_reproducible: "not reproducible",
};

/** How a run closed its problem without a change, as its status word (one word per outcome on every row) and what it
 *  points at: "duplicate" ct-59229, "already fixed" 0284f66, "judge wrong", "in flight elsewhere" ct-57467. Null when no visit said. */
const CLOSE_OUTCOME: Record<string, string> = {
  already_fixed: "already fixed", fixed: "already fixed", judge_defect: "judge wrong", historical: "historical",
  known_cause: "duplicate", duplicate: "duplicate", in_flight: "in flight elsewhere", not_reproducible: "not reproducible",
};
/** A close's outcome key as its status word ("judge_defect" reads "judge wrong"), one word per outcome on every row. */
export const closeOutcomeWord = (key: string): string => CLOSE_OUTCOME[key.trim().replace(/\s+/g, "_")] ?? key.replace(/_/g, " ");

export function closeOutcome(visits: ReadonlyArray<{ inferred?: boolean; decided: { result: Record<string, unknown> | null } }>): { word: string; into: string | null } | null {
  for (let i = visits.length - 1; i >= 0; i--) {
    const r = visits[i].inferred ? null : visits[i].decided.result;
    const kind = typeof r?.kind === "string" ? r.kind.trim() : "";
    if (kind) return closeOf(kind, typeof r?.into === "string" ? r.into : null);
  }
  return null;
}

/** One close's report (its `kind` and `into`) as closeOutcome reads it: its status word and what it points at. */
export function closeOf(kind: string, rawInto: string | null | undefined): { word: string; into: string | null } {
  const into = rawInto?.trim().split(/\s/)[0] ?? "";
  // A cause named only in the product's words ("C1") is a known cause, not a problem to open.
  const word = kind === "known_cause" && into && !/^ct-\d+$/.test(into) ? "known cause" : CLOSE_OUTCOME[kind] ?? kind.replace(/_/g, " ");
  return { word, into: !into || /^judge:/.test(into) ? null : /^[0-9a-f]{7,40}$/.test(into) ? into.slice(0, 7) : into };
}

/** A close without a change as a person says it, one sentence per outcome on every surface: "Already being fixed in
 *  ct-57467", "The same problem as ct-59229", "Already fixed by 0284f66", "The judge was wrong". Null for an outcome
 *  with no sentence of its own. */
export function closeSentence(c: { word: string; into: string | null }): string | null {
  switch (c.word) {
    case "in flight elsewhere": return c.into ? `Already being fixed in ${c.into}` : "Already being fixed elsewhere";
    case "already fixed": return c.into ? `Already fixed by ${c.into}` : "Already fixed";
    case "duplicate": return c.into ? `The same problem as ${c.into}` : "A duplicate";
    case "judge wrong": return "The judge was wrong";
    default: return null;
  }
}

/** How a run closed its problem without a change, as a short chip: "fixed on main 4a97f88", "dup ct-57467", "judge defect".
 *  Read off the newest visit whose report names a kind (a dissolve's `kind` and `into`). Null when no visit said. */
export function closeChip(visits: ReadonlyArray<{ inferred?: boolean; decided: { result: Record<string, unknown> | null } }>): string | null {
  for (let i = visits.length - 1; i >= 0; i--) {
    const r = visits[i].inferred ? null : visits[i].decided.result;
    const kind = typeof r?.kind === "string" ? r.kind.trim() : "";
    if (!kind) continue;
    const into = typeof r?.into === "string" ? r.into.trim().split(/\s/)[0] : "";
    const words = CLOSE_KIND[kind] ?? kind.replace(/_/g, " ");
    if (!into || /^judge:/.test(into)) return words;
    if (/^ct-\d+$/.test(into)) return kind === "known_cause" || kind === "duplicate" || kind === "in_flight" ? `${kind === "in_flight" ? "in flight" : "dup"} ${into}` : `${words} ${into}`;
    return /^[0-9a-f]{7,40}$/.test(into) ? `${words} ${into.slice(0, 7)}` : `${words} ${into}`;
  }
  return null;
}
