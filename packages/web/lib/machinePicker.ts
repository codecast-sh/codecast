/**
 * Which machine the new-session picker opens on.
 *
 * This used to be a PREDICTION of where routing would land, deliberately left
 * unstamped so the server could re-decide. That made the choice non-deterministic:
 * the last rung was "most-recently-seen online local", and two idle laptops
 * re-heartbeat every ~30s, so the answer flipped on its own between the render
 * that showed you a chip and the send that acted on it.
 *
 * Now the picker's answer IS the decision — every new session stamps
 * `target_device_id`, which wins rung 1 of convex/deviceRouting outright. So this
 * ladder must be STABLE rather than predictive: it never consults `last_seen`,
 * and every rung is a fact about intent or capability.
 *
 *   1. The conversation's owner, if it's still online (an existing session stays put).
 *   2. The machine you last picked by hand, if it's still online.
 *   3. An online local that actually HAS this checkout.
 *   4. Any online local — tie broken by device_id, which never changes.
 *   5. An online remote holding the checkout, then any local, then any online remote.
 *
 * Kept pure, and out of the component, so the ladder is testable.
 */

export type MachineCandidate = {
  device_id: string;
  is_remote: boolean;
  online: boolean;
  last_seen: number;
  local_project_roots?: string[];
  platform?: string;
};

/**
 * Deterministic tiebreak. device_id is a stable machine fingerprint, so the same
 * candidate set always yields the same answer — the property `last_seen` lacked.
 */
const stable = (list: MachineCandidate[]): string | null =>
  [...list].sort((a, b) => a.device_id.localeCompare(b.device_id))[0]?.device_id ?? null;

/**
 * Mirrors convex/deviceRouting's platformCanOpenPath — false only where the path
 * lives in a namespace the platform provably lacks. The picker's answer is
 * STAMPED now, so defaulting to a machine that can't cd into the folder would
 * pin the mistake rather than let the server correct it.
 */
const canOpen = (d: MachineCandidate, p?: string | null): boolean => {
  if (!p || !d.platform) return true;
  if (d.platform === "win32") return !p.startsWith("/");
  if (!p.startsWith("/")) return true;
  if (d.platform === "darwin") return !p.startsWith("/home/") && !p.startsWith("/root/");
  if (d.platform === "linux") return !p.startsWith("/Users/");
  return true;
};

/** Openable candidates if any, else the whole pool — never return nothing. */
const preferOpenable = (list: MachineCandidate[], p?: string | null): MachineCandidate[] => {
  const openable = list.filter((d) => canOpen(d, p));
  return openable.length > 0 ? openable : list;
};

/**
 * The three decisions the new-session machine row makes, resolved together
 * because they have to agree.
 *
 * `stampDeviceId === scopeProjectsToDeviceId` is the invariant: the pick now wins
 * rung 1 of deviceRouting outright, so the folder list MUST be that machine's
 * checkouts. The unscoped recents query is a union across every online local, and
 * offering it alongside a forced target let a session be stamped to a machine
 * that couldn't cd into the folder the user chose from it.
 *
 * `existingStamp` is the LAST rung, and it exists because the roster is not
 * reliably present: `useDevices()` is `useQuery(...) ?? []`, so it reads empty on
 * every mount and again on any Convex reconnect. Without this rung a transient
 * empty roster resolves to null, and null scoping silently reverts the folder
 * list to the cross-machine union while the session's stamp survives — i.e. the
 * UI offers a machine-B path for a session already pinned to machine A. Falling
 * back to the decision already recorded keeps BOTH halves consistent through the
 * gap. It only ever applies when nothing can be computed: once the roster is
 * back, the ladder decides again, so a stale stamp can't become sticky.
 *
 * A null result means "no roster AND no prior decision" — the caller must leave
 * any existing stamp alone rather than write the null through.
 */
export function resolveMachineSelection(
  devices: MachineCandidate[],
  opts: {
    picked?: string | null;
    ownerDeviceId?: string | null;
    projectPath?: string | null;
    lastPicked?: string | null;
    existingStamp?: string | null;
  } = {},
): { selectedDeviceId: string | null; stampDeviceId: string | null; scopeProjectsToDeviceId: string | null } {
  const selectedDeviceId = opts.picked ?? defaultMachineId(devices, opts) ?? opts.existingStamp ?? null;
  return {
    selectedDeviceId,
    stampDeviceId: selectedDeviceId,
    scopeProjectsToDeviceId: selectedDeviceId,
  };
}

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
     * The machine the user last chose by hand, persisted across sessions. Intent
     * beats every heuristic below it: if you work on your laptop, the picker opens
     * on your laptop, and it stays there until you say otherwise.
     */
    lastPicked?: string | null;
  } = {},
): string | null {
  const { ownerDeviceId, projectPath, lastPicked } = opts;

  // 1. An existing conversation stays on the machine that owns it. This OUTRANKS
  //    your standing choice on purpose: the pick is now stamped, so defaulting an
  //    already-owned session to a different machine would silently move it just by
  //    opening it. A standing preference is about where NEW work starts.
  const owner = ownerDeviceId ? devices.find((d) => d.device_id === ownerDeviceId) : undefined;
  if (owner?.online) return owner.device_id;

  // 2. Your standing choice. A stale id (machine removed or asleep) isn't
  //    selectable, so fall through rather than highlight a chip that can't serve.
  const picked = lastPicked ? devices.find((d) => d.device_id === lastPicked) : undefined;
  if (picked?.online) return picked.device_id;

  const hasCheckout = (d: MachineCandidate) => !!projectPath && deviceSeesPath(d, projectPath);

  const onlineLocals = devices.filter((d) => !d.is_remote && d.online);
  if (onlineLocals.length > 0) {
    // 3/4. The machine that has the folder, else any online local that could
    //      plausibly open it.
    const withCheckout = onlineLocals.filter(hasCheckout);
    return stable(withCheckout.length > 0 ? withCheckout : preferOpenable(onlineLocals, projectPath));
  }

  // 5. No local is online. An online remote holding the checkout serves it now…
  const remoteWithCheckout = devices.filter((d) => d.is_remote && d.online && hasCheckout(d));
  if (remoteWithCheckout.length > 0) return stable(remoteWithCheckout);

  // …otherwise the work queues for a local machine to pick up when it wakes.
  const locals = devices.filter((d) => !d.is_remote);
  if (locals.length > 0) {
    return owner && !owner.is_remote ? owner.device_id : stable(preferOpenable(locals, projectPath));
  }

  // Cloud-only user: an online remote is the only machine that can serve.
  return stable(devices.filter((d) => d.is_remote && d.online));
}
