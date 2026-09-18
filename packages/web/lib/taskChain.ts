// The reporting chain, as the task board draws it (org-roles-run-work.md R5).
//
// Grouping by chain answers "whose work is this, all the way up": a person's
// group holds their own tasks, and nested under it sits one group per role
// that reports to them, with the roles under those nested again. The chain is
// read from the org tree (`reports_to`) at render and never stored on a task,
// so moving a role on the chart moves its tasks on the board in the same tick.
//
// Who heads a chain and which roles sit in it is the shared contract's
// (@codecast/shared/contracts/orgAssignee, which the server and the CLI read
// too). This file adds only the DRAW order: parents directly above their own
// children, each with a depth. Pure data, no React; lib/taskGrouping's chain
// axis draws what this orders.
import type { ChainRole } from "@codecast/shared/contracts/orgAssignee";

/** One group in chain order. `depth` 0 is the top of a chain. */
export type ChainNode = { key: string; depth: number };

/** Who a role answers to, as a group key: a person's id, a role's id, or null
 *  when the role above it is not in the tree (it then heads its own chain). */
function parentKeyOf(role: ChainRole, roleById: Map<string, ChainRole>): string | null {
  const up = role.reports_to;
  if (!up) return null;
  if (up.kind === "user") return String(up.user_id);
  return roleById.has(String(up.role_id)) ? String(up.role_id) : null;
}

/**
 * Order assignee keys by reporting chain.
 *
 * `keys` are the assignees that hold tasks (people and roles, as ids). The
 * result adds every person and role ABOVE one of them, even with no tasks of
 * their own, because a nested group with nothing over it cannot be read: a
 * founder whose only work is delegated still heads their chain.
 *
 * Tops sort the viewer first, then by name; the roles under a parent sort by
 * name. A key the tree does not know (a person outside it, a role since
 * removed) heads its own chain. Roles that report to each other in a loop are
 * bad data the chart refuses to draw; here the loop is cut where it closes, so
 * every role in it stays on the board under a top.
 */
export function arrangeChain(
  keys: string[],
  roles: readonly ChainRole[],
  opts: { meId?: string | null; nameOf: (key: string) => string },
): ChainNode[] {
  const roleById = new Map(roles.map((r) => [String(r._id), r]));

  const parent = new Map<string, string | null>();
  for (const start of keys) {
    let key: string | null = start;
    const walked = new Set<string>();
    while (key && !walked.has(key)) {
      walked.add(key);
      const role = roleById.get(key);
      const up: string | null = role ? parentKeyOf(role, roleById) : null;
      parent.set(key, up);
      key = up;
    }
    if (key) parent.set(key, null);
  }

  const children = new Map<string, string[]>();
  const tops: string[] = [];
  for (const [key, up] of parent) {
    if (up === null) tops.push(key);
    else children.set(up, [...(children.get(up) ?? []), key]);
  }

  const byName = (a: string, b: string) => opts.nameOf(a).localeCompare(opts.nameOf(b)) || a.localeCompare(b);
  tops.sort((a, b) => {
    const mine = Number(b === opts.meId) - Number(a === opts.meId);
    return mine !== 0 ? mine : byName(a, b);
  });

  const out: ChainNode[] = [];
  const emit = (key: string, depth: number) => {
    out.push({ key, depth });
    for (const child of (children.get(key) ?? []).sort(byName)) emit(child, depth + 1);
  };
  for (const top of tops) emit(top, 0);
  return out;
}
