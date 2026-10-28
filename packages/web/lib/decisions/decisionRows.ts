// The Decisions list's model: who owns each decision, what kind it is, where
// it came from, and how the list's tabs, filters, groups and sorts read those
// facts. The Decisions page and Flows' For you both arrange their rows here,
// so the two lists agree on every row's owner, group and order. Pure.
import { CARD_GATE_NODE_ID } from "@codecast/shared/contracts/changeCard";
import type { SessionDecisionItem } from "../../store/inboxStore";

type Row = Pick<SessionDecisionItem, "_id" | "status" | "blocking" | "created_at" | "category" | "workflow_run_id" | "gate_node_id" | "task_id" | "trial" | "card"
  | "holder" | "passed_to" | "asked_user_ids" | "user_id" | "escalated" | "area_project_id" | "source_flow" | "problem_severity" | "problem_findings" | "problem_reach" | "resolved_at">;

export type DecisionOwner = { kind: "user" | "role"; id: string };

/**
 * The one person (or role) expected to answer: whoever it was passed to, else
 * the holder routing chose, else the single person it was asked of. Null when
 * nobody is expected, the Unassigned group. Anyone who can read it may still
 * answer it.
 */
export function decisionOwner(d: Row): DecisionOwner | null {
  if (d.passed_to) return { kind: d.passed_to.kind, id: String(d.passed_to.id) };
  if (d.holder) return { kind: d.holder.kind, id: String(d.holder.id) };
  if (d.asked_user_ids) return d.asked_user_ids.length > 0 ? { kind: "user", id: String(d.asked_user_ids[0]) } : null;
  return d.user_id ? { kind: "user", id: String(d.user_id) } : null;
}

export const ownerKey = (o: DecisionOwner | null): string => (o ? `${o.kind}:${o.id}` : "none");
export const ownedBy = (d: Row, userId: string | null | undefined): boolean => {
  const o = decisionOwner(d);
  return !!userId && o?.kind === "user" && o.id === userId;
};

export const isOpen = (d: Pick<Row, "status">) => d.status === "pending";
/** Escalated counts only while it is open: an answer leaves the flag on the resolved row. */
export const isEscalated = (d: Pick<Row, "status" | "escalated">) => isOpen(d) && !!d.escalated;
/** A decision a flow's run asked about a problem: what Flows' For you lists. */
export const isFlowDecision = (d: Pick<Row, "workflow_run_id" | "task_id">) => !!d.workflow_run_id && !!d.task_id;

export type DecisionKind = "question" | "step" | "fix";
export const DECISION_KINDS: readonly DecisionKind[] = ["question", "step", "fix"];
export const DECISION_KIND_LABEL: Record<DecisionKind, string> = { question: "Question", step: "Flow step", fix: "Fix" };

/** What it decides: a fix to ship (a change card, or the flow's decide gate, as For you has always said), another
 *  flow step, else a session's question. */
export function decisionKindOf(d: Pick<Row, "card" | "workflow_run_id" | "gate_node_id">): DecisionKind {
  if (d.card || d.gate_node_id === CARD_GATE_NODE_ID) return "fix";
  return d.workflow_run_id ? "step" : "question";
}

/** Where it came from: the flow that asked it, else a session. */
export const SESSION_SOURCE = "session";
export const decisionSourceOf = (d: Pick<Row, "source_flow" | "workflow_run_id">): string => d.source_flow ?? (d.workflow_run_id ? "A flow" : SESSION_SOURCE);

export type DecisionTab = "mine" | "team" | "unassigned" | "escalated" | "answered";
export const DECISION_TABS: readonly DecisionTab[] = ["mine", "team", "unassigned", "escalated", "answered"];
export const DECISION_TAB_LABEL: Record<DecisionTab, string> = { mine: "Mine", team: "Team", unassigned: "Unassigned", escalated: "Escalated", answered: "Answered" };

export type DecisionAxis = "owner" | "area" | "kind" | "source" | "category";
export const DECISION_AXES: readonly DecisionAxis[] = ["owner", "area", "kind", "source", "category"];
export const DECISION_AXIS_LABEL: Record<DecisionAxis, string> = { owner: "Owner", area: "Area", kind: "Kind", source: "Source", category: "Category" };

export type DecisionSort = "impact" | "severity" | "findings" | "age";
export const DECISION_SORTS: readonly DecisionSort[] = ["impact", "severity", "findings", "age"];
export const DECISION_SORT_LABEL: Record<DecisionSort, string> = { impact: "Most impact", severity: "Most severe", findings: "Most findings", age: "Oldest" };

/** Older than: the age filter's choices. */
export const DECISION_AGES = [{ key: "1d", label: "Over a day", ms: 864e5 }, { key: "3d", label: "Over 3 days", ms: 3 * 864e5 }, { key: "7d", label: "Over a week", ms: 7 * 864e5 }] as const;

/** Everything a view of the list names; every field has an empty default, so a view is the fields it sets. */
export type DecisionView = {
  tab: DecisionTab;
  /** An owner key (user:<id>, role:<id>), "none" for Unassigned, or "" for anyone. */
  owner: string;
  area: string;
  kind: string;
  source: string;
  category: string;
  /** "blocking", "advisory" or "". */
  blocking: string;
  age: string;
  group: DecisionAxis | "none";
  sub: DecisionAxis | "none";
  sort: DecisionSort;
  dir: "asc" | "desc";
};

export const VIEW_FIELDS = ["tab", "owner", "area", "kind", "source", "category", "blocking", "age", "group", "sub", "sort", "dir"] as const;
export const FILTER_FIELDS = ["owner", "area", "kind", "source", "category", "blocking", "age"] as const;

/** Mine groups by nothing (it is one person's), the Team view by owner, so Unassigned is a group of its own. */
export const defaultGroup = (tab: DecisionTab): DecisionAxis | "none" => (tab === "mine" || tab === "unassigned" ? "none" : "owner");
const defaultDir = (sort: DecisionSort): "asc" | "desc" => (sort === "age" ? "asc" : "desc");

/** The view a set of saved or addressed fields names; anything unnamed or unknown is the default. */
export function decisionView(sel: Partial<Record<(typeof VIEW_FIELDS)[number], string | null | undefined>>): DecisionView {
  const tab = (DECISION_TABS as readonly string[]).includes(sel.tab ?? "") ? (sel.tab as DecisionTab) : "mine";
  const axis = (v: string | null | undefined, dflt: DecisionAxis | "none") => (v === "none" || (DECISION_AXES as readonly string[]).includes(v ?? "") ? (v as DecisionAxis | "none") : dflt);
  const group = axis(sel.group, defaultGroup(tab));
  const sub = group === "none" ? "none" : axis(sel.sub, "none");
  const sort = (DECISION_SORTS as readonly string[]).includes(sel.sort ?? "") ? (sel.sort as DecisionSort) : "impact";
  return {
    tab, group, sub: sub === group ? "none" : sub, sort,
    dir: sel.dir === "asc" || sel.dir === "desc" ? sel.dir : defaultDir(sort),
    owner: sel.owner ?? "", area: sel.area ?? "", kind: sel.kind ?? "", source: sel.source ?? "",
    category: sel.category ?? "", blocking: sel.blocking ?? "", age: sel.age ?? "",
  };
}

/** The fields that differ from the default view: what an address or a saved view carries. */
export function viewFields(view: DecisionView): Record<string, string> {
  // Each field against its own default: the tab's grouping, the sort's natural direction.
  const base = { ...decisionView({ tab: view.tab }), dir: defaultDir(view.sort) };
  const out: Record<string, string> = {};
  for (const f of VIEW_FIELDS) if (f === "tab" ? view.tab !== "mine" : view[f] !== base[f]) out[f] = view[f];
  return out;
}

export function inTab(d: Row, tab: DecisionTab, me: string | null): boolean {
  if (tab === "answered") return d.status === "answered" || d.status === "dismissed";
  if (!isOpen(d)) return false;
  if (tab === "mine") return ownedBy(d, me);
  if (tab === "unassigned") return !decisionOwner(d);
  if (tab === "escalated") return isEscalated(d);
  return true;
}

export function tabCounts(rows: ReadonlyArray<Row>, me: string | null): Record<DecisionTab, number> {
  const out = { mine: 0, team: 0, unassigned: 0, escalated: 0, answered: 0 } as Record<DecisionTab, number>;
  for (const d of rows) for (const t of DECISION_TABS) if (inTab(d, t, me)) out[t]++;
  return out;
}

/** The value a row has on a filter's or a group's axis. */
export function axisValue(d: Row, axis: DecisionAxis): string {
  switch (axis) {
    case "owner": return ownerKey(decisionOwner(d));
    case "area": return d.area_project_id ?? "none";
    case "kind": return decisionKindOf(d);
    case "source": return decisionSourceOf(d);
    case "category": return d.category ?? "unknown";
  }
}

const AXIS_OF_FILTER: Record<string, DecisionAxis> = { owner: "owner", area: "area", kind: "kind", source: "source", category: "category" };

/** Whether a row passes every filter but `skip` (a filter's counts are read with the others applied). */
export function passesFilters(d: Row, view: DecisionView, now: number, skip?: (typeof FILTER_FIELDS)[number]): boolean {
  for (const f of FILTER_FIELDS) {
    if (f === skip || !view[f]) continue;
    if (f === "blocking") { if ((view.blocking === "blocking") !== !!d.blocking) return false; continue; }
    if (f === "age") { const ms = DECISION_AGES.find((a) => a.key === view.age)?.ms ?? 0; if (now - d.created_at < ms) return false; continue; }
    const wanted = view[f].split(",");
    if (!wanted.includes(axisValue(d, AXIS_OF_FILTER[f]))) return false;
  }
  return true;
}

/** How many rows of the tab each value of an axis would show, the other filters applied. */
export function filterCounts(rows: ReadonlyArray<Row>, view: DecisionView, me: string | null, now: number, filter: (typeof FILTER_FIELDS)[number]): Map<string, number> {
  const out = new Map<string, number>();
  for (const d of rows) {
    if (!inTab(d, view.tab, me) || !passesFilters(d, view, now, filter)) continue;
    const k = filter === "blocking" ? (d.blocking ? "blocking" : "advisory") : filter === "age" ? "" : axisValue(d, AXIS_OF_FILTER[filter]);
    out.set(k, (out.get(k) ?? 0) + 1);
  }
  return out;
}

/** Impact: escalated first, then blocking, then the people its problem reached, its findings and the worst one's
 *  severity, then the oldest. Another sort leads with its own fact and falls back on the same order. */
function compare(sort: DecisionSort, dir: "asc" | "desc", me: string | null) {
  const flip = dir === defaultDir(sort) ? 1 : -1;
  const age = (a: Row, b: Row) => a.created_at - b.created_at;
  const sev = (a: Row, b: Row) => (b.problem_severity ?? 0) - (a.problem_severity ?? 0);
  const findings = (a: Row, b: Row) => (b.problem_findings ?? 0) - (a.problem_findings ?? 0);
  const reach = (a: Row, b: Row) => (b.problem_reach ?? 0) - (a.problem_reach ?? 0);
  const urgent = (a: Row, b: Row) => {
    const esc = (d: Row) => (isEscalated(d) ? (me && d.escalated?.to?.includes(me) ? 2 : 1) : 0);
    return esc(b) - esc(a) || Number(!!b.blocking) - Number(!!a.blocking);
  };
  const impact = (a: Row, b: Row) => urgent(a, b) || reach(a, b) || findings(a, b) || sev(a, b) || age(a, b);
  return (a: Row, b: Row): number => {
    if (sort === "age") return flip * age(a, b) || urgent(a, b);
    if (sort === "severity") return flip * sev(a, b) || impact(a, b);
    if (sort === "findings") return flip * findings(a, b) || impact(a, b);
    return flip * impact(a, b);
  };
}

export type ArrangeCtx = { me: string | null; now: number; label: (axis: DecisionAxis, value: string) => string };
export type DecisionGroup<T> = { key: string; label: string; axis: DecisionAxis; value: string; items: T[] };

/**
 * The rows as the list draws them: the tab, then the filters, ordered, then
 * grouped on one or two axes (a pair is one header, "Ashot · Codecast"). Groups
 * run in the order of their first row, so the group holding the most urgent
 * decision leads; the Team view by owner always draws the Unassigned group,
 * even empty, so nobody reads its absence as a hole.
 */
export function arrangeDecisions<T extends Row>(rows: ReadonlyArray<T>, view: DecisionView, ctx: ArrangeCtx): { items: T[]; groups: DecisionGroup<T>[] | null } {
  const items = rows.filter((d) => inTab(d, view.tab, ctx.me) && passesFilters(d, view, ctx.now)).sort(compare(view.sort, view.dir, ctx.me));
  if (view.group === "none") return { items, groups: null };
  const axes = [view.group, ...(view.sub !== "none" ? [view.sub] : [])] as DecisionAxis[];
  const groups = new Map<string, DecisionGroup<T>>();
  for (const d of items) {
    const values = axes.map((a) => axisValue(d, a));
    const key = values.join("|");
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { key, label: axes.map((a, i) => ctx.label(a, values[i])).join(" · "), axis: axes[0], value: values[0], items: [] }));
    g.items.push(d);
  }
  const list = [...groups.values()];
  if (view.tab === "team" && view.group === "owner" && view.sub === "none" && !view.owner && items.length > 0 && !groups.has("none")) {
    list.push({ key: "none", label: ctx.label("owner", "none"), axis: "owner", value: "none", items: [] });
  }
  return { items: list.flatMap((g) => g.items), groups: list };
}
