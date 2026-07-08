/**
 * Pure session-ownership routing — no Convex runtime imports, so it unit-tests
 * directly (see deviceRouting.test.ts). devices.ts wraps these with DB access.
 *
 * THE INVARIANT this module enforces: a REMOTE box (a Mac mini you explicitly
 * `cast remote move` sessions to) is NEVER auto-selected to own a session while
 * the user has any LOCAL device. Being online does not make the remote eligible —
 * a remote with no checkout for the project is a dead end (it refuses to resume),
 * so auto-routing to it strands the message. The remote owns a session ONLY
 * through an explicit move, or as the last resort for a user with no local
 * device at all.
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
 *   1. The conversation's existing owner, if still online (sticky ownership). This
 *      preserves an explicit "move to remote": a remote owner stays the owner.
 *   2. The online LOCAL device whose `local_project_roots` contain the project path
 *      — the machine that actually has the checkout (most-recently-seen wins ties).
 *   3. The most-recently-active online LOCAL device — the "from mobile, send it to
 *      the laptop I was last using" rule when there's no checkout hint.
 *   4. No local online: the sticky owner if it's local, else the most-recently-SEEN
 *      local device. The command/message queues until that Mac wakes — never leave
 *      the session unowned for the always-awake remote to adopt.
 *   5. The user has no local device at all (cloud-only): an online remote.
 *   6. null — nothing eligible. The caller leaves the command untargeted
 *      (broadcast) and the daemon-side guards arbitrate.
 */
export function pickOwnerDevice(
  devices: RoutableDevice[],
  opts: { projectPath?: string | null; gitRoot?: string | null; ownerDeviceId?: string | null },
  now: number,
): string | null {
  const online = devices.filter((d) => now - d.last_seen < DEVICE_ONLINE_MS);

  // 1. Sticky owner, if still online (may legitimately be the remote, via a move).
  if (opts.ownerDeviceId && online.some((d) => d.device_id === opts.ownerDeviceId)) {
    return opts.ownerDeviceId;
  }

  // From here only LOCAL devices are eligible to auto-own.
  const locals = devices.filter((d) => !d.is_remote);
  const onlineLocals = locals.filter((d) => now - d.last_seen < DEVICE_ONLINE_MS);

  // 2. Online local device that has the checkout.
  const paths = [opts.gitRoot, opts.projectPath].filter((p): p is string => !!p);
  if (paths.length > 0) {
    const matches = onlineLocals
      .filter((d) =>
        (d.local_project_roots ?? []).some((r) => paths.some((p) => pathUnderRoot(p, r))),
      )
      .sort((a, b) => b.last_seen - a.last_seen);
    if (matches.length > 0) return matches[0].device_id;
  }

  // 3. Most-recently-active online local device.
  if (onlineLocals.length > 0) {
    return [...onlineLocals].sort((a, b) => b.last_seen - a.last_seen)[0].device_id;
  }

  // 4. No local online — queue for one anyway. Prefer the sticky owner (don't
  //    ping-pong ownership of an existing conversation between sleeping Macs),
  //    else the local seen most recently.
  if (locals.length > 0) {
    if (opts.ownerDeviceId && locals.some((d) => d.device_id === opts.ownerDeviceId)) {
      return opts.ownerDeviceId;
    }
    return [...locals].sort((a, b) => b.last_seen - a.last_seen)[0].device_id;
  }

  // 5. Cloud-only user: an online remote is the only machine that can serve.
  const onlineRemotes = online.filter((d) => d.is_remote).sort((a, b) => b.last_seen - a.last_seen);
  return onlineRemotes[0]?.device_id ?? null;
}
