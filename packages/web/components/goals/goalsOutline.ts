// The Goals document's tree edits, pure: where a goal may go, the writes a
// move becomes, and the projects a goal lists in the owner's order. The
// document calls these and hands each write to the store's actions, so the
// rules are tested here and the page only says which gesture happened.
//
// The tree has one level of nesting (convex/initiatives.ts requireParent): a
// goal under another is never a parent, and a goal with goals under it never
// moves under one. Siblings read in `position` order (lib/initiatives
// byListOrder); a move renumbers the siblings it lands among and writes only
// the positions that changed.
import type { InitiativeRow } from "@codecast/shared/contracts/initiative";
import type { DocGoal, DocProject } from "../company/companyModel";

/** Room between two hand-set positions, so a later move rarely renumbers more than it must. */
const STEP = 1000;

export type PositionWrite = { id: string; position: number };

/** The positions that put `movedId` before `beforeId` (or last, for null)
 *  among `siblings`, given in the order they read now. Only changed rows. */
export function reorderWrites(siblings: readonly Pick<InitiativeRow, "_id" | "position">[], movedId: string, beforeId: string | null): PositionWrite[] {
  const rest = siblings.filter((s) => s._id !== movedId);
  const at = beforeId ? rest.findIndex((s) => s._id === beforeId) : -1;
  const moved = siblings.find((s) => s._id === movedId) ?? { _id: movedId, position: undefined };
  const next = at < 0 ? [...rest, moved] : [...rest.slice(0, at), moved, ...rest.slice(at)];
  return next.flatMap((s, i) => ((i + 1) * STEP === s.position ? [] : [{ id: s._id, position: (i + 1) * STEP }]));
}

const childrenOf = (all: readonly InitiativeRow[], id: string) => all.some((r) => r.parent_initiative_id === id);

/** Whether `goal` may sit under `parent` (null: the top level). */
export function canPlace(all: readonly InitiativeRow[], goal: InitiativeRow, parent: InitiativeRow | null): boolean {
  if (!parent) return true;
  if (parent._id === goal._id) return false;
  if (parent.parent_initiative_id) return false;
  return !childrenOf(all, goal._id);
}

export type GoalMove = { parent: string | null; position: PositionWrite[] };

/** Tab on a goal: under the sibling just above it, last among that goal's own. */
export function indentMove(all: readonly InitiativeRow[], siblings: readonly InitiativeRow[], goal: InitiativeRow): GoalMove | null {
  const i = siblings.findIndex((s) => s._id === goal._id);
  const above = i > 0 ? siblings[i - 1] : null;
  if (!above || !canPlace(all, goal, above)) return null;
  const kids = all.filter((r) => r.parent_initiative_id === above._id);
  return { parent: above._id, position: reorderWrites([...kids, goal], goal._id, null) };
}

/** Shift+Tab on a goal: out to its parent's level, right after its parent. */
export function outdentMove(all: readonly InitiativeRow[], parentSiblings: readonly InitiativeRow[], goal: InitiativeRow): GoalMove | null {
  const parentId = goal.parent_initiative_id;
  if (!parentId) return null;
  const parent = all.find((r) => r._id === parentId);
  const grand = parent?.parent_initiative_id ? all.find((r) => r._id === parent.parent_initiative_id) ?? null : null;
  const i = parentSiblings.findIndex((s) => s._id === parentId);
  const after = i >= 0 ? parentSiblings[i + 1]?._id ?? null : null;
  return { parent: grand?._id ?? null, position: reorderWrites([...parentSiblings, goal], goal._id, after) };
}

/** A position for a goal added right after `afterId` among `siblings` (last for null), and any renumbering it needs. */
export function insertAfterWrites(siblings: readonly Pick<InitiativeRow, "_id" | "position">[], newId: string, afterId: string | null): PositionWrite[] {
  const i = afterId ? siblings.findIndex((s) => s._id === afterId) : -1;
  const before = i >= 0 ? siblings[i + 1]?._id ?? null : null;
  return reorderWrites([...siblings, { _id: newId, position: undefined }], newId, before);
}

/** What a goal lists as carrying it, in the owner's order: the projects it is
 *  the nearest goal for, then those it shares with a goal above them (`under`
 *  names where they are listed too); a proposal's projects last. */
export function carriedProjects(goal: Pick<DocGoal, "projects" | "refs">, projectIds: readonly string[]): { project: DocProject; under?: string }[] {
  const at = (p: DocProject) => { const i = projectIds.indexOf(p.id); return p.ghost || i < 0 ? Infinity : i; };
  return [...goal.projects.map((project) => ({ project })), ...goal.refs.map((r) => ({ project: r.project, under: r.under }))]
    .sort((a, b) => at(a.project) - at(b.project));
}

/** A project moved to sit before `beforeId` in a goal's list (last for null). */
export function reorderedProjects(ids: readonly string[], projectId: string, beforeId: string | null): string[] {
  const rest = ids.filter((id) => id !== projectId);
  const at = beforeId ? rest.indexOf(beforeId) : -1;
  return at < 0 ? [...rest, projectId] : [...rest.slice(0, at), projectId, ...rest.slice(at)];
}
