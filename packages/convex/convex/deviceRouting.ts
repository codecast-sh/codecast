/**
 * Pure session-ownership routing — no Convex runtime imports, so it unit-tests
 * directly (see deviceRouting.test.ts). devices.ts wraps these with DB access.
 *
 * THE INVARIANT this module enforces: a REMOTE box (a Mac mini you explicitly
 * `cast remote move` sessions to) is NEVER auto-selected to own a session. Being
 * online does not make it eligible — a remote with no checkout for the project is
 * a dead end (it refuses to resume), so auto-routing to it strands the message.
 * The remote owns a session ONLY when it's already the sticky owner, which only
 * happens through an explicit move. Auto-routing always lands on a LOCAL device.
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
 *   4. null — no eligible local device online. The caller leaves the command
 *      untargeted (broadcast) and the daemon-side guards arbitrate.
 */
export function pickOwnerDevice(
  devices: RoutableDevice[],
  opts: { projectPath?: string | null; gitRoot?: string | null; ownerDeviceId?: string | null },
  now: number,
): string | null {
  const online = devices.filter((d) => now - d.last_seen < DEVICE_ONLINE_MS);
  if (online.length === 0) return null;

  // 1. Sticky owner, if still online (may legitimately be the remote, via a move).
  if (opts.ownerDeviceId && online.some((d) => d.device_id === opts.ownerDeviceId)) {
    return opts.ownerDeviceId;
  }

  // From here only LOCAL devices are eligible to auto-own.
  const local = online.filter((d) => !d.is_remote);
  if (local.length === 0) return null;

  // 2. Local device that has the checkout.
  const paths = [opts.gitRoot, opts.projectPath].filter((p): p is string => !!p);
  if (paths.length > 0) {
    const matches = local
      .filter((d) =>
        (d.local_project_roots ?? []).some((r) => paths.some((p) => pathUnderRoot(p, r))),
      )
      .sort((a, b) => b.last_seen - a.last_seen);
    if (matches.length > 0) return matches[0].device_id;
  }

  // 3. Most-recently-active local device.
  return [...local].sort((a, b) => b.last_seen - a.last_seen)[0].device_id;
}
