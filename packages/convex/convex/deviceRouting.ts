/**
 * Pure session-ownership routing — no Convex runtime imports, so it unit-tests
 * directly (see deviceRouting.test.ts). devices.ts wraps these with DB access.
 *
 * THE INVARIANT this module enforces: a REMOTE box (a Mac mini you explicitly
 * `cast remote move` sessions to) is NEVER auto-selected to own a session while
 * a LOCAL device could serve it. Being online does not make the remote eligible —
 * a remote with no checkout for the project is a dead end (it refuses to resume),
 * so auto-routing to it strands the message. The remote owns a session through an
 * explicit move or an explicit pick, because it demonstrably has the checkout, or
 * as the last resort for a user with no local device at all.
 *
 * When no local device is ONLINE, routing still targets the most-recently-seen
 * local one rather than returning null: the command/message queues until that Mac
 * wakes. An unowned session + untargeted command is what let the always-awake
 * remote adopt blank iOS sessions into its $HOME.
 */

/** A device is "online" if it heartbeated within this window. */
export const DEVICE_ONLINE_MS = 2 * 60 * 1000;

/** True if `p` is at or below a known project root (`root` or a child of it). */
export function pathUnderRoot(p: string, root: string): boolean {
  return p === root || p.startsWith(root.endsWith("/") ? root : root + "/");
}

/** Minimal device shape the routing decision needs (a subset of the `devices` row). */
export type RoutableDevice = {
  device_id: string;
  last_seen: number;
  is_remote?: boolean;
  local_project_roots?: string[];
};

/**
 * Decide which device should OWN (and therefore run) a session.
 *
 * Priority:
 *   1. The device the user explicitly picked (`targetDeviceId`), if online — a
 *      machine chosen by hand outranks every heuristic, remote included. An
 *      offline pick falls through instead of queueing: the rungs below route to a
 *      live machine that has the checkout.
 *   2. The conversation's existing owner, if still online (sticky ownership). This
 *      preserves an explicit "move to remote": a remote owner stays the owner.
 *   3. The online LOCAL device whose `local_project_roots` contain the project path
 *      — the machine that actually has the checkout (most-recently-seen wins ties).
 *   4. The most-recently-active online LOCAL device — the "from mobile, send it to
 *      the laptop I was last using" rule when there's no checkout hint.
 *   5. No local online, but an online REMOTE holds the checkout: it serves now
 *      rather than the work waiting on a sleeping Mac. The invariant only bars a
 *      remote that would be a dead end; a matching root proves it isn't one.
 *   6. No local online: the sticky owner if it's local, else the most-recently-SEEN
 *      local device. The command/message queues until that Mac wakes — never leave
 *      the session unowned for the always-awake remote to adopt.
 *   7. The user has no local device at all (cloud-only): an online remote.
 *   8. null — nothing eligible. The caller leaves the command untargeted
 *      (broadcast) and the daemon-side guards arbitrate.
 */
export function pickOwnerDevice(
  devices: RoutableDevice[],
  opts: {
    projectPath?: string | null;
    gitRoot?: string | null;
    ownerDeviceId?: string | null;
    targetDeviceId?: string | null;
  },
  now: number,
): string | null {
  const online = devices.filter((d) => now - d.last_seen < DEVICE_ONLINE_MS);

  // 1. Explicit pick, if online.
  if (opts.targetDeviceId && online.some((d) => d.device_id === opts.targetDeviceId)) {
    return opts.targetDeviceId;
  }

  // 2. Sticky owner, if still online (may legitimately be the remote, via a move).
  if (opts.ownerDeviceId && online.some((d) => d.device_id === opts.ownerDeviceId)) {
    return opts.ownerDeviceId;
  }

  // From here a LOCAL device always outranks a remote; a remote only auto-owns
  // when it provably has the checkout (rung 5) or nothing else exists (rung 7).
  const locals = devices.filter((d) => !d.is_remote);
  const onlineLocals = locals.filter((d) => now - d.last_seen < DEVICE_ONLINE_MS);

  const paths = [opts.gitRoot, opts.projectPath].filter((p): p is string => !!p);
  const hasCheckout = (d: RoutableDevice) =>
    (d.local_project_roots ?? []).some((r) => paths.some((p) => pathUnderRoot(p, r)));

  // 3. Online local device that has the checkout.
  if (paths.length > 0) {
    const matches = onlineLocals.filter(hasCheckout).sort((a, b) => b.last_seen - a.last_seen);
    if (matches.length > 0) return matches[0].device_id;
  }

  // 4. Most-recently-active online local device.
  if (onlineLocals.length > 0) {
    return [...onlineLocals].sort((a, b) => b.last_seen - a.last_seen)[0].device_id;
  }

  // 5. No local is online, so serve from an online remote that has the checkout
  //    rather than queue for a sleeping Mac. Requires a real root match — an
  //    unmatched remote is the dead end rule 6 exists to avoid.
  if (paths.length > 0) {
    const remoteMatches = online
      .filter((d) => d.is_remote && hasCheckout(d))
      .sort((a, b) => b.last_seen - a.last_seen);
    if (remoteMatches.length > 0) return remoteMatches[0].device_id;
  }

  // 6. No local online — queue for one anyway. Prefer the sticky owner (don't
  //    ping-pong ownership of an existing conversation between sleeping Macs),
  //    else the local seen most recently.
  if (locals.length > 0) {
    if (opts.ownerDeviceId && locals.some((d) => d.device_id === opts.ownerDeviceId)) {
      return opts.ownerDeviceId;
    }
    return [...locals].sort((a, b) => b.last_seen - a.last_seen)[0].device_id;
  }

  // 7. Cloud-only user: an online remote is the only machine that can serve.
  const onlineRemotes = online.filter((d) => d.is_remote).sort((a, b) => b.last_seen - a.last_seen);
  return onlineRemotes[0]?.device_id ?? null;
}
