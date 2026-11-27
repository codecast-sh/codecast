// The children the inbox read draws on their parent's card under the owners
// model (conversations.ts enrichInboxSessionRow, computeInboxSessions, the
// crawl and byIds): which children a listed row reads, which of them ride the
// card, and the owner fields such a child row carries.
import type { Id } from "../_generated/dataModel";
import { ridesParentCard } from "@codecast/shared/contracts";
import { isAdoptedChild } from "../inboxFilters";
import { inboxOwnersOf } from "./inboxOwners";

// The children a listed row's read takes (newest by creation), and the cap on
// the adopted workers it reads past them. The web nest keeps the same set
// (store ownedChildrenOf).
export const CHILDREN_HORIZON = 20;
const ADOPTED_CHILDREN_CAP = 50;

// A row's children page, plus the sessions a person dragged under it
// (adopted_at): those are on its card however many newer children it has, so
// past a full page they are one more read. A read that never draws children on
// a card skips it (skipAdopted).
export async function withAdoptedChildren(ctx: any, parentId: Id<"conversations">, children: any[], skipAdopted: boolean): Promise<any[]> {
  if (skipAdopted || children.length < CHILDREN_HORIZON) return children;
  const adopted = await ctx.db
    .query("conversations")
    .withIndex("by_parent_adopted", (q: any) => q.eq("parent_conversation_id", parentId).gte("adopted_at", 0))
    .order("desc")
    .take(ADOPTED_CHILDREN_CAP);
  const seen = new Set(children.map((c: any) => c._id.toString()));
  return [...children, ...adopted.filter((c: any) => !seen.has(c._id.toString()))];
}

// A child drawn on its parent's card, in the slim child row: its parent still
// owns it (no role took it, nobody released it) and it is none of the viewer's
// own inbox rows. An owner seat or a wait escalated to the viewer makes it one,
// which the scan lists in the full row; released and role-owned children are
// seated by their own windows. Every feeder of the row (the inbox read, the
// crawl, byIds) asks this one rule, the shared ridesParentCard the web nest
// asks too, so the row is written and drawn one way whichever delivered it.
export function nestedOnParentCard(child: any, viewerId: Id<"users">, myOwnerRow: any | null): boolean {
  return ridesParentCard({ ...child, owners_model: true, implicit_owner: null, owned_by_me: !!myOwnerRow, owner_session_id: child.parent_conversation_id }, viewerId);
}

// The owners fields of such a child (inboxOwnerRowFields' shape), read off the
// child alone: its parent owns it, so it has no implicit owner and costs no
// owner read.
export function parentOwnedChildFields(child: any, parentId: Id<"conversations">): Record<string, unknown> {
  return {
    owners_model: true,
    implicit_owner: null,
    owner_session_id: parentId.toString(),
    role_started: child.role_started ?? null,
    owners_changed_at: child.owners_changed_at ?? null,
    parent_released_at: null,
    adopted_at: child.adopted_at ?? null,
    wait_up_at: child.wait_up_at ?? null,
    wait_up_count: child.wait_up_count ?? null,
    wait_up_person: child.wait_up_person?.toString() ?? null,
    needs_input_notified_key: child.needs_input_notified_key ?? null,
  };
}

// The row is one the inbox read sends as a child on its parent's card: a
// subagent child (enrichInboxSessionRow's test, adopted ones standing alone)
// under the owners model, whose parent is alive to own it, and
// nestedOnParentCard. The owner fields are the full row's own read, memoized,
// so asking costs nothing the full row would not.
export async function sentOnParentCard(ctx: any, conv: any, userId: Id<"users">, myOwnerRow: any | null): Promise<boolean> {
  if (!conv.parent_conversation_id || !(conv.is_subagent || !conv.parent_message_uuid) || isAdoptedChild(conv)) return false;
  if (!nestedOnParentCard(conv, userId, myOwnerRow)) return false;
  return !!(await inboxOwnersOf(ctx, conv))?.owner_session_id;
}
