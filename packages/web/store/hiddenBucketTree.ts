import { nestParentIdOf } from "@codecast/convex/convex/ccAccountsShared";
import { inboxNestParentOf, type InboxSession } from "./inboxStore";

// A set aside bucket's rows as cards with their sub rows beneath, one level
// deep: each row nests under its outermost ancestor inside the bucket, and a
// row whose parent is outside the bucket is a card of its own. Every row lands
// exactly once, so the header count is the number of rows drawn.
export function hiddenBucketTree(items: InboxSession[]): { topLevel: InboxSession[]; subsByTop: Map<string, InboxSession[]> } {
  const byId = new Map(items.map((s) => [s._id, s]));
  const nestParentOf = inboxNestParentOf(items);
  // A parent cycle has no outermost ancestor; its rows stay cards.
  const topOf = (s: InboxSession) => {
    const seen = new Set([s._id]);
    let cur = s;
    for (let p = nestParentOf(cur); p && byId.has(p); p = nestParentOf(cur)) {
      if (seen.has(p)) return s;
      seen.add(p);
      cur = byId.get(p)!;
    }
    return cur;
  };
  const topLevel: InboxSession[] = [];
  const subsByTop = new Map<string, InboxSession[]>();
  for (const s of items) {
    const top = topOf(s);
    if (top === s) { topLevel.push(s); continue; }
    if (!subsByTop.has(top._id)) subsByTop.set(top._id, []);
    subsByTop.get(top._id)!.push(s);
  }
  for (const subs of subsByTop.values()) subs.sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0));
  return { topLevel, subsByTop };
}

// The ids "Kill all" sends so nothing in the bucket survives. A kill stamps
// only the killed row's direct children (nestParentIdOf, as hideSessionInDraft
// cascades), so a row is covered only when its direct parent is killed
// explicitly; every other row, a grandchild included, is killed itself.
export function killAllIds(items: InboxSession[]): string[] {
  const parentOf = new Map(items.map((s) => [s._id, nestParentIdOf(s)]));
  const explicit = new Map<string, boolean>();
  const isExplicit = (id: string): boolean => {
    const known = explicit.get(id);
    if (known !== undefined) return known;
    explicit.set(id, true); // a parent cycle resolves to killing the row itself
    const parent = parentOf.get(id);
    const result = !parent || !parentOf.has(parent) || !isExplicit(parent);
    explicit.set(id, result);
    return result;
  };
  return items.map((s) => s._id).filter(isExplicit);
}
