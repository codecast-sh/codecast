// The one translator from an org change to the words a card reads: the
// sentence and its clauses, the terse line the log, the CLI and a stored
// `line` print, the chip on a chart node, and the fields a card draws with
// what each read as before. The switches that write the sentences stay in
// orgProposal.ts (changeClauses, changeLine, describeOrgChange); this module
// is their one entry point for cards, and the web adds faces on top.
//
// Imports: orgProposal as values, orgChange as types only. orgChange imports
// orgProposal, so a value import back would read a binding during the
// partial load (convex/moduleLoad.test.ts). No React, no store, no tree.

import { autonomyOn } from "./roleAutonomy";
import {
  andList,
  authorityWords,
  changeClauses,
  changeLine,
  describeOrgChange,
  everyWords,
  orgProposalWork,
  orgRecordGroups,
  RECORD_ACT_WORDS,
  recordGroupTotalsLine,
  type ChangeWords as ChangeLineWords,
  type OrgAskNames,
  type OrgChange,
  type OrgChangeStatus,
  type OrgPriority,
  type OrgRecordAct,
  type OrgRecordTotal,
  type OrgRoleProposal,
} from "./orgProposal";
import type { OrgDiffField, OrgPartyRef, OrgScopeIds } from "./orgChange";

// ── Shapes ───────────────────────────────────────────────────────────────────

/** What a value points at, so a card can draw a face or a link beside the words. */
export type FieldRef = { kind: "role" | "person" | "project" | "plan" | "goal" | "task" | "session"; id: string };
/** A value as words. `none` is a placeholder ("not set", "nobody"), drawn
 *  quiet and never struck. `items`, `measures` and `priority` carry the
 *  structure behind the words for the kinds that draw them apart. */
export type FieldText = { text: string; none?: true; tail?: string; items?: string[]; measures?: { name: string; target: string }[]; priority?: OrgPriority; ref?: FieldRef };
export type PassagePart = { kind: "same" | "removed" | "added" | "gap"; text: string };
export type ChangeFieldKind = "text" | "list" | "ref" | "priority" | "measures" | "status" | "passage";
/** set: nothing to compare. change: before to after. add / remove: a list
 *  gains or loses entries. clear: the value goes away. same: the record
 *  already reads that way. */
export type FieldOp = "set" | "change" | "add" | "remove" | "clear" | "same";
export type ChangeField = { key: string; label: string; kind: ChangeFieldKind; op: FieldOp; before: FieldText | null; after: FieldText | null; diff?: PassagePart[]; seq: number };
export type ChangeWords = {
  /** One sentence, verb first, with its full stop: the card's line. */
  sentence: string;
  clauses: string[];
  /** Where the subject's name sits in `sentence`, for emphasis. */
  subjectSpan: [number, number] | null;
  /** describeOrgChange, byte for byte: the journal, the CLI and a stored `line`. */
  terse: string;
  /** The delta alone, for a chip on a node that already names the subject. */
  chip: string;
  fields: ChangeField[];
  reason?: string;
};
export type ChangeWordsCtx = {
  names?: OrgAskNames;
  /** What the record read as before, by log field: a key present means the
   *  before is known (null for none); `labels` names the ids the values hold. */
  before?: Partial<Record<OrgDiffField | "charter", unknown>> & { labels?: Record<string, string> };
  /** What to call the subject in place of its name ("it" after a clause about it). */
  subject?: string;
  was?: { priority?: OrgPriority | null };
  purpose?: boolean;
  status?: OrgChangeStatus;
  /** The change's number in its proposal, stamped on every field. */
  seq?: number;
};

// ── Small words ──────────────────────────────────────────────────────────────

const NONE = { unset: "not set", top: "at the top level", nothing: "nothing", project: "no project", number: "no number yet", nobody: "nobody" } as const;
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const fullStop = (s: string) => { const t = s.trim(); return /[.!?]$/.test(t) ? t : `${t}.`; };
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const bare = (h: string) => h.trim().replace(/^@/, "").toLowerCase();
const at = (h: string) => `@${h.replace(/^@/, "")}`;
const lc = (s: string) => s.trim().toLowerCase();
const strings = (raw: unknown): string[] => (Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((x) => x.trim()) : []);
const statusWords = (status: string) => status.replace(/_/g, " ");
const shortDate = (ms: number) => new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

const text = (t: string, more: Omit<FieldText, "text"> = {}): FieldText => ({ text: t.trim(), ...more });
const none = (t: string): FieldText => ({ text: t, none: true });
const words = (raw: unknown, empty: string): FieldText => (typeof raw === "string" && raw.trim() ? text(raw) : none(empty));
const items = (xs: readonly string[], empty: string): FieldText => (xs.length ? { text: andList([...xs]), items: [...xs] } : none(empty));
const measures = (raw: unknown, empty: string): FieldText => {
  const list = Array.isArray(raw) ? raw.filter((m): m is { name: string; target: unknown } => !!m && typeof m.name === "string").map((m) => ({ name: m.name.trim(), target: String(m.target ?? "").trim() })) : [];
  return list.length ? { text: list.map((m) => `${m.name} (target ${m.target})`).join(", "), measures: list } : none(empty);
};
const priority = (p: OrgPriority): FieldText => ({ text: p.toUpperCase(), priority: p });

/** Two values that read the same: the record already holds what the change sets. */
function valueKey(v: FieldText | null): string {
  if (!v) return "";
  if (v.none) return "none";
  if (v.items) return `n:${v.items.map(lc).sort().join("\u0001")}`;
  if (v.measures) return `m:${v.measures.map((m) => `${lc(m.name)}=${lc(m.target)}`).join("\u0001")}`;
  return `t:${lc(v.text)}${v.tail ? lc(v.tail) : ""}`;
}

/** The fields that hold prose, whose before and after read as a passage diff. */
const PROSE_KEY = /^(charter|says|goal|why|done_when)(:|$)/;

// ── The sentence ─────────────────────────────────────────────────────────────

function lineWords(ctx: ChangeWordsCtx): ChangeLineWords {
  return { names: ctx.names, brief: true, ...(ctx.subject !== undefined ? { subject: ctx.subject } : {}), ...(ctx.was ? { was: ctx.was } : {}), ...(ctx.purpose ? { purpose: true } : {}) };
}

/** The name the sentence calls the subject by, for the emphasis span. */
function subjectName(c: OrgChange, names?: OrgAskNames): string | null {
  const role = (h: string) => names?.role?.(bare(h)) ?? at(h);
  const project = (ref: string) => names?.project?.(ref) ?? ref;
  switch (c.kind) {
    case "role": return c.name.trim();
    case "projects": { const x = c.changes[0]; return !x ? null : x.op === "create" ? x.title.trim() : project(x.from); }
    case "move": case "retire": case "scope": case "budget": case "trust": case "routine": case "adopt": case "authority": case "hire": case "charter_edit": return role(c.handle);
    case "project_meta": return project(c.project);
    case "file": return names?.plan?.(c.plan) ?? c.plan;
    case "upgrade": return c.instance;
    case "plan_status": return c.title?.trim() || names?.plan?.(c.plan) || c.plan;
    case "task_status": return c.title?.trim() || c.task;
    case "project_status": return c.title?.trim() || project(c.project);
    case "initiative": return c.title.trim();
    case "initiative_projects": case "initiative_owner": case "initiative_shape": return c.title?.trim() || names?.initiative?.(c.initiative) || c.initiative;
    default: return null;
  }
}

function spanOf(sentence: string, name: string | null): [number, number] | null {
  if (!name) return null;
  const i = sentence.indexOf(name);
  return i >= 0 ? [i, i + name.length] : null;
}

export function changeWords(change: OrgChange, ctx: ChangeWordsCtx = {}): ChangeWords {
  const w = lineWords(ctx);
  const sentence = fullStop(changeLine(change, w));
  const reason = "reason" in change && typeof change.reason === "string" && change.reason.trim() ? change.reason.trim() : undefined;
  return {
    sentence,
    clauses: changeClauses(change, w),
    subjectSpan: spanOf(sentence, subjectName(change, ctx.names)),
    terse: describeOrgChange(change),
    chip: chipLine(change),
    fields: fieldsOf(change, ctx).map((f) => ({ ...f, seq: ctx.seq ?? 0 })),
    ...(reason ? { reason } : {}),
  };
}

/** One sentence for a subject several changes touch: the lead's clauses,
 *  then each other change's with "it"; past three clauses the first and a
 *  count. A card that creates its subject says so and stops. */
export function subjectWords(lead: OrgChange, others: readonly OrgChange[], ctx: ChangeWordsCtx & { isNew: boolean }): { sentence: string; subjectSpan: [number, number] | null } {
  const w = lineWords(ctx);
  const clauses = [...changeClauses(lead, w), ...(ctx.isNew ? [] : others.flatMap((c) => changeClauses(c, { ...w, subject: "it" })))];
  const sentence = fullStop(capital(clauses.length <= 3 ? andList(clauses) : `${clauses[0]} and ${clauses.length - 1} more changes`));
  return { sentence, subjectSpan: spanOf(sentence, subjectName(lead, ctx.names)) };
}

// ── The fields ───────────────────────────────────────────────────────────────

type Draft = Omit<ChangeField, "seq">;

function fieldsOf(c: OrgChange, ctx: ChangeWordsCtx): Draft[] {
  const { names, before: was } = ctx;
  const settled = ctx.status === "accepted" || ctx.status === "applied";
  const known = (f: OrgDiffField | "charter") => !!was && f in was;
  const read = (f: OrgDiffField | "charter", as: (raw: unknown) => FieldText): FieldText | undefined => (known(f) ? as(was![f]) : undefined);
  const label = (id: unknown) => (typeof id === "string" ? was?.labels?.[id] : undefined);

  const roleName = (h: string) => names?.role?.(bare(h)) ?? at(h);
  const roleText = (h: string) => text(roleName(h), { ref: { kind: "role", id: bare(h) } });
  const project = (ref: string) => names?.project?.(ref) ?? ref;
  const projectText = (ref: string) => text(project(ref), { ref: { kind: "project", id: ref } });
  const plan = (ref: string) => names?.plan?.(ref) ?? ref;
  const thing = (ref: string) => names?.project?.(ref) ?? names?.plan?.(ref) ?? ref;
  const goal = (ref: string) => names?.initiative?.(ref) ?? ref;
  /** Who a role reports to: "you" for the reader, a role by name, anyone else as named. */
  const parent = (ref: string | undefined): FieldText => (!ref || lc(ref) === "me" ? text("you") : ref.trim().startsWith("@") ? roleText(ref) : text(ref));
  /** A goal's or a project's owner: "@handle" a role, "me" the reader, else a person by name. */
  const owner = (ref: string | undefined, empty: string): FieldText => (!ref?.trim() ? none(empty) : parent(ref));
  const party = (raw: unknown): FieldText => {
    const r = raw as OrgPartyRef | null | undefined;
    if (!r) return none(NONE.nobody);
    const id = r.kind === "user" ? r.user_id : r.role_id;
    return text(label(id) ?? id, { ref: { kind: r.kind === "user" ? "person" : "role", id } });
  };
  const named = (kind: FieldRef["kind"], empty: string) => (raw: unknown): FieldText => (typeof raw === "string" && raw ? text(label(raw) ?? raw, { ref: { kind, id: raw } }) : none(empty));
  const scopeTitles = (raw: unknown): string[] => { const s = raw as OrgScopeIds | null | undefined; return [...(s?.project_ids ?? []), ...(s?.plan_ids ?? [])].map((id) => label(id) ?? id); };

  const field = (key: string, lab: string, kind: ChangeFieldKind, after: FieldText, before: FieldText | undefined, cleared = false): Draft => {
    if (before === undefined) return { key, label: lab, kind, op: cleared ? "clear" : "set", before: null, after };
    // The record already reads that way. While a verdict's echo is on its way
    // the live record may have moved first, so a settled row shows the value alone.
    if (valueKey(before) === valueKey(after)) return settled ? { key, label: lab, kind, op: "set", before: null, after } : { key, label: lab, kind, op: "same", before, after };
    if (kind === "text" && PROSE_KEY.test(key) && !before.none && !after.none) return { key, label: lab, kind: "passage", op: "change", before, after, diff: passageDiff(before.text, after.text) };
    return { key, label: lab, kind, op: cleared ? "clear" : "change", before, after };
  };
  const set = (key: string, lab: string, kind: ChangeFieldKind, after: FieldText): Draft => field(key, lab, kind, after, undefined);
  /** A list that gains or loses entries. With a before, one row over the
   *  whole list; without, the added and the removed entries as their own rows. */
  const listRows = (key: string, lab: string, empty: string, added: readonly string[], removed: readonly string[], before: readonly string[] | undefined, whole?: readonly string[]): Draft[] => {
    const has = (list: readonly string[], name: string) => list.some((x) => lc(x) === lc(name));
    if (before === undefined) return [
      ...(added.length ? [{ key, label: lab, kind: "list" as const, op: "add" as const, before: null, after: items(added, empty) }] : []),
      ...(removed.length ? [{ key: `${key}:remove`, label: lab, kind: "list" as const, op: "remove" as const, before: null, after: items(removed, empty) }] : []),
    ];
    const after = whole ?? [...before.filter((x) => !has(removed, x)), ...added.filter((x) => !has(before, x))];
    const gained = after.some((x) => !has(before, x)), lost = before.some((x) => !has(after, x));
    const row = field(key, lab, "list", items(after, empty), items(before, empty), after.length === 0);
    return [row.op === "change" ? { ...row, op: gained && lost ? "change" : gained ? "add" : "remove" } : row];
  };
  const areaRows = (add: readonly string[] | undefined, remove: readonly string[] | undefined): Draft[] => {
    if (!add?.length && !remove?.length) return [];
    return listRows("looks_after", "Looks after", NONE.nothing, (add ?? []).map(thing), (remove ?? []).map(thing), known("scope") ? scopeTitles(was!.scope) : undefined);
  };
  const starts = (trust: unknown) => text(autonomyOn(typeof trust === "string" ? trust : null) ? "on its own, inside its area" : "when you start it");
  const may = (raw: unknown) => (Array.isArray(raw) && raw.length ? text(authorityWords(raw)) : none(NONE.nothing));
  const stays = (t: OrgRoleProposal["tenure"]): string | null => {
    if (!t || t.kind !== "program") return null;
    const e = t.ends as { plan?: string; project?: string; date?: number };
    const end = e.plan !== undefined ? `${plan(e.plan)} ends` : e.project !== undefined ? `${project(e.project)} ends` : shortDate(e.date ?? 0);
    return `until ${end}, then ${t.then}`;
  };

  switch (c.kind) {
    case "role": {
      const scope = [...(c.scope?.projects ?? []).map(project), ...(c.scope?.plans ?? []).map(plan)];
      const until = stays(c.tenure);
      return [
        set("reports_to", "Reports to", "ref", parent(c.reports_to)),
        ...(scope.length ? [set("looks_after", "Looks after", "list", items(scope, NONE.nothing))] : []),
        ...(c.seat ? [set("session", "Session", "text", text(c.seat.title?.trim() || names?.session?.(c.seat.existing) || c.seat.existing, { ref: { kind: "session", id: c.seat.existing } }))] : []),
        ...(c.charter?.trim() ? [set("charter", "Charter", "text", text(c.charter))] : []),
        ...(until ? [set("stays", "Stays", "text", text(until))] : []),
      ];
    }
    case "projects": return c.changes.flatMap((x, i): Draft[] => x.op === "create"
      ? (x.description?.trim() ? [set(`says:${i}`, "Says", "text", text(x.description))] : [])
      : [{ key: `folds:${i}`, label: "Folds into", kind: "ref", op: "change", before: projectText(x.from), after: projectText(x.into) }]);
    case "move": return [
      ...(c.reports_to ? [field("reports_to", "Reports to", "ref", parent(c.reports_to), read("reports_to", party))] : []),
      ...areaRows(c.scope_add, c.scope_remove),
    ];
    case "scope": return areaRows(c.add, c.remove);
    case "retire": return [{ key: "role", label: "Role", kind: "ref", op: "clear", before: roleText(c.handle), after: null }];
    // A limit is never a row (S23.2).
    case "budget": return [];
    case "trust": return [field("starts_work", "Starts work", "text", starts(c.trust), read("trust", starts))];
    case "routine": return [set("routine", "Runs", "text", { text: c.title.trim(), tail: `, ${everyWords(c.every)}` })];
    case "project_meta": {
      const livePriority = known("priority") ? (typeof was!.priority === "string" && /^p[0-3]$/.test(was!.priority) ? priority(was!.priority as OrgPriority) : none(NONE.unset))
        : ctx.was && "priority" in ctx.was ? (ctx.was.priority ? priority(ctx.was.priority) : none(NONE.unset)) : undefined;
      const list = (key: "success_metrics" | "non_goals" | "risks", lab: string, value: string[] | undefined) => (value == null ? [] : [field(key, lab, "list", items(strings(value), NONE.nothing), read(key, (raw) => items(strings(raw), NONE.nothing)), value.length === 0)]);
      return [
        ...(c.priority ? [field("priority", "Priority", "priority", priority(c.priority), livePriority)] : []),
        ...(c.owner ? [field("owner", "Led by", "ref", parent(c.owner), read("owner_role_id", named("role", NONE.nobody)))] : []),
        ...(c.goal != null ? [field("goal", "Says", "text", words(c.goal, NONE.unset), read("goal", (raw) => words(raw, NONE.unset)), !c.goal.trim())] : []),
        ...list("success_metrics", "Measured by", c.success_metrics),
        ...list("non_goals", "Leaves out", c.non_goals),
        ...list("risks", "Risks", c.risks),
      ];
    }
    case "adopt": return [field("session", "Session", "text", text(names?.session?.(c.conversation) ?? c.conversation, { ref: { kind: "session", id: c.conversation } }), read("standing_session", (raw) => words((raw as { short_id?: string } | null)?.short_id, NONE.unset)))];
    case "file": return [field("project", "Project", "ref", projectText(c.project), read("project_id", named("project", NONE.project)))];
    case "charter_edit": return c.edits.map((e, i): Draft => {
      const key = `charter_edit:${i}`, lab = "Charter";
      if (e.op === "replace") return { key, label: lab, kind: "passage", op: "change", before: text(e.before), after: text(e.after), diff: passageDiff(e.before, e.after) };
      if (e.op === "add") return { key, label: lab, kind: "passage", op: "add", before: null, after: text(e.line), diff: [{ kind: "added", text: e.line }] };
      return { key, label: lab, kind: "passage", op: "remove", before: text(e.before), after: null, diff: [{ kind: "removed", text: e.before }] };
    });
    case "plan_status": case "task_status": case "project_status":
      return [field("status", "Status", "status", text(statusWords(c.status)), read("status", (raw) => (typeof raw === "string" ? text(statusWords(raw)) : none(NONE.unset))))];
    case "authority": return [field("may", "May", "text", may(c.authority), read("authority", may), c.authority.length === 0)];
    case "hire": return [set("hired", "Hired from", "text", text(`${c.template} (${c.version})`)), set("leads", "Leads", "ref", projectText(c.project))];
    case "upgrade": return [set("version", "Version", "text", text(`${c.template} ${c.to}`))];
    case "initiative": return [
      set("owner", "Owned by", "ref", owner(c.owner, NONE.nobody)),
      // The purpose is read through the goals under it; every other goal says when it has no number.
      ...(c.metrics?.length || !ctx.purpose ? [set("metrics", "Measured by", "measures", measures(c.metrics, NONE.number))] : []),
      set("projects", "Carried by", "list", items(c.projects.map(project), NONE.project)),
      ...(c.description?.trim() ? [set("says", "Says", "text", text(c.description))] : []),
      ...(c.why?.trim() ? [set("why", "Why it matters", "text", text(c.why))] : []),
      ...(c.done_when?.trim() ? [set("done_when", "Done when", "text", text(c.done_when))] : []),
      ...(c.milestones?.length ? [set("milestones", "Milestones", "list", items(c.milestones.map((m) => m.title.trim()), NONE.nothing))] : []),
      ...(c.target_date ? [set("due", "Due", "text", text(new Date(c.target_date).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })))] : []),
    ];
    case "initiative_shape": {
      const entries = (key: "milestones" | "questions" | "decisions", lab: string, proposed: readonly string[] | undefined) => listRows(key, lab, NONE.nothing, (proposed ?? []).map((x) => x.trim()).filter(Boolean), [], undefined);
      return [
        ...(c.parent !== undefined ? [field("parent", "Sits", "ref", c.parent === null ? none(NONE.top) : text(goal(c.parent), { ref: { kind: "goal", id: c.parent } }), read("parent_initiative_id", named("goal", NONE.top)))] : []),
        ...(c.metrics !== undefined ? [field("metrics", "Measured by", "measures", measures(c.metrics, NONE.nothing), read("metrics", (raw) => measures(raw, NONE.nothing)), c.metrics.length === 0)] : []),
        ...(c.why !== undefined ? [field("why", "Why it matters", "text", words(c.why, NONE.unset), read("why", (raw) => words(raw, NONE.unset)), !c.why.trim())] : []),
        ...(c.done_when !== undefined ? [field("done_when", "Done when", "text", words(c.done_when, NONE.unset), read("done_when", (raw) => words(raw, NONE.unset)), !c.done_when.trim())] : []),
        ...entries("milestones", "Milestones", c.milestones?.map((m) => m.title)),
        ...entries("questions", "Open questions", c.questions),
        ...entries("decisions", "Decisions", c.decisions),
      ];
    }
    case "initiative_projects": {
      const titles = (raw: unknown) => strings(raw).map((id) => label(id) ?? id);
      return listRows("projects", "Carried by", NONE.project, c.projects.map(project), [], known("project_ids") ? titles(was!.project_ids) : undefined);
    }
    case "initiative_owner": return [field("owner", "Owned by", "ref", owner(c.owner, NONE.nobody), read("owner", party), !c.owner.trim())];
    default: return [];
  }
}

/** What an amend moved, field by field: the fields of `after` whose value
 *  differs from the same key in `before` (op change; prose as a passage with
 *  a diff), the fields only `after` has (op set) and the ones only `before`
 *  had (op clear). Empty for a rationale-only amend. */
export function fieldMoves(before: OrgChange, after: OrgChange, ctx: ChangeWordsCtx = {}): ChangeField[] {
  const plain: ChangeWordsCtx = { names: ctx.names, seq: ctx.seq };
  const was = new Map(changeWords(before, plain).fields.map((f) => [f.key, f]));
  const now = changeWords(after, plain).fields;
  const out: ChangeField[] = [];
  for (const f of now) {
    const w = was.get(f.key);
    if (!w) { out.push(f); continue; }
    if (valueKey(w.after) === valueKey(f.after)) continue;
    const prose = (f.kind === "text" || f.kind === "passage") && PROSE_KEY.test(f.key) && w.after && f.after && !w.after.none && !f.after.none;
    out.push(prose ? { ...f, kind: "passage", op: "change", before: w.after, after: f.after, diff: passageDiff(w.after!.text, f.after!.text) } : { ...f, op: "change", before: w.after, after: f.after });
  }
  const keys = new Set(now.map((f) => f.key));
  for (const [key, w] of was) if (!keys.has(key) && w.after) { const { diff: _diff, ...rest } = w; out.push({ ...rest, op: "clear", before: w.after, after: null }); }
  return out;
}

// ── Passages ─────────────────────────────────────────────────────────────────

const ABBREVIATIONS = new Set(["e.g", "i.e", "etc", "vs", "mr", "ms", "dr", "no"]);
const LIST_LINE = /^\s*(?:[-*•]|\d+[.)])\s/;
type Unit = { text: string; key: string };

/** A line as sentences, each keeping the whitespace that followed it. A stop
 *  splits only before a capital, a quote or a bracket, and never after a lone
 *  digit run or a known abbreviation, so "v2.1", "codecast.sh" and "e.g. the" stay whole. */
function sentences(line: string): string[] {
  const out: string[] = [];
  let start = 0;
  const re = /[.!?]+(\s+)(?=[A-Z"'(\[])/g;
  for (let m = re.exec(line); m; m = re.exec(line)) {
    const head = line.slice(start, m.index + m[0].length - m[1].length);
    const token = head.match(/(\S+?)[.!?]+$/)?.[1]?.replace(/^[("'\[]+/, "") ?? "";
    if (/^\d+$/.test(token) || ABBREVIATIONS.has(token.toLowerCase())) continue;
    out.push(line.slice(start, m.index + m[0].length));
    start = m.index + m[0].length;
  }
  if (start < line.length) out.push(line.slice(start));
  return out;
}

/** The units a passage diffs by: lines first; a list shaped line is one unit,
 *  any other line its sentences. Each unit keeps its trailing separator. */
function units(passage: string): Unit[] {
  const out: Unit[] = [];
  const pieces = passage.split(/(\n+)/);
  for (let k = 0; k < pieces.length; k += 2) {
    const line = pieces[k], sep = pieces[k + 1] ?? "";
    if (!line.trim()) { if (out.length) out[out.length - 1].text += line + sep; continue; }
    const parts = LIST_LINE.test(line) ? [line] : sentences(line);
    parts.forEach((p, i) => out.push({ text: i === parts.length - 1 ? p + sep : p, key: p.trim() }));
  }
  return out;
}

/**
 * What changed between two passages, sentence by sentence (line by line for
 * list shaped text): the longest common run of units, the units around it
 * as removed and added (removed first), and an unchanged run of two or more
 * units collapsed to one `gap` the renderer draws as a quiet ellipsis. One
 * unchanged unit beside a change stays as `same`; identical passages give
 * one `same`; a blank side gives one `added` or `removed`.
 */
export function passageDiff(before: string, after: string): PassagePart[] {
  const a = before.trim() ? units(before) : [], b = after.trim() ? units(after) : [];
  if (!a.length && !b.length) return [];
  if (!a.length) return [{ kind: "added", text: after }];
  if (!b.length) return [{ kind: "removed", text: before }];
  // LCS over trimmed units.
  const n = a.length, m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i].key === b[j].key ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const runs: { kind: PassagePart["kind"]; texts: string[] }[] = [];
  const add = (kind: PassagePart["kind"], t: string) => { const last = runs[runs.length - 1]; if (last && last.kind === kind) last.texts.push(t); else runs.push({ kind, texts: [t] }); };
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i].key === b[j].key) { add("same", b[j].text); i++; j++; }
    else if (j < m && (i >= n || dp[i][j + 1] >= dp[i + 1][j])) { add("added", b[j].text); j++; }
    else { add("removed", a[i].text); i++; }
  }
  // Removed before added between two anchors, whatever order the walk found them.
  for (let k = 0; k + 1 < runs.length; k++) if (runs[k].kind === "added" && runs[k + 1].kind === "removed") [runs[k], runs[k + 1]] = [runs[k + 1], runs[k]];
  if (runs.length === 1 && runs[0].kind === "same") return [{ kind: "same", text: after }];
  return runs.map((r) => ({ kind: r.kind === "same" && r.texts.length > 1 ? "gap" : r.kind, text: r.texts.join("") }));
}

// ── Totals ───────────────────────────────────────────────────────────────────

const RECORD_ACTS = Object.keys(RECORD_ACT_WORDS) as OrgRecordAct[];

/** "1 plan done, 14 tasks done and 3 tasks reopened"; with `nouns: false` the
 *  acts summed across nouns, most first, ties in the acts' own order:
 *  "44 done, 15 reopened, 3 abandoned, 1 dropped and 1 to the backlog". */
export function recordTotalsWords(totals: readonly OrgRecordTotal[], opts: { nouns?: boolean } = {}): string {
  if (opts.nouns !== false) return recordGroupTotalsLine({ totals });
  const byAct = new Map<OrgRecordAct, number>();
  for (const t of totals) byAct.set(t.act, (byAct.get(t.act) ?? 0) + t.count);
  return andList([...byAct].sort((x, y) => y[1] - x[1] || RECORD_ACTS.indexOf(x[0]) - RECORD_ACTS.indexOf(y[0])).map(([act, k]) => `${k} ${RECORD_ACT_WORDS[act]}`));
}

/** The nouns a structure proposal's changes are counted under, one and many. */
const BUCKET_WORDS = {
  role: ["new role", "new roles"], seat: ["session named as a role", "sessions named as roles"],
  project: ["new project", "new projects"], merge: ["project merged", "projects merged"], file: ["plan filed", "plans filed"],
  priority: ["project priority", "project priorities"], charter: ["project charter", "project charters"],
  move: ["move", "moves"], area: ["area change", "area changes"], retire: ["retirement", "retirements"], rewrite: ["charter rewrite", "charter rewrites"],
  setting: ["setting", "settings"], record: ["record", "records"], goal: ["change to a goal", "changes to goals"],
} as const;
type Bucket = keyof typeof BUCKET_WORDS;

function bucketsOf(c: OrgChange): Bucket[] {
  switch (c.kind) {
    case "role": return [c.seat ? "seat" : "role"];
    case "projects": return c.changes.map((x) => (x.op === "create" ? "project" : "merge"));
    case "file": return ["file"];
    case "project_meta": return [c.goal == null && c.success_metrics == null && c.non_goals == null && c.risks == null && !c.owner && c.priority ? "priority" : "charter"];
    case "move": return ["move"];
    case "scope": return ["area"];
    case "retire": return ["retire"];
    case "charter_edit": return ["rewrite"];
    case "plan_status": case "task_status": case "project_status": return ["record"];
    case "initiative": case "initiative_projects": case "initiative_owner": case "initiative_shape": return ["goal"];
    default: return ["setting"];
  }
}

/**
 * The proposal's size in words: `count` for the meta line ("64 records",
 * "11 changes to goals", "4 changes") and `line` for the card body, null
 * when one change says it all. Records sum their acts across the groups;
 * goals split new from existing; everything else is counted under the nouns
 * above, in the order the proposal first names each, and a bucket that is
 * the whole proposal drops the leading count ("9 project priorities.").
 */
export function proposalTotals(changes: ReadonlyArray<{ seq: number; change: OrgChange; status?: string }>, names?: OrgAskNames): { count: string; line: string | null } {
  const live = changes.filter((c) => c.status !== "removed");
  const n = live.length;
  const work = orgProposalWork(live);
  if (work === "records") {
    const count = plural(n, "record");
    return { count, line: n < 2 ? null : `${count}: ${recordTotalsWords(orgRecordGroups(live, names).flatMap((g) => g.totals), { nouns: false })}.` };
  }
  if (n < 2) return { count: plural(n, "change"), line: null };
  if (work === "goals") {
    const fresh = live.filter((c) => c.change.kind === "initiative").length, old = n - fresh;
    const halves = [fresh ? plural(fresh, "new goal") : "", old ? plural(old, "change to a goal that exists", "changes to goals that exist") : ""].filter(Boolean);
    return { count: `${n} changes to goals`, line: `${n} changes to goals: ${andList(halves)}.` };
  }
  const counts = new Map<Bucket, number>();
  for (const { change } of live) for (const b of bucketsOf(change)) counts.set(b, (counts.get(b) ?? 0) + 1);
  const parts = [...counts].map(([b, k]) => `${k} ${BUCKET_WORDS[b][k === 1 ? 0 : 1]}`);
  return { count: `${n} changes`, line: parts.length === 1 ? `${parts[0]}.` : `${n} changes: ${andList(parts)}.` };
}

// ── The chip ─────────────────────────────────────────────────────────────────

const compact = (n: number) => (n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${Math.round(n / 1_000)}k` : String(n));
const refs = (xs: string[] | undefined, sign: string) => (xs ?? []).map((x) => `${sign}${x}`).join(" ");
/** Caps always read in one order, whatever order the proposal wrote them. */
const CAP_ORDER = ["hands_per_day", "wakes_per_day", "tokens_per_day"] as const;

/**
 * The delta alone, for the chip on a card (org-staffing.md S5: "+ project X",
 * "tokens 800k", "starts work on its own"). The card already names the role the
 * chip sits on, so the verb and the handle are left out; the full sentence
 * (changeLine) is the chip's title.
 */
export function chipLine(change: OrgChange): string {
  switch (change.kind) {
    case "role": return at(change.handle);
    case "projects": return change.changes.map((x) => (x.op === "create" ? `+ ${x.title}` : `${x.from} into ${x.into}`)).join(", ");
    case "move": return [change.reports_to ? `under ${change.reports_to}` : "", refs(change.scope_add, "+"), refs(change.scope_remove, "−")].filter(Boolean).join(" ") || "move";
    case "retire": return "retire";
    case "scope": return [refs(change.add, "+ "), refs(change.remove, "− ")].filter(Boolean).join(" ");
    case "budget": return CAP_ORDER.filter((k) => change.caps[k] !== undefined).map((k) => `${k.replace("_per_day", "")} ${compact(change.caps[k] as number)}`).join(" · ");
    case "trust": return autonomyOn(change.trust) ? "starts work on its own" : "stops starting work on its own";
    case "routine": return `every ${change.every} · ${change.title}`;
    case "project_meta": return [change.project, change.priority, change.owner ? `owner ${at(change.owner)}` : ""].filter(Boolean).join(" · ");
    case "adopt": return `adopt ${change.conversation}`;
    case "file": return `${change.plan} under ${change.project}`;
    case "authority": return change.authority.map((g) => g.kind).join(" · ");
    case "hire": return `${change.template} ${change.version}`;
    case "upgrade": return `to ${change.to}`;
    case "initiative": return `+ ${change.title}`;
    case "initiative_projects": return refs(change.projects, "+ ");
    case "initiative_owner": return `owner ${change.owner.startsWith("@") ? at(change.owner) : change.owner}`;
    case "initiative_shape": return [change.parent === undefined ? "" : change.parent ? `under ${change.parent}` : "top level", change.metrics === undefined ? "" : change.metrics.length ? change.metrics.map((m) => `${m.name} ${m.target}`).join(" · ") : "no metric"].filter(Boolean).join(" · ");
    default: return changeLine(change);
  }
}
