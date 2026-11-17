// Settling a failover as an org intent: Move back (convex roleFailover.moveBack)
// or Keep here (roleFailover.keepHere, `keep`). Both take the line off the role
// (orgSlice.ts header), so the owner's line leaves the role in the same tick as
// the press, a stale org.tree push replays the removal, the echo is a tree
// with no failover (or a newer one), and a refusal puts the line back.
import type { RoleFailover } from "@codecast/shared/contracts/roleFailover";

export type MoveBackIntent = { kind: "moveBack"; id: string; role_id: string; handle: string; from: RoleFailover; keep?: true; at: number };
type Tree = { roles: Array<{ _id: string; handle: string; failover?: RoleFailover }> };

const roleOf = (tree: Tree | null | undefined, roleId: string) => tree?.roles.find((r) => r._id === roleId);

/** The intent for a press on Move back (or Keep here, `keep`), or null when the role has no move to settle. */
export function moveBackIntent(tree: Tree, roleId: string, id: string, keep?: boolean): MoveBackIntent | null {
  const role = roleOf(tree, roleId);
  return role?.failover?.to ? { kind: "moveBack", id, role_id: roleId, handle: role.handle, from: JSON.parse(JSON.stringify(role.failover)), ...(keep ? { keep: true as const } : {}), at: Date.now() } : null;
}

export function moveBackEchoed(tree: Tree, intent: MoveBackIntent): boolean {
  const role = roleOf(tree, intent.role_id);
  return !role || role.failover?.at !== intent.from.at;
}

export function applyMoveBack(tree: Tree, intent: MoveBackIntent): void {
  const role = roleOf(tree, intent.role_id);
  if (role?.failover?.at === intent.from.at) delete role.failover;
}

export function revertMoveBack(tree: Tree | null | undefined, intent: MoveBackIntent): void {
  const role = roleOf(tree, intent.role_id);
  if (role && !role.failover) role.failover = intent.from;
}
