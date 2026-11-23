// Who a session's agent reports to, and the line that tells it when that
// changes (org-staffing.md S11). It reports to whoever drives (shared
// driverOf): the role while it drives, else the person at the wheel. The org
// chart still files the session by its primary owner (owner_user_id), which
// follows the person last added; the agent works for its driver. A leaf below
// sessionOwnership, so the take-over on send (lib/sessionTakeOver) tells it too.

import type { Id } from "../_generated/dataModel";
import { listedOwnerIds } from "@codecast/shared/contracts/sessionOwners";
import { ownersFactsOf } from "../sessionOwners";
import { driverOf } from "./sessionOwnerRules";
import { personName, tellSession } from "./sessionTell";

export type ReportsTo =
  | { kind: "user"; user_id: Id<"users">; name: string }
  | { kind: "role"; role_id: Id<"org_roles">; short_id: string; handle: string; name: string };

// What the move changes for the agent: under a role, how to reach it; under a
// person, that their questions now go to them. `note` is written to the
// agent; a `handoff` note was written to the new owner (the ownership menu,
// `cast own`) and is quoted as theirs, so the agent does not read it as its
// own orders.
export function reportsToLine(to: ReportsTo, opts: { note?: string; handoff?: string } = {}): string {
  const head = to.kind === "role"
    ? `You now report to ${to.name} (@${to.handle}): what you need from a person goes to it first, and \`cast send @${to.handle}\` reaches it.`
    : `You now report to ${to.name}: your questions and decisions go to them.`;
  const note = opts.note?.trim();
  const handoff = opts.handoff?.trim();
  return [head, note, handoff && `Note handed to ${to.name} with this session: "${handoff}"`].filter(Boolean).join(" ");
}

// `read` is the doc read (a batch passes its memo, so a hundred sessions of
// one host read that host once); `row` is the conversation when the caller
// already holds it as it stands.
export async function reportsToOf(ctx: { db: any }, conversationId: Id<"conversations">, known: { read?: (id: any) => Promise<any>; row?: any } = {}): Promise<ReportsTo | null> {
  const read = known.read ?? ((id: any) => ctx.db.get(id));
  const row = known.row ?? await ctx.db.get(conversationId);
  if (!row) return null;
  // The primary cache is set exactly when owner rows exist
  // (syncPrimaryOwnerCache), so the rows are read only to check a driver who
  // is not the primary still owns it; with neither, its starter drives. A
  // takeover of a hundred sessions, which have no driver, reads no rows here.
  const driverId = row.driver_user_id ? String(row.driver_user_id) : null;
  const primary = row.owner_user_id ? String(row.owner_user_id) : null;
  const ownerIds = driverId && driverId !== primary
    ? listedOwnerIds(await ownersFactsOf(ctx, row, { getDoc: read }))
    : primary ? [primary] : listedOwnerIds(await ownersFactsOf(ctx, row, { rows: [], getDoc: read }));
  const driver = driverOf(row, ownerIds);
  if (driver?.kind === "role") {
    const role = await read(driver.role_id);
    if (role) return { kind: "role", role_id: role._id, short_id: role.short_id, handle: role.handle, name: role.name };
    return null;
  }
  const user = driver ? await read(driver.user_id) : null;
  return user ? { kind: "user", user_id: user._id, name: personName(user) } : null;
}

export const reportsToKey = (r: ReportsTo | null): string => !r ? "" : r.kind === "role" ? `role:${r.role_id}` : `user:${r.user_id}`;

/** After the wheel moved outside the reparent core (a take-over, Make
 *  driver): tell the agent once when whom it reports to changed. */
export async function tellReportsToChange(ctx: { db: any }, actorId: Id<"users">, conversationId: Id<"conversations">, before: ReportsTo | null, fromSession?: string): Promise<void> {
  const conversation = await ctx.db.get(conversationId);
  const after = conversation ? await reportsToOf(ctx, conversationId, { row: conversation }) : null;
  if (after && reportsToKey(after) !== reportsToKey(before)) {
    await tellSession(ctx, actorId, conversation, reportsToLine(after), fromSession, reportsToKey(after));
  }
}
