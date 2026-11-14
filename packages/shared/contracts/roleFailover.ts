/**
 * A role's standing session failing over off a host that went quiet or
 * unhealthy while work waited for it (convex roleFailover.ts). One set of
 * words for the owner's notification, the role page on the web and the phone,
 * so the three never say different things about the same move.
 */

export type RoleFailoverReason = "offline" | "below_floor" | "freezing" | "pane_refused";

export type RoleFailoverHost = { device_id: string; label: string; user_id: string };

/** What org_roles.failover holds. `to` is absent when no always-on host could take it. */
export type RoleFailover = {
  at: number;
  reason: RoleFailoverReason;
  owner_user_id: string;
  from: RoleFailoverHost;
  to?: RoleFailoverHost;
  cross_user?: boolean;
};

/** Quiet this long, with work waiting, a standing session's host is taken
 *  to be down and the session moves. */
export const ROLE_FAILOVER_QUIET_MS = 60 * 60 * 1000;

/** The threshold as a reader says it: "1 hour", "90 min". */
const QUIET_WORDS = ROLE_FAILOVER_QUIET_MS % 3_600_000 === 0
  ? `${ROLE_FAILOVER_QUIET_MS / 3_600_000} hour${ROLE_FAILOVER_QUIET_MS === 3_600_000 ? "" : "s"}`
  : `${ROLE_FAILOVER_QUIET_MS / 60_000} min`;

const REASON_WORDS: Record<RoleFailoverReason, string> = {
  offline: `went offline for over ${QUIET_WORDS}`,
  below_floor: "runs a cast version below the floor",
  freezing: "kept freezing",
  pane_refused: "stopped taking input",
};

/** Why it moved, as a short phrase about the old host: "went offline for over 1 hour". */
export function roleFailoverReasonWords(reason: RoleFailoverReason): string {
  return REASON_WORDS[reason];
}

/** Who it now runs and bills under, for a move that changed the account, from
 *  the reader's side: "you" when the reader is the new runner. Null when the
 *  account did not change. */
export function roleFailoverBillsUnder(f: RoleFailover, viewerId: string | null, nameOf: (userId: string) => string): string | null {
  if (!f.cross_user || !f.to) return null;
  return f.to.user_id === viewerId ? "you" : nameOf(f.to.user_id);
}

/** The owner's one line. A move names from, to, why, and the account when it
 *  changed; no host names the old one and why nothing moved. */
export function roleFailoverLine(handle: string, f: RoleFailover, viewerId: string | null, nameOf: (userId: string) => string): string {
  const why = roleFailoverReasonWords(f.reason);
  if (!f.to) return `@${handle} is stuck: ${f.from.label} ${why} with work waiting, and there is no always-on machine to move it to.`;
  const under = roleFailoverBillsUnder(f, viewerId, nameOf);
  return `@${handle} moved from ${f.from.label} to ${f.to.label}: ${f.from.label} ${why} with work waiting.${under ? ` It now runs and bills under ${under}.` : ""}`;
}

/** A host quiet this long is still down: the sweep would move a session off
 *  it, so nothing moves one back onto it. */
export function roleHostQuiet(lastSeen: number, now: number): boolean {
  return now - lastSeen >= ROLE_FAILOVER_QUIET_MS;
}

/** A machine the viewer may start sessions on, as the move resolves it: one
 *  of their own (user_id is theirs), or a team machine they may use. */
export type MoveBackMachine = { device_id: string; user_id: string; last_seen: number };

/** Whether this viewer can move the role back to the host it left: `ok`; the
 *  host is theirs to use but still offline; or it is not a machine they may
 *  start sessions on, so only its own account can move it back. The server
 *  (roleFailover.moveBack) refuses the same two cases with moveBackRefusal. */
export type MoveBackState = "ok" | "offline" | "not_yours";

export function roleMoveBackState(f: RoleFailover, machines: readonly MoveBackMachine[], now: number): MoveBackState {
  const host = machines.find((m) => m.device_id === f.from.device_id && m.user_id === f.from.user_id);
  if (!host) return "not_yours";
  return roleHostQuiet(host.last_seen, now) ? "offline" : "ok";
}

/** The refusal for a move back this viewer cannot make, naming who can. */
export function moveBackRefusal(f: RoleFailover, state: Exclude<MoveBackState, "ok">, nameOf: (userId: string) => string): string {
  return state === "offline"
    ? `${f.from.label} is still offline`
    : `Only ${nameOf(f.from.user_id)} can move it back to ${f.from.label}`;
}
