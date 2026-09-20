// A role as a task's assignee (docs/architecture/org-roles-run-work.md R5).
// `tasks.assignee` holds a user's id or a role's id. This file is the ONE
// place that says what an assignee looks like once resolved and who sits at
// the top of a role's reporting chain, read by the server (tasks.ts
// enrichment and the chain filter), the CLI (`cast task ls --chain me`) and
// the web (lib/liveEntities resolveAssigneeInfo, the board's Chain axis).
//
// The resolved shape is flat on purpose. The store compares an assignee field
// by field to decide whether a row changed, and a nested object would differ
// by reference on every derive. A person carries no `kind`, so every row
// cached before roles could own tasks still reads as a person.
//
// Pure, generic over the caller's own role rows (a Convex doc, the web's
// OrgRole), and ids are compared as strings so an `Id<"org_roles">` and its
// string form agree.

import { avatarOf, type AvatarKey } from "./orgAvatars";

// What the field means (org-roles-run-work.md R7). A session once refused to
// ship a task because it was assigned to someone else; nothing had told it
// that. Every place the CLI shows an assignee to an agent says this sentence,
// so no model infers a permission from a name.
export const ASSIGNEE_MEANS = "An assignee is who answers for the task being done, never who may work on it: any session may work any task.";

export type PersonAssigneeInfo = { kind?: undefined; name: string; image?: string; github_username?: string };

export type RoleAssigneeInfo = {
  kind: "role";
  name: string;
  /** Without the "@". */
  handle: string;
  /** The face key (orgAvatars); a role has no image url. */
  avatar: AvatarKey;
  role_id: string;
  /** "or-N": what `/org/<id>` and the hover card open on. */
  role_short_id: string;
  /** A role has a face key, never an image url or a GitHub account. Declared
   *  so a caller that reads these off any assignee compiles, and draws
   *  initials until it learns to draw the face. */
  image?: undefined;
  github_username?: undefined;
};

export type AssigneeInfo = PersonAssigneeInfo | RoleAssigneeInfo;

export type AssigneeRole = {
  _id: unknown;
  short_id: string;
  name: string;
  handle: string;
  avatar?: string | null;
};

export function roleAssigneeInfo(role: AssigneeRole): RoleAssigneeInfo {
  return {
    kind: "role",
    name: role.name,
    handle: role.handle,
    avatar: avatarOf(role),
    role_id: String(role._id),
    role_short_id: role.short_id,
  };
}

export function isRoleAssignee(info: { kind?: string } | null | undefined): info is RoleAssigneeInfo {
  return info?.kind === "role";
}

/** Every field of either shape, so one comparison serves both. */
const ASSIGNEE_FIELDS = ["kind", "name", "image", "github_username", "handle", "avatar", "role_id", "role_short_id"] as const;

export function sameAssigneeInfo(a: AssigneeInfo | null | undefined, b: unknown): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return ASSIGNEE_FIELDS.every((f) => (a as any)[f] === (b as any)[f]);
}

// ── The reporting chain ──────────────────────────────────────────────────────
//
// Read from `reports_to`, never stored on a task: a reparent moves every task
// under the role to its new chain with no write to any task.
//
// ONE step function walks it everywhere: the server's `--chain me`, the
// board's Chain axis (web/lib/taskChain) and its "My reporting chain" filter.
// A retired role stays in the chain it reported to: retire hands its open
// tasks up that chain, and whatever it still holds (closed work, a task
// assigned before the hand-over) is read under the same person, never lost.

export type ChainRole = {
  _id: unknown;
  status?: string;
  reports_to?: { kind: "user"; user_id: unknown } | { kind: "role"; role_id: unknown } | null;
};

/** Deeper than any real chart; also the guard against a cycle in bad data. */
export const MAX_CHAIN_DEPTH = 32;

export type ChainParent = { kind: "user"; key: string } | { kind: "role"; key: string; role: ChainRole } | null;

/** One step up the chain: the person a role answers to, the role above it
 *  when that role is in `byId`, or null when the chain ends here (no parent
 *  set, or a parent role the caller's tree does not hold). */
export function chainParentOf(role: ChainRole, byId: ReadonlyMap<string, ChainRole>): ChainParent {
  const up = role.reports_to;
  if (!up) return null;
  if (up.kind === "user") return { kind: "user", key: String(up.user_id) };
  const parent = byId.get(String(up.role_id));
  return parent ? { kind: "role", key: String(parent._id), role: parent } : null;
}

export const chainIndex = (roles: readonly ChainRole[]): Map<string, ChainRole> => new Map(roles.map((r) => [String(r._id), r]));

/** The person at the top of a role's reporting chain, or null when the chain
 *  ends without one (a missing parent, a cycle). */
export function chainHeadOf(roleId: unknown, roles: readonly ChainRole[]): string | null {
  const byId = chainIndex(roles);
  let cur = byId.get(String(roleId));
  for (let depth = 0; cur && depth < MAX_CHAIN_DEPTH; depth++) {
    const up = chainParentOf(cur, byId);
    if (!up) return null;
    if (up.kind === "user") return up.key;
    cur = up.role;
  }
  return null;
}

/** The roles whose chain ends at `userId`, parents before children, so a
 *  caller that nests groups can render them in order. Retired roles included
 *  (see above). */
export function rolesInChainOf<R extends ChainRole>(userId: unknown, roles: readonly R[]): R[] {
  const byId = chainIndex(roles);
  const depthOf = (r: ChainRole): number => {
    let d = 0;
    for (let up = chainParentOf(r, byId); up?.kind === "role" && d < MAX_CHAIN_DEPTH; up = chainParentOf(up.role, byId)) d++;
    return d;
  };
  return roles
    .filter((r) => chainHeadOf(r._id, roles) === String(userId))
    .sort((a, b) => depthOf(a) - depthOf(b));
}

/** Every assignee value in a person's chain: the person, then each role under
 *  them. What `--chain me` filters on and what the Chain axis groups. */
export function chainAssignees(userId: unknown, roles: readonly ChainRole[]): string[] {
  return [String(userId), ...rolesInChainOf(userId, roles).map((r) => String(r._id))];
}
