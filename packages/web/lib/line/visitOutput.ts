// What one visit of a step produced (line-workspace.md LW3), the one reading
// the step drawer's Decisions rows, the Runs list's At step and a run's step
// list all show: a script's printed JSON as its fields, a step's own words (a
// script's printed line, an agent's finding or last message), a person's
// choice and note, or for an older agent run that recorded nothing but its
// session, that session. Null when it produced nothing a reader could use, so
// a surface shows only the outcome and where the run went. Pure.
import { decisionKey, decisionSaid, sentencesWithin, type LineVisit, type StepDecided, type StepKind } from "./lineModel";
import type { StepState } from "./runReport";
import { jsonDepths } from "../workflowRun";
import { checksSummary, errorsWords, evalScopeWords, isPathValue, scriptChecks, scriptErrors } from "./scriptReport";

export type OutputField = { key: string; value: string };

export type VisitOutput =
  | { kind: "fields"; fields: OutputField[]; more: number }
  | { kind: "text"; text: string; tone?: "bad" | "warn" }
  | { kind: "choice"; choice: string; note: string | null }
  | { kind: "session"; href: string };

export type VisitOutputInput = {
  kind: StepKind;
  status: StepState;
  decided: Pick<StepDecided, "outcome" | "words" | "result"> & { toWords?: string | null };
  /** The step's own prose: its pinned report, or a person's note. */
  reasoning: string | null;
  /** What the runner recorded as its output (result_preview), when the caller has the run row. */
  raw?: string | null;
  /** A person's recorded answer at a gate, when the caller has it. */
  answer?: string | null;
  /** The visit's session, for an agent run that recorded nothing else. */
  sessionHref?: string | null;
  /** The problem's title and ref: a step that only repeats them said nothing. */
  caseTitle?: string | null;
  caseRef?: string | null;
  superseded?: boolean;
};

/** A gate's answer key ("a", "s"): a letter, not words; the visit's choice names it. */
export const isAnswerKey = (outcome: string | null | undefined) => !!outcome && /^[a-z]$/i.test(outcome);

/** Words that say only that the step finished: never shown as what it produced. */
const BARE = /^(done|ok|running|failed|failure|fail|waiting|handed on|open|next|completed?|success|earlier round)\.?$/i;
const FIELDS = 3;
const VALUE_CAP = 60;
const TEXT_CAP = 240;

const cap = (t: string, n: number) => (t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t);
/** Prose a step wrote, kept to whole sentences: a cut inside one ends on half a figure ("turns the check 20/…"). */
const prose = (t: string) => sentencesWithin(t, TEXT_CAP);

/** A JSON object cut off by the record's cap: the scalar fields its head holds whole, at its own level only (a nested
 *  object's "why" is not the result's why). Undefined when none do. */
export function headFields(t: string): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  const at = jsonDepths(t);
  for (const m of t.matchAll(/"([\w-]+)"\s*:\s*("(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?|true|false|null)\s*[,}]/g)) {
    if (m[1] in out || at[m.index!] !== 1) continue;
    try { out[m[1]] = JSON.parse(m[2]); } catch { /* a value the regex misread */ }
  }
  return Object.keys(out).length ? out : undefined;
}

/** A printed JSON object, whole, as its last fenced json block, or the fields a capped one holds; null for anything else. */
export function jsonObject(text: string | null | undefined): Record<string, unknown> | null {
  const t = (text ?? "").trim();
  if (!t) return null;
  const fences = [...t.matchAll(/```json[ \t]*\n([\s\S]*?)\n[ \t]*```/g)];
  const body = t.startsWith("{") ? t : fences[fences.length - 1]?.[1];
  if (!body) return null;
  // A script that prints its JSON on the first line and its log after it reads by that line.
  for (const b of [body, body.split("\n")[0]]) {
    try {
      const v = JSON.parse(b);
      return v && typeof v === "object" && !Array.isArray(v) ? v : null;
    } catch { /* not whole */ }
  }
  return body.startsWith("{") ? headFields(body) ?? null : null;
}

/** A value as a chip shows it: scalars as written, a list by its length; objects are left out. */
function valueWords(v: unknown): string | null {
  if (v == null || v === "") return null;
  if (Array.isArray(v)) return v.length ? `${v.length} ${v.length === 1 ? "item" : "items"}` : null;
  if (typeof v === "object") return null;
  const t = String(v).replace(/\s+/g, " ").trim();
  // A file path reads by its name: the directories say nothing at a glance.
  const path = /^(?:~|\/)[^\s]*\/([^/\s]+)$/.exec(t);
  return cap(path ? path[1] : t, VALUE_CAP) || null;
}

/** A JSON result's scalar fields, in its order, the outcome left out when the row already shows it. */
function fieldsOf(result: Record<string, unknown> | null, outcome: string | null, known: ReadonlyArray<string | null | undefined>): VisitOutput | null {
  if (!result) return null;
  const all: OutputField[] = [];
  for (const [key, v] of Object.entries(result)) {
    if (key === "outcome" && (v === outcome || !outcome)) continue;
    // A path a script prints for the next step says nothing at a glance; an empty errors list says nothing either.
    if (isPathValue(v) || (key === "errors" && Array.isArray(v))) continue;
    if (typeof v === "string" && known.some((k) => k && k.trim() === v.trim())) continue;
    const value = valueWords(v);
    if (value) all.push({ key, value });
  }
  return all.length ? { kind: "fields", fields: all.slice(0, FIELDS), more: Math.max(0, all.length - FIELDS) } : null;
}

/** Fields a script prints to say why, in its own words: one of these is the line a reader needs. */
const WHY_KEYS = ["why", "detail", "reason", "summary", "message", "error", "note"];

/**
 * A script's result as the one field a person reads: its failing checks ("typecheck: exit 1"), else its own why
 * ("the check fails (exit 1)"), else its counts ("5 findings"). Null when it printed none of these, and the caller
 * falls back to its fields.
 */
export function scriptWords(result: Record<string, unknown> | null): string | null {
  return scriptSaid(result)?.text ?? null;
}

/** scriptWords with its tone: red checks or reported errors read bad, even on an exit 0. */
export function scriptSaid(result: Record<string, unknown> | null): { text: string; tone?: "bad" | "warn" } | null {
  if (!result) return null;
  const errors = scriptErrors(result);
  if (errors.length) return { text: errorsWords(errors), tone: "bad" };
  const checks = scriptChecks(result);
  if (checks) {
    const s = checksSummary(checks);
    const red = checks.rows.filter((r) => !r.ok).map((r) => `${r.name.replace(/\s*\(.*$/, "")}${r.detail ? `: ${r.detail}` : ""}`);
    return { text: cap([s.text, ...red].join(" · "), TEXT_CAP), ...(s.bad ? { tone: "bad" as const } : {}) };
  }
  const scope = evalScopeWords(result);
  if (scope) return { text: scope };
  for (const k of WHY_KEYS) {
    const v = result[k];
    if (typeof v === "string" && v.trim()) return { text: prose(v.replace(/\s+/g, " ").trim()) };
  }
  const counts = Object.entries(result).filter(([k, v]) => /_count$/.test(k) && typeof v === "number").map(([k, v]) => `${v} ${k.replace(/_count$/, "").replace(/_/g, " ")}${v === 1 ? "" : "s"}`);
  return counts.length ? { text: counts.join(" · ") } : null;
}

/** The first line of a printed output that is not JSON, without its markdown marks. */
function firstLine(text: string | null | undefined): string | null {
  const t = (text ?? "").replace(/```json[ \t]*\n[\s\S]*?\n[ \t]*```/g, "").trim();
  if (!t || t.startsWith("{") || t.startsWith("[")) return null;
  return t.split("\n").map((l) => l.replace(/^[#>*\-\s]+/, "").trim()).find(Boolean) ?? null;
}

/** Words that say something: not a bare finished word, the problem's title, or the outcome the row already shows. */
function ownWords(text: string | null | undefined, v: VisitOutputInput): string | null {
  const t = (text ?? "").trim();
  if (!t || BARE.test(t)) return null;
  if (v.caseTitle && t === v.caseTitle.trim()) return null;
  const key = decisionKey(v).toLowerCase();
  if (t.toLowerCase() === key || t.toLowerCase() === (v.decided.outcome ?? "").replace(/_/g, " ").toLowerCase()) return null;
  return prose(t);
}

/** What this visit produced, or null when it produced nothing but its outcome. */
export function visitOutput(v: VisitOutputInput): VisitOutput | null {
  if (v.superseded || v.status === "live" || v.status === "waiting") return null;
  const outcome = v.decided.outcome;
  if (v.kind === "person") {
    const choice = (v.answer ?? v.decided.toWords ?? (isAnswerKey(outcome) ? null : outcome?.replace(/_/g, " ")) ?? "").trim();
    const note = v.reasoning?.trim() || null;
    if (!choice || BARE.test(choice)) return note ? { kind: "text", text: prose(note) } : null;
    return { kind: "choice", choice, note: note && note !== choice ? prose(note) : null };
  }
  const result = v.decided.result ?? jsonObject(v.raw);
  const known = [v.caseTitle, v.caseRef];
  const said = ownWords(decisionSaid({ reasoning: v.reasoning, decided: v.decided }), v) ?? ownWords(firstLine(v.raw), v);
  if (v.kind === "agent") {
    if (said) return { kind: "text", text: said };
    const fields = fieldsOf(result, outcome, known);
    if (fields) return fields;
    return v.sessionHref ? { kind: "session", href: v.sessionHref } : null;
  }
  const words = v.kind === "script" ? scriptSaid(result) : null;
  if (words) return { kind: "text", ...words };
  // Its own words (what it printed, or how it ended: "Interrupted before it finished") before the arguments it echoed
  // ("dry: false · freezes: 5"), which say what it was asked to do, never what happened.
  if (said) return { kind: "text", text: said, ...(v.status === "failed" ? { tone: "bad" as const } : {}) };
  return fieldsOf(result, outcome, known);
}

/** A visit's output in one line, for a cell or a hover: "dissolved: judge_defect · moments: 2". Null for a bare session link. */
export function visitOutputWords(o: VisitOutput | null): string | null {
  if (!o) return null;
  if (o.kind === "fields") return [...o.fields.map((f) => `${f.key}: ${f.value}`), ...(o.more ? [`+${o.more}`] : [])].join(" · ");
  if (o.kind === "text") return o.text;
  if (o.kind === "choice") return o.note ? `${o.choice} · ${o.note}` : o.choice;
  return null;
}

/** A step's decision (lineModel StepDecision) as visitOutput reads it. */
export const decisionOutput = (
  kind: StepKind,
  d: { status: StepState; decided: VisitOutputInput["decided"]; reasoning: string | null; caseTitle: string; caseRef?: string | null; received: { href: string | null }; superseded?: boolean },
): VisitOutput | null =>
  visitOutput({ kind, status: d.status, decided: d.decided, reasoning: d.reasoning, sessionHref: d.received.href, caseTitle: d.caseTitle, caseRef: d.caseRef, superseded: d.superseded });

/** A run's visit (lineModel LineVisit) as visitOutput reads it. */
export const lineVisitOutput = (v: Pick<LineVisit, "kind" | "status" | "decided" | "why" | "received" | "inferred">, problem?: { caseTitle?: string | null; caseRef?: string | null }): VisitOutput | null =>
  v.inferred ? null : visitOutput({ kind: v.kind, status: v.status, decided: v.decided, reasoning: v.why, sessionHref: v.received.href, caseTitle: problem?.caseTitle, caseRef: problem?.caseRef });
