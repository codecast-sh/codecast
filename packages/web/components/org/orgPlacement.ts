// Where the person put cards on the people chart. The tree layout
// (orgLayout) gives every card a default slot; a card the person dragged
// somewhere empty is PLACED: it leaves its parent's lane or stack (which
// closes up) and sits where it was dropped, stored relative to its parent
// card, so it moves when the parent does. Everything under it comes along.
// Stored per workspace in clientState.ui.org_placed: the same arrangement on
// every device. Pure.
import type { OrgLayoutEdge } from "./orgLayout";
import type { OrgTree } from "./orgTypes";

export type OrgSpot = { x: number; y: number };
export type OrgPlaced = Readonly<Record<string, OrgSpot>>;
export const NOT_PLACED: OrgPlaced = Object.freeze({});

export const workspaceKeyOf = (tree: Pick<OrgTree, "workspace">) => `${tree.workspace.kind}:${tree.workspace.id}`;

/** The edges that say who a card hangs under: the tree's own, never a cross
 *  link or a proposed move's second edge. */
const hangsUnder = (e: OrgLayoutEdge) => (e.kind === "tree" || e.kind === "stack" || (e.kind === "ghost" && !e.change_id)) && !e.faded;

/** Each card's parent card, by node id. */
export function parentsOf(edges: readonly OrgLayoutEdge[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const e of edges) if (hangsUnder(e) && !out.has(e.target)) out.set(e.target, e.source);
  return out;
}

/** Every card under each of `roots`, mapped to the root it hangs from (the roots themselves excluded). */
export function subtreesOf(edges: readonly OrgLayoutEdge[], roots: readonly string[]): Map<string, string> {
  const kids = new Map<string, string[]>();
  for (const e of edges) if (hangsUnder(e)) kids.set(e.source, [...(kids.get(e.source) ?? []), e.target]);
  const out = new Map<string, string>();
  const rootSet = new Set(roots);
  for (const r of roots) {
    const walk = [...(kids.get(r) ?? [])];
    while (walk.length) {
      const id = walk.pop()!;
      if (rootSet.has(id) || out.has(id)) continue;
      out.set(id, r);
      walk.push(...(kids.get(id) ?? []));
    }
  }
  return out;
}

/** The dragged cards whose own parent is not dragged too: each moves its branch once. */
export function dragRoots(edges: readonly OrgLayoutEdge[], dragged: readonly string[]): string[] {
  const parents = parentsOf(edges);
  const set = new Set(dragged);
  return dragged.filter((id) => {
    for (let p = parents.get(id); p; p = parents.get(p)) if (set.has(p)) return false;
    return true;
  });
}

/** The arrangement with these cards placed at these spots (relative to their parents), in whole pixels. */
export function withPlaced(placed: OrgPlaced, spots: readonly ({ id: string } & OrgSpot)[]): Record<string, OrgSpot> {
  const next: Record<string, OrgSpot> = { ...placed };
  for (const p of spots) next[p.id] = { x: Math.round(p.x), y: Math.round(p.y) };
  return next;
}

/** The arrangement with these cards back in the tree (a card moved under a new parent starts in its slot there). */
export function withoutPlaced(placed: OrgPlaced, ids: readonly string[]): Record<string, OrgSpot> {
  const next: Record<string, OrgSpot> = { ...placed };
  for (const id of ids) delete next[id];
  return next;
}
