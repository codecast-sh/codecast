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

export type ChainRole = {
  _id: unknown;
  status?: string;
  reports_to?: { kind: "user"; user_id: unknown } | { kind: "role"; role_id: unknown } | null;
};

/** Deeper than any real chart; also the guard against a cycle in bad data. */
export const MAX_CHAIN_DEPTH = 32;

/** The person at the top of a role's reporting chain, or null when the chain
 *  ends without one (a missing parent, a cycle). */
export function chainHeadOf(roleId: unknown, roles: readonly ChainRole[]): string | null {
  const byId = new Map(roles.map((r) => [String(r._id), r]));
  let cur = byId.get(String(roleId));
  for (let depth = 0; cur && depth < MAX_CHAIN_DEPTH; depth++) {
    const up = cur.reports_to;
    if (!up) return null;
    if (up.kind === "user") return String(up.user_id);
    cur = byId.get(String(up.role_id));
  }
  return null;
}

/** The live roles whose chain ends at `userId`, parents before children, so a
 *  caller that nests groups can render them in order. */
export function rolesInChainOf<R extends ChainRole>(userId: unknown, roles: readonly R[]): R[] {
  const live = roles.filter((r) => r.status !== "retired");
  const byId = new Map(live.map((x) => [String(x._id), x]));
  const depthOf = (r: ChainRole): number => {
    let d = 0;
    for (let cur: ChainRole | undefined = r; cur?.reports_to?.kind === "role" && d < MAX_CHAIN_DEPTH; d++) {
      cur = byId.get(String(cur.reports_to.role_id));
    }
    return d;
  };
  return live
    .filter((r) => chainHeadOf(r._id, live) === String(userId))
    .sort((a, b) => depthOf(a) - depthOf(b));
}

/** Every assignee value in a person's chain: the person, then each role under
 *  them. What `--chain me` filters on and what the Chain axis groups. */
export function chainAssignees(userId: unknown, roles: readonly ChainRole[]): string[] {
  return [String(userId), ...rolesInChainOf(userId, roles).map((r) => String(r._id))];
}
