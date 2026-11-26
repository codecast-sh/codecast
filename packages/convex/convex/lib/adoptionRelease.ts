// A close of a lead adopts the spawned children it leaves running, stamped
// with the close's own stamp (shared closeLeavesStanding), which the lead
// keeps as inbox_closed_at. The adoption lasts only as long as that close:
// whatever clears the lead's dismissed stamp (a restore, a message that wakes
// it, a trigger, a resume on another machine) or stamps it anew (a kill of
// the closed lead) clears the adoptions carrying it, so the children nest
// under the lead again.
// Watching the write itself, here in the db wrapper (functions.ts), covers
// every path that brings a lead back, whichever mutation it is.
// The adoption stores the close's stamp rather than being derived when read:
// deriving it would join every inbox read to its lead's close state.
import { adoptedByClose } from "@codecast/shared/contracts/closeCascade";
import { nestedGroupOf } from "./closeAside";

/** Clear the adoptions the close stamped `stamp` gave the lead's children:
 *  the same group, the same window, the close's cascade adopted from
 *  (nestedGroupOf). */
export async function releaseCloseAdoptions(db: any, leadId: any, stamp: number | null | undefined): Promise<void> {
  if (stamp == null) return;
  for (const kid of await nestedGroupOf({ db }, { _id: leadId })) {
    if (adoptedByClose(kid, stamp)) await db.patch(kid._id, { inbox_adopted_at: undefined });
  }
}

// The write ends the close the lead's inbox_closed_at names: the row is still
// in that close (closed by it, or set aside by it) and not killed, and its
// dismissal is cleared or stamped anew, or a kill retires it. Only the first
// write that ends it releases: a kill's second write (applyHideTransition's
// kill stamp) and any later dismissal of a lead closed long ago find the row
// no longer in that close, so they read nothing.
// A machine wake turning the close into its hidden stash (closeWakeFields,
// the stash stamped with the close) keeps it: the lead is still out of sight.
function endsClose(before: any, fields: any): boolean {
  const closedAt = before.inbox_closed_at;
  if (closedAt == null || before.inbox_killed_at) return false;
  if (before.inbox_dismissed_at !== closedAt && before.inbox_stashed_at !== closedAt) return false;
  if (!!fields.inbox_killed_at && !before.inbox_killed_at) return true;
  const stashAfter = "inbox_stashed_at" in fields ? fields.inbox_stashed_at : before.inbox_stashed_at;
  if (stashAfter === closedAt) return false;
  if ("inbox_dismissed_at" in fields && fields.inbox_dismissed_at !== before.inbox_dismissed_at) return true;
  return "inbox_stashed_at" in fields && fields.inbox_stashed_at == null && before.inbox_stashed_at === closedAt;
}

export function makeAdoptionReleaseDb(db: any, rawDb: any): any {
  if (typeof rawDb?.normalizeId !== "function") return db;
  return {
    ...db,
    get: (...args: any[]) => db.get(...args),
    query: (...args: any[]) => db.query(...args),
    normalizeId: (...args: any[]) => db.normalizeId(...args),
    system: db.system,
    insert: (...args: any[]) => db.insert(...args),
    replace: (...args: any[]) => db.replace(...args),
    delete: (...args: any[]) => db.delete(...args),
    async patch(id: any, fields: any) {
      const touches = !!fields && ("inbox_dismissed_at" in fields || "inbox_stashed_at" in fields || !!fields.inbox_killed_at) && !!rawDb.normalizeId("conversations", String(id));
      const before = touches ? await rawDb.get(id) : null;
      const res = await db.patch(id, fields);
      if (before && endsClose(before, fields)) await releaseCloseAdoptions(db, before._id, before.inbox_closed_at);
      return res;
    },
  };
}
