/**
 * Which machine the new-session picker opens on: the one a send would route to
 * today. Mirrors convex/deviceRouting's ladder — sticky owner → an online local
 * that HAS this checkout → the most-recently-seen online local — so the
 * highlighted chip is a prediction the daemon will agree with, and the picker
 * can stay silent (no target_device_id) until the user moves off it. Stamping
 * the default would cost the session its offline fallback.
 *
 * Kept pure, and out of the component, so the ladder is testable.
 */

export type MachineCandidate = {
  device_id: string;
  is_remote: boolean;
  online: boolean;
  last_seen: number;
  local_project_roots?: string[];
};

const mostRecent = (list: MachineCandidate[]): string | null =>
  [...list].sort((a, b) => b.last_seen - a.last_seen)[0]?.device_id ?? null;

/**
 * Prefix semantics, mirroring the server's pathUnderRoot: a session in a repo
 * SUBDIR (~/code/app/packages/web) still belongs to the machine holding the
 * repo root. Exact `includes` under-matched, so the prediction disagreed with
 * routing and the picker stamped picks it didn't need to.
 */
export const deviceSeesPath = (
  d: Pick<MachineCandidate, "local_project_roots">,
  path: string,
): boolean =>
  !!d.local_project_roots?.some((r) => path === r || path.startsWith(r.endsWith("/") ? r : r + "/"));

/**
 * Can ANY of the user's machines open this path? The gate that keeps a
 * teammate's checkout (visible via team sessions) from seeding a new session
 * with a directory none of your devices has. An empty/unloaded roster doesn't
 * filter (same convention as the server's recents filter): showing too much
 * beats blocking on device data that hasn't arrived yet.
 */
export function pathOnMyMachines(
  devices: Array<Pick<MachineCandidate, "local_project_roots">>,
  path: string | null | undefined,
): boolean {
  if (!path) return false;
  if (devices.length === 0 || devices.every((d) => !d.local_project_roots?.length)) return true;
  return devices.some((d) => deviceSeesPath(d, path));
}

export function defaultMachineId(
  devices: MachineCandidate[],
  opts: {
    ownerDeviceId?: string | null;
    projectPath?: string | null;
    /**
     * The answer we gave last time. Online machines re-heartbeat every ~30s, so
     * "most-recently-seen" flips between two idle laptops on its own; without
     * this the highlight would hop between chips under the user's cursor. It
     * only breaks ties WITHIN the current candidate set, so a folder change that
     * genuinely moves the route still moves the highlight.
     */
    sticky?: string | null;
  } = {},
): string | null {
  const { ownerDeviceId, projectPath, sticky } = opts;
  // A stale owner id (device removed) isn't selectable — fall through to where
  // routing would actually land rather than highlighting a chip that isn't there.
  const owner = ownerDeviceId ? devices.find((d) => d.device_id === ownerDeviceId) : undefined;
  if (owner?.online) return owner.device_id;

  const hasCheckout = (d: MachineCandidate) => !!projectPath && deviceSeesPath(d, projectPath);

  const onlineLocals = devices.filter((d) => !d.is_remote && d.online);
  if (onlineLocals.length > 0) {
    const withCheckout = onlineLocals.filter(hasCheckout);
    const pool = withCheckout.length > 0 ? withCheckout : onlineLocals;
    if (sticky && pool.some((d) => d.device_id === sticky)) return sticky;
    return mostRecent(pool);
  }

  // No local is online. An online remote holding the checkout serves it now…
  const remoteWithCheckout = devices.filter((d) => d.is_remote && d.online && hasCheckout(d));
  if (remoteWithCheckout.length > 0) return mostRecent(remoteWithCheckout);

  // …otherwise the work queues for a local machine to pick up when it wakes.
  const locals = devices.filter((d) => !d.is_remote);
  if (locals.length > 0) return owner && !owner.is_remote ? owner.device_id : mostRecent(locals);

  // Cloud-only user: an online remote is the only machine that can serve.
  return mostRecent(devices.filter((d) => d.is_remote && d.online));
}
