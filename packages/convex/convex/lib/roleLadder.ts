// The reporting ladder of a role (sessionDecisions D2), a leaf: the session
// notifier reads the same person a decision reaches without importing the
// decision module's graph (lib/sessionNotify).
import type { Doc, Id } from "../_generated/dataModel";

export type Hop = { role_id: Id<"org_roles">; recommendation?: number; note?: string; at: number; passed_at?: number };

// The ladder (D2): the roles from the asker up to the first person. A paused
// or retired role is recorded as a skipped hop so the card can show the gap;
// only active roles may recommend, and only the first is told (routeFor).
export async function buildLadder(
  ctx: { db: any },
  startRole: Doc<"org_roles"> | null,
  now: number,
): Promise<{ hops: Hop[]; firstPersonId?: Id<"users">; activeRoles: Doc<"org_roles">[] }> {
  const hops: Hop[] = [];
  const activeRoles: Doc<"org_roles">[] = [];
  const seen = new Set<string>();
  let cur = startRole;
  let firstPersonId: Id<"users"> | undefined;
  while (cur && !seen.has(cur._id) && seen.size < 32) {
    seen.add(cur._id);
    if (cur.status === "active") {
      hops.push({ role_id: cur._id, at: now });
      activeRoles.push(cur);
    } else {
      hops.push({ role_id: cur._id, note: `skipped: ${cur.status}`, at: now });
    }
    if (cur.reports_to.kind === "user") {
      firstPersonId = cur.reports_to.user_id;
      break;
    }
    cur = await ctx.db.get(cur.reports_to.role_id);
  }
  return { hops, firstPersonId, activeRoles };
}

