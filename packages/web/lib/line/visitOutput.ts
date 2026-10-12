// What one visit of a step produced (line-workspace.md LW3), the one reading
// the step drawer's Decisions rows, the Runs list's At step and a run's step
// list all show: a script's printed JSON as its fields, a step's own words (a
// script's printed line, an agent's finding or last message), a person's
// choice and note, or for an older agent run that recorded nothing but its
// session, that session. Null when it produced nothing a reader could use, so
// a surface shows only the outcome and where the run went. Pure.
import { decisionKey, decisionSaid, type LineVisit, type StepDecided, type StepKind } from "./lineModel";
import type { StepState } from "./runReport";

export type OutputField = { key: string; value: string };

export type VisitOutput =
  | { kind: "fields"; fields: OutputField[]; more: number }
  | { kind: "text"; text: string }
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

/** Words that say only that the step finished: never shown as what it produced. */
const BARE = /^(done|ok|running|failed|failure|fail|waiting|handed on|open|next|completed?|success|earlier round)\.?$/i;
const FIELDS = 3;
const VALUE_CAP = 60;
const TEXT_CAP = 240;

const cap = (t: string, n: number) => (t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t);

/** A JSON object cut off by the record's cap: the scalar fields its head holds whole. Undefined when none do. */
export function headFields(t: string): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  for (const m of t.matchAll(/"([\w-]+)"\s*:\s*("(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?|true|false|null)\s*[,}]/g)) {
    if (m[1] in out) continue;
    try { out[m[1]] = JSON.parse(m[2]); } catch { /* a value the regex misread */ }
  }
  return Object.keys(out).length ? out : undefined;
}

/** A printed JSON object, whole, as its last fenced json block, or the fields a capped one holds; null for anything else. */
function jsonObject(text: string | null | undefined): Record<string, unknown> | null {
  const t = (text ?? "").trim();
  if (!t) return null;
  const fences = [...t.matchAll(/```json[ \t]*\n([\s\S]*?)\n[ \t]*```/g)];
  const body = t.startsWith("{") ? t : fences[fences.length - 1]?.[1];
  if (!body) return null;
  try {
    const v = JSON.parse(body);
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return body.startsWith("{") ? headFields(body) ?? null : null;
  }
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
    if (typeof v === "string" && known.some((k) => k && k.trim() === v.trim())) continue;
    const value = valueWords(v);
    if (value) all.push({ key, value });
  }
  return all.length ? { kind: "fields", fields: all.slice(0, FIELDS), more: Math.max(0, all.length - FIELDS) } : null;
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
  return cap(t, TEXT_CAP);
}

/** What this visit produced, or null when it produced nothing but its outcome. */
export function visitOutput(v: VisitOutputInput): VisitOutput | null {
  if (v.superseded || v.status === "live" || v.status === "waiting") return null;
  const outcome = v.decided.outcome;
  if (v.kind === "person") {
    const choice = (v.answer ?? v.decided.toWords ?? outcome?.replace(/_/g, " ") ?? "").trim();
    const note = v.reasoning?.trim() || null;
    if (!choice || BARE.test(choice)) return note ? { kind: "text", text: cap(note, TEXT_CAP) } : null;
    return { kind: "choice", choice, note: note && note !== choice ? cap(note, TEXT_CAP) : null };
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
  return fieldsOf(result, outcome, known) ?? (said ? { kind: "text", text: said } : null);
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
