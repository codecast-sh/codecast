import { useSyncExternalStore } from "react";

// The decisions a decision page flips through with ‹ › and the arrow keys.
// A set the address names (`?set=sd-1,sd-2`, written by a message that names
// several) wins, so a shared link flips through the same ones; otherwise the
// Decisions list the page was opened from publishes its order here.

export const DECISION_SET_PARAM = "set";

let listOrder: readonly string[] = [];
const listeners = new Set<() => void>();
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};
const read = () => listOrder;

export function publishDecisionOrder(refs: readonly string[]): void {
  if (refs.length === listOrder.length && refs.every((r, i) => r === listOrder[i])) return;
  listOrder = refs;
  for (const l of listeners) l();
}

export function useDecisionListOrder(): readonly string[] {
  return useSyncExternalStore(subscribe, read, read);
}

export function parseDecisionSet(param: string | null | undefined): string[] {
  if (!param) return [];
  return [...new Set(param.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean))];
}

export function decisionSetHref(ref: string, set: readonly string[]): string {
  return set.length > 1 ? `/decisions/${ref}?${DECISION_SET_PARAM}=${set.join(",")}` : `/decisions/${ref}`;
}

/** Where a decision sits in a set, matched by short id or row id; null when it is not in it. */
export function setPosition(set: readonly string[], ids: readonly (string | undefined)[]): { at: number; prev: string | null; next: string | null } | null {
  const keys = ids.filter((x): x is string => !!x).map((x) => x.toLowerCase());
  const at = set.findIndex((r) => keys.includes(r.toLowerCase()));
  if (at < 0) return null;
  return { at, prev: at > 0 ? set[at - 1] : null, next: at < set.length - 1 ? set[at + 1] : null };
}

type ScopedNeed = { counted: boolean; kind: string; decisionRef: string | null; decisionId?: string | null };

/** The Line's old Decisions address (`view=foryou`) on the Decisions page. A decision it names opens; a line's or a
 *  flow's count (`needs`, already narrowed to that line or flow) opens exactly the decisions it counted, as a set to
 *  flip through; with nothing narrowed, the flows' decisions. */
export function flowDecisionsHref(sel: { who?: string | null; need?: string | null; decision?: string | null }, scoped: ReadonlyArray<ScopedNeed> | null = null): string {
  const open = [sel.need, sel.decision].find((r) => r && /^sd-\d+$/i.test(r));
  if (open) return `/decisions/${open.toLowerCase()}`;
  if (scoped) {
    const refs = [...new Set(scoped.filter((n) => n.counted && n.kind === "decision").map((n) => n.decisionRef ?? n.decisionId).filter((r): r is string => !!r))];
    if (refs.length) return decisionSetHref(refs[0], refs);
  }
  return `/decisions?${sel.who === "me" ? "" : "tab=team&"}source=flows`;
}

export type DecisionSetSource = "named" | "queue" | "list";
export type DecisionSlot = { key: string; at: number; src: DecisionSetSource };

/** Which set a decision page flips through, and where in it: the named set, else the set the pass is already on
 *  (`last`, the previous page's slot) when it holds the decision, so one pass keeps one count and total; else the
 *  viewer's queue (the sidebar's count) when it holds the decision, else the list's order when that does, else the
 *  queue. A decision that left its set (answered) keeps the slot it had. */
export function decisionNav(
  sets: Record<DecisionSetSource, readonly string[]>,
  ids: readonly (string | undefined)[],
  last: DecisionSlot | null,
): { src: DecisionSetSource; set: readonly string[]; at: number; prev: string | null; next: string | null; slot: DecisionSlot | null } {
  const key = ids.filter(Boolean).join("|");
  const kept = last?.key === key ? last : null;
  const src: DecisionSetSource = sets.named.length > 1 ? "named"
    : last && last.src !== "named" && setPosition(sets[last.src], ids) ? last.src
    : setPosition(sets.queue, ids) ? "queue"
    : setPosition(sets.list, ids) ? "list"
    : kept?.src ?? "queue";
  const set = sets[src];
  const pos = setPosition(set, ids);
  if (pos) return { src, set, ...pos, slot: { key, at: pos.at, src } };
  const at = kept ? Math.min(kept.at, set.length) : 0;
  return { src, set, at: -1, prev: at > 0 ? set[at - 1] : null, next: at < set.length ? set[at] : null, slot: kept };
}

// The slot a ‹ › step left from, handed to the page it lands on: a decision page may mount afresh for each decision,
// so the pass's set has to outlive the component that chose it.
let handoff: { to: string; slot: DecisionSlot } | null = null;

export function handDecisionSlot(to: string, slot: DecisionSlot | null): void {
  handoff = slot ? { to: to.toLowerCase(), slot } : null;
}

/** The slot handed to this decision by the step that opened it; null when it was opened some other way. */
export function claimDecisionSlot(ids: readonly (string | undefined)[]): DecisionSlot | null {
  return handoff && ids.some((x) => x?.toLowerCase() === handoff!.to) ? handoff.slot : null;
}
