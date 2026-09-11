// The queue's grouping (docs/architecture/decisions-as-documents.md D5): a
// stack first (an ordered checklist one person clears in one sitting), then
// the rows a role holds under a grant ("with a lead", collapsed: a person
// need not read them unless they want to), then everything else by scope.
//
// Pure so the order is testable: the queue's order silently becomes the
// reader's priorities, and a grouping that shifts under them is unusable.
import type { SessionDecisionItem, DecisionStackItem } from "../store/inboxStore";

export type DecisionGroup =
  | { kind: "stack"; key: string; stack: DecisionStackItem; items: SessionDecisionItem[] }
  | { kind: "role"; key: string; roleId: string; items: SessionDecisionItem[] }
  | { kind: "scope"; key: string; scopeKey: string; items: SessionDecisionItem[] };

// The scope a decision files under when it is in no stack and no role holds
// it: the task's project, else its plan, else the asking role, else the
// session it came from ("session:<conversation id>").
export function decisionScopeKey(d: Pick<SessionDecisionItem, "scope_keys" | "conversation_id">): string {
  const keys = d.scope_keys ?? [];
  const pick = (prefix: string) => keys.find((k) => k.startsWith(prefix));
  return pick("project:") ?? pick("plan:") ?? pick("role:") ?? `session:${d.conversation_id}`;
}

function oldestFirst(a: SessionDecisionItem, b: SessionDecisionItem): number {
  // A blocking ask parks its session; it outranks an advisory one of the same age class.
  return Number(b.blocking) - Number(a.blocking) || a.created_at - b.created_at;
}

export function groupDecisions(
  pending: SessionDecisionItem[],
  stacks: Record<string, DecisionStackItem> | DecisionStackItem[],
): DecisionGroup[] {
  const stackById = new Map<string, DecisionStackItem>();
  for (const s of Array.isArray(stacks) ? stacks : Object.values(stacks)) stackById.set(s._id, s);

  const inStack = new Map<string, SessionDecisionItem[]>();
  const byRole = new Map<string, SessionDecisionItem[]>();
  const byScope = new Map<string, SessionDecisionItem[]>();
  for (const d of pending) {
    if (d.status !== "pending") continue;
    if (d.stack_id && stackById.has(d.stack_id)) {
      inStack.set(d.stack_id, [...(inStack.get(d.stack_id) ?? []), d]);
    } else if (d.holder?.kind === "role") {
      byRole.set(d.holder.id, [...(byRole.get(d.holder.id) ?? []), d]);
    } else {
      const key = decisionScopeKey(d);
      byScope.set(key, [...(byScope.get(key) ?? []), d]);
    }
  }

  const out: DecisionGroup[] = [];
  // Stacks in the order the server lists them (open first, newest first);
  // members in the stack's own order, unknown members last by age.
  for (const stack of stackById.values()) {
    const items = inStack.get(stack._id);
    if (!items?.length) continue;
    const order = new Map(stack.decision_ids.map((id, i) => [id, i]));
    items.sort((a, b) => (order.get(a._id) ?? 1e9) - (order.get(b._id) ?? 1e9) || oldestFirst(a, b));
    out.push({ kind: "stack", key: `stack:${stack._id}`, stack, items });
  }
  // Scope groups: the one with the oldest blocking ask first, so the order
  // is the same monotone age rule the flat queue uses.
  const scopeGroups = Array.from(byScope.entries()).map(([scopeKey, items]) => {
    items.sort(oldestFirst);
    return { kind: "scope" as const, key: `scope:${scopeKey}`, scopeKey, items };
  });
  scopeGroups.sort((a, b) => oldestFirst(a.items[0], b.items[0]));
  out.push(...scopeGroups);
  // Role-held rows last and collapsed: a lead will answer them.
  for (const [roleId, items] of byRole) {
    items.sort(oldestFirst);
    out.push({ kind: "role", key: `role:${roleId}`, roleId, items });
  }
  return out;
}

// The stack checklist's cursor: the first pending member, or the one after
// the given position, wrapping. Keys 1 to 9 answer the CURRENT member's
// options; next / previous move the cursor.
export function stackCursor(memberIds: string[], pendingIds: Set<string>, current: string | null, dir: 0 | 1 | -1): string | null {
  const order = memberIds.filter((id) => pendingIds.has(id));
  if (order.length === 0) return null;
  const i = current ? order.indexOf(current) : -1;
  if (dir === 0) return i >= 0 ? order[i] : order[0];
  if (i < 0) return dir === 1 ? order[0] : order[order.length - 1];
  return order[(i + dir + order.length) % order.length];
}

// Advisory members with a declared default: the ones "answer all defaults"
// resolves. Blocking members never auto answer (D5).
export function advisoryDefaults(items: SessionDecisionItem[]): Array<{ id: string; index: number }> {
  return items
    .filter((d) => d.status === "pending" && !d.blocking && d.default_option !== undefined)
    .map((d) => ({ id: d._id, index: d.default_option as number }));
}
