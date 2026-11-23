// A session's owners and who drives, as one pure model. The convex owner
// mutations and the web store's applySessionOwners both run these rules, so
// what the store paints before the server answers is what the server answers:
// the store holds those fields until the answer matches, and a guess that
// never matches would hold them forever.
//
// The facts are the conversation's, as stored: its owner rows, the author and
// runner (whose human is the owner while there are no rows), the role it is
// filed under and whether a role started it, the person who took the wheel,
// and the primary-owner cache.

import { roleDrives, startedByRole } from "./inboxProjection";

export type OwnerRowFact = { user_id: string; added_at: number; added_by?: string; seen_at?: number; note?: string };

export type OwnersFacts = {
  rows: OwnerRowFact[];
  author_id: string | null;
  runner_id: string;
  /** Which of the people named here are agent accounts (never owners). */
  bots: string[];
  role_id: string | null;
  /** conversations.role_started: a role started it, so no person did. */
  role_started: boolean;
  /** conversations.standing_role_id: it is a role's own session. */
  standing_role_id: string | null;
  driver_user_id: string | null;
  /** conversations.owner_user_id: the primary owner cache. */
  primary_id: string | null;
};

export type SessionDriverFact = { kind: "role"; role_id: string } | { kind: "user"; user_id: string };
export type DriverChange = { kind: "role" } | { kind: "user"; user_id: string } | { kind: "none" };

export type OwnersChangeInput = {
  add?: string[];
  remove?: string[];
  /** Rows put back as they were (an undo of a remove): their order returns. */
  restore?: OwnerRowFact[];
  role?: string | null;
  driver?: DriverChange;
  /** The actor leaves; `move_to` names the account the session moves to first. */
  leave?: { move_to?: { runner_id: string; runner_is_bot: boolean } };
};

/**
 * The facts as a client holds them: the people from an owners read
 * (sessionOwnership.listOwners: `owners`, where a starter with no row is
 * `implicit`, plus `runner`, `author_id`, `bots` and `role_started`), and the
 * role, the driver and the primary from the session row. The web store paints a Save from
 * exactly this, so a server test can prove the read is enough.
 */
export function ownersFactsFromRead(read: any, sessionRow: any): OwnersFacts {
  return {
    rows: ((read?.owners ?? []) as any[]).filter((o) => !o.implicit).map((o) => ({ user_id: String(o.user_id), added_at: Number(o.added_at ?? 0) })),
    author_id: read?.author_id ? String(read.author_id) : null,
    runner_id: String(read?.runner?.user_id ?? sessionRow?.user_id ?? ""),
    bots: ((read?.bots ?? []) as unknown[]).map(String),
    role_id: sessionRow?.org_role_id ? String(sessionRow.org_role_id) : null,
    role_started: !!read?.role_started,
    standing_role_id: sessionRow?.standing_role_id ? String(sessionRow.standing_role_id) : null,
    driver_user_id: sessionRow?.driver_user_id ? String(sessionRow.driver_user_id) : null,
    primary_id: sessionRow?.owner_user_id ? String(sessionRow.owner_user_id) : null,
  };
}

/** Rows in the order they were added (stable for equal stamps). */
export function sortedRows(rows: OwnerRowFact[]): OwnerRowFact[] {
  return rows.map((r, i) => ({ r, i })).sort((a, b) => a.r.added_at - b.r.added_at || a.i - b.i).map(({ r }) => r);
}

/** The person who started it: the author, else the runner, never an agent,
 *  and nobody when a role started it. */
export function starterOf(f: Pick<OwnersFacts, "author_id" | "runner_id" | "bots" | "role_id" | "role_started" | "standing_role_id">): string | null {
  if (startedByRole(roleFactsOf(f))) return null;
  for (const id of [f.author_id, f.runner_id]) if (id && !f.bots.includes(id)) return id;
  return null;
}

/** The owners as the session shows them: its rows in the order added, else
 *  its starter, who owns it before any row exists. */
export function listedOwnerIds(f: OwnersFacts): string[] {
  if (f.rows.length) return sortedRows(f.rows).map((r) => r.user_id);
  const starter = starterOf(f);
  return starter ? [starter] : [];
}

/** Who drives, ONE rule: the filed role unless a person took the wheel
 *  (roleDrives), else that person while they own it, else the primary owner,
 *  else the first owner. */
export function driverOf(f: Pick<OwnersFacts, "role_id" | "driver_user_id" | "primary_id">, ownerIds: string[]): SessionDriverFact | null {
  if (f.role_id && roleDrives({ org_role_id: f.role_id, driver_user_id: f.driver_user_id })) return { kind: "role", role_id: f.role_id };
  if (f.driver_user_id && ownerIds.includes(f.driver_user_id)) return { kind: "user", user_id: f.driver_user_id };
  const primary = f.primary_id && ownerIds.includes(f.primary_id) ? f.primary_id : ownerIds[0];
  return primary ? { kind: "user", user_id: primary } : null;
}

/** The primary owner cache after rows change: the preferred person when they
 *  own it, else the first added (syncPrimaryOwnerCache). */
export function primaryAfter(rows: OwnerRowFact[], preferred?: string | null): string | null {
  const ids = sortedRows(rows).map((r) => r.user_id);
  return (preferred && ids.includes(preferred) ? preferred : ids[0]) ?? null;
}

/** Adding people never moves the wheel to them, though the primary follows
 *  the person added: a driver nobody chose is pinned to whoever drove. */
export function pinnedDriverAfterAdd(before: OwnersFacts, after: OwnersFacts): string | null {
  if (after.driver_user_id) return after.driver_user_id;
  const was = driverOf(before, listedOwnerIds(before));
  if (was?.kind !== "user") return null;
  const ids = listedOwnerIds(after);
  const now = driverOf(after, ids);
  return ids.includes(was.user_id) && !(now?.kind === "user" && now.user_id === was.user_id) ? was.user_id : null;
}

/**
 * The facts after a person's own message into the session: an owner, or the
 * account that runs it, who does not drive takes the wheel, and the role that
 * drove (or the person who did) waits. The runner becomes an owner as it takes
 * it, so a run a role started stays in the taker's inbox (and the role's
 * hands under it nest there). The primary owner stays who it was. Null when nothing changes: the sender already
 * drives, may not drive, or the session is a role's own.
 */
export function takeOverBySend(f: OwnersFacts, sender: string, now: number): OwnersFacts | null {
  if (f.standing_role_id || f.bots.includes(sender)) return null;
  const ids = listedOwnerIds(f);
  if (!ids.includes(sender) && sender !== f.runner_id) return null;
  const driver = driverOf(f, ids);
  if (driver?.kind === "user" && driver.user_id === sender) return null;
  const added = ids.includes(sender) ? f : applyOwnersChangeTo(f, { add: [sender] }, { actor: sender, now });
  // Taking the wheel changes who drives, never the primary owner.
  return { ...added, primary_id: primaryAfter(added.rows, f.primary_id ?? ids[0]), driver_user_id: sender };
}

/** Owner rows with `removed` taken out, the driver handed back when it was one of them. */
function withoutPeople(f: OwnersFacts, removed: string[]): OwnersFacts {
  const rows = f.rows.filter((r) => !removed.includes(r.user_id));
  if (rows.length === f.rows.length) return f;
  return {
    ...f,
    rows,
    driver_user_id: f.driver_user_id && removed.includes(f.driver_user_id) ? null : f.driver_user_id,
    primary_id: primaryAfter(rows),
  };
}

/** The account that runs it, when it is a person: who owns a session nobody else does. */
export function humanRunnerOf(f: Pick<OwnersFacts, "runner_id" | "bots">): string | null {
  return f.bots.includes(f.runner_id) ? null : f.runner_id;
}

/** Taking yourself out is a leave, whichever way the change says it. */
export function isLeave(change: { leave?: unknown; remove?: string[] }, actor: string): boolean {
  return !!change.leave || (change.remove ?? []).includes(actor);
}

/** Whether a leave may stand: someone other than the leaver still owns the
 *  session, or a role started it, which with no person left is simply the
 *  role's again (the driver cleared, the role drives). */
export function leaveStands(after: OwnersFacts, actor: string): boolean {
  return startedByRole(roleFactsOf(after)) || listedOwnerIds(after).some((id) => id !== actor);
}

/** Who takes a row when a leave leaves nobody: the person whose account runs
 *  it, so the starter rule cannot hand it back to the leaver who started it.
 *  Nobody for a run a role started: with no person left it is the role's
 *  again, out of the runner's inbox as it was before anyone took it. */
export function runnerTakesLeftSession(after: OwnersFacts, actor: string): string | null {
  const runner = humanRunnerOf(after);
  return after.rows.length === 0 && runner && runner !== actor && !startedByRole(roleFactsOf(after)) ? runner : null;
}

/** A leave from a session that runs on the leaver's account moves it to
 *  another account first, unless a role started it: that run is the role's,
 *  wherever it runs. */
export function leaveMovesFirst(f: OwnersFacts, actor: string): boolean {
  return f.runner_id === actor && !startedByRole(roleFactsOf(f));
}

const roleFactsOf = (f: Pick<OwnersFacts, "role_id" | "role_started" | "standing_role_id">) => ({ org_role_id: f.role_id, role_started: f.role_started, standing_role_id: f.standing_role_id });

/**
 * The facts after one Save, in the order the server applies it: adds, then
 * restored rows, then the role, then removes, then the driver, then a leave.
 * `now` stamps new rows; their exact value only orders them after the rest.
 */
export function applyOwnersChangeTo(f: OwnersFacts, change: OwnersChangeInput, ctx: { actor: string; now: number }): OwnersFacts {
  let next = f;
  const add = (change.add ?? []).filter((id, i, all) => all.indexOf(id) === i);
  if (add.length) {
    const before = next;
    let rows = next.rows;
    // The starter owns a session before any row exists: an add writes their row first.
    const starter = starterOf(next);
    if (rows.length === 0 && starter && !add.includes(starter)) rows = [{ user_id: starter, added_at: ctx.now, added_by: starter }];
    const fresh = add.filter((id) => !rows.some((r) => r.user_id === id));
    rows = [...rows, ...fresh.map((id) => ({ user_id: id, added_at: ctx.now, added_by: ctx.actor }))];
    next = { ...next, rows, primary_id: primaryAfter(rows, add[add.length - 1]) };
    next = { ...next, driver_user_id: pinnedDriverAfterAdd(before, next) };
  }
  const restore = (change.restore ?? []).filter((r) => !next.rows.some((x) => x.user_id === r.user_id));
  if (restore.length) {
    const rows = [...next.rows, ...restore];
    next = { ...next, rows, primary_id: primaryAfter(rows) };
  }
  if (change.role !== undefined && change.role !== next.role_id) {
    next = { ...next, role_id: change.role, driver_user_id: change.role ? null : next.driver_user_id };
  }
  const remove = (change.remove ?? []).filter((id) => id !== ctx.actor);
  if (remove.length) next = withoutPeople(next, remove);
  if (change.driver) {
    next = { ...next, driver_user_id: change.driver.kind === "user" ? change.driver.user_id : null };
  }
  if (isLeave(change, ctx.actor)) {
    if (change.leave?.move_to) {
      const to = change.leave.move_to;
      if (to.runner_id !== next.runner_id) {
        // The move pins the author to the account it leaves, the first time it changes hands.
        next = { ...next, author_id: next.author_id ?? next.runner_id, runner_id: to.runner_id, bots: to.runner_is_bot ? [...next.bots, to.runner_id] : next.bots };
      }
    }
    next = withoutPeople(next, [ctx.actor]);
    if (next.driver_user_id === ctx.actor) next = { ...next, driver_user_id: null };
    const runner = runnerTakesLeftSession(next, ctx.actor);
    if (runner) {
      const rows = [{ user_id: runner, added_at: ctx.now, added_by: ctx.actor }];
      next = { ...next, rows, primary_id: runner };
    }
  }
  return next;
}
