// The team's decision inbox as For you lists it: every open decision of the
// team's lines (lineNeeds, counted), narrowed by who holds it, what it changes
// and its area, ordered by impact, severity or age, and grouped. The address
// carries each choice (`who`, `kind`, `area`, `order`, `group`), so a view is a
// link. Each filter's counts are read with the other filters applied, so a
// count says what picking it would show. Pure.
import { DECISION_CHANGES, DECISION_CHANGE_LABEL, type DecisionChange } from "./decisionFacts";
import type { LineNeed } from "./lineNeeds";

export type InboxOrder = "impact" | "severity" | "age";
export type InboxGroupBy = "area" | "kind" | "who" | "none";
/** Who holds it: everyone's, the viewer's, nobody's, or one teammate's (their user id). */
export type InboxWho = "all" | "me" | "none" | string;

export const INBOX_ORDERS: readonly InboxOrder[] = ["impact", "severity", "age"];
export const INBOX_ORDER_LABEL: Record<InboxOrder, string> = { impact: "Most impact", severity: "Most severe", age: "Oldest" };
export const INBOX_GROUPS: readonly InboxGroupBy[] = ["area", "kind", "who", "none"];
export const INBOX_GROUP_LABEL: Record<InboxGroupBy, string> = { area: "By area", kind: "By kind", who: "By assignee", none: "No groups" };

export type InboxView = { who: InboxWho; kind: DecisionChange | null; area: string | null; order: InboxOrder; group: InboxGroupBy };

/** The view an address names; anything it does not name, or names wrong, is the default: everyone's, by impact, by area. */
export function inboxView(sel: { who?: string | null; kind?: string | null; area?: string | null; order?: string | null; group?: string | null }): InboxView {
  return {
    who: sel.who || "all",
    kind: (DECISION_CHANGES as readonly string[]).includes(sel.kind ?? "") ? (sel.kind as DecisionChange) : null,
    area: sel.area || null,
    order: (INBOX_ORDERS as readonly string[]).includes(sel.order ?? "") ? (sel.order as InboxOrder) : "impact",
    group: (INBOX_GROUPS as readonly string[]).includes(sel.group ?? "") ? (sel.group as InboxGroupBy) : "area",
  };
}

type Need = Pick<LineNeed, "key" | "projectId" | "since" | "findings"> & Partial<Pick<LineNeed, "change" | "assignee" | "reach" | "severity">>;

export const changeOf = (n: Need): DecisionChange => n.change ?? "other";

const holds = (who: InboxWho, n: Need, viewer: string | null): boolean =>
  who === "all" ? true : who === "me" ? !!viewer && n.assignee === viewer : who === "none" ? !n.assignee : n.assignee === who;

/** Impact: the people it reaches, then its findings, then how bad the worst is. */
const impact = (a: Need, b: Need) => (b.reach ?? 0) - (a.reach ?? 0) || (b.findings ?? 0) - (a.findings ?? 0) || (b.severity ?? 0) - (a.severity ?? 0);
const oldest = (a: Need, b: Need) => (a.since ?? Infinity) - (b.since ?? Infinity);
const COMPARE: Record<InboxOrder, (a: Need, b: Need) => number> = {
  impact: (a, b) => impact(a, b) || oldest(a, b),
  severity: (a, b) => (b.severity ?? 0) - (a.severity ?? 0) || impact(a, b) || oldest(a, b),
  age: (a, b) => oldest(a, b) || impact(a, b),
};

export type InboxSection<N> = { key: string; label: string; needs: N[] };
export type InboxCounts = { who: Map<string, number>; kind: Map<DecisionChange, number>; area: Map<string, number> };
export type ArrangedInbox<N> = { sections: InboxSection<N>[]; order: N[]; counts: InboxCounts; total: number };

/**
 * The decisions as the list draws them: filtered, ordered, then grouped, the groups in the order of their first
 * decision, so the group holding the most urgent decision leads. `order` is the list top to bottom, what J and K walk.
 */
export function arrangeInbox<N extends Need>(needs: ReadonlyArray<N>, view: InboxView, ctx: {
  viewer: string | null;
  areaName: (projectId: string | null) => string;
  personName: (userId: string) => string;
}): ArrangedInbox<N> {
  const area = (n: N) => n.projectId ?? "";
  const byWho = (n: N) => holds(view.who, n, ctx.viewer);
  const byKind = (n: N) => !view.kind || changeOf(n) === view.kind;
  const byArea = (n: N) => !view.area || area(n) === view.area;
  const counts: InboxCounts = { who: new Map(), kind: new Map(), area: new Map() };
  for (const n of needs) {
    if (byKind(n) && byArea(n)) {
      const k = n.assignee ?? "none";
      counts.who.set(k, (counts.who.get(k) ?? 0) + 1);
      counts.who.set("all", (counts.who.get("all") ?? 0) + 1);
    }
    if (byWho(n) && byArea(n)) counts.kind.set(changeOf(n), (counts.kind.get(changeOf(n)) ?? 0) + 1);
    if (byWho(n) && byKind(n)) counts.area.set(area(n), (counts.area.get(area(n)) ?? 0) + 1);
  }
  if (ctx.viewer) counts.who.set("me", counts.who.get(ctx.viewer) ?? 0);

  const kept = needs.filter((n) => byWho(n) && byKind(n) && byArea(n)).sort(COMPARE[view.order]);
  const keyOf = (n: N): [string, string] =>
    view.group === "area" ? [area(n), ctx.areaName(n.projectId)]
    : view.group === "kind" ? [changeOf(n), DECISION_CHANGE_LABEL[changeOf(n)]]
    : view.group === "who" ? (n.assignee ? [n.assignee, ctx.personName(n.assignee)] : ["none", "Unassigned"])
    : ["all", ""];
  const sections = new Map<string, InboxSection<N>>();
  for (const n of kept) {
    const [key, label] = keyOf(n);
    const s = sections.get(key) ?? { key, label, needs: [] };
    s.needs.push(n);
    sections.set(key, s);
  }
  const list = [...sections.values()];
  return { sections: list, order: list.flatMap((s) => s.needs), counts, total: needs.length };
}
