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
};

/**
 * Deterministic tiebreak. device_id is a stable machine fingerprint, so the same
 * candidate set always yields the same answer — the property `last_seen` lacked.
 */
const stable = (list: MachineCandidate[]): string | null =>
  [...list].sort((a, b) => a.device_id.localeCompare(b.device_id))[0]?.device_id ?? null;

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

  // Prefix semantics, mirroring the server's pathUnderRoot: a session in a repo
  // SUBDIR (~/code/app/packages/web) still belongs to the machine holding the
  // repo root.
  const hasCheckout = (d: MachineCandidate) =>
    !!projectPath &&
    !!d.local_project_roots?.some((r) => projectPath === r || projectPath.startsWith(r.endsWith("/") ? r : r + "/"));

  const onlineLocals = devices.filter((d) => !d.is_remote && d.online);
  if (onlineLocals.length > 0) {
    // 3/4. The machine that has the folder, else any online local.
    const withCheckout = onlineLocals.filter(hasCheckout);
    return stable(withCheckout.length > 0 ? withCheckout : onlineLocals);
  }

  // 5. No local is online. An online remote holding the checkout serves it now…
  const remoteWithCheckout = devices.filter((d) => d.is_remote && d.online && hasCheckout(d));
  if (remoteWithCheckout.length > 0) return stable(remoteWithCheckout);

  // …otherwise the work queues for a local machine to pick up when it wakes.
  const locals = devices.filter((d) => !d.is_remote);
  if (locals.length > 0) return owner && !owner.is_remote ? owner.device_id : stable(locals);

  // Cloud-only user: an online remote is the only machine that can serve.
  return stable(devices.filter((d) => d.is_remote && d.online));
}
