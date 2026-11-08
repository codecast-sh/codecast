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
 *   5. An online remote holding the checkout, then a sleeping cloud host holding it,
 *      then a local that has the files, then any local still in service, then any
 *      online remote. A machine quiet for a day never wins on platform alone.
 *
 * Kept pure, and out of the component, so the ladder is testable.
 */

import { cloudHostBootable, deviceServesPath, deviceWakesOnUse, machineGoneQuiet, machineOutOfService, platformCanOpenPath, THIS_DEVICE, type CloudHostReport } from "@codecast/shared/contracts";

export type MachineCandidate = {
  device_id: string;
  is_remote: boolean;
  online: boolean;
  last_seen: number;
  local_project_roots?: string[];
  platform?: string;
  cloud_host?: CloudHostReport | null;
};

/**
 * A machine that boots itself when work arrives: the cloud Linux class, an EC2
 * box whose idle state is "stopped". The shared contract owns the rule
 * (deviceWakesOnUse — the same predicate that names a chip "Cloud Linux");
 * this alias keeps the picker's vocabulary.
 */
export const wakesOnUse = deviceWakesOnUse;

/**
 * The machines a picker lists: every one still in service, plus the one this
 * session already runs on or has picked, so its chip still says where it is.
 * A dead VM or a cloud host whose instance is gone stays out of the row;
 * Settings → Devices is where it is seen and removed.
 */
export function listedMachines<T extends MachineCandidate>(machines: T[], keepId?: string | null, now = Date.now()): T[] {
  return machines.filter((d) => d.device_id === keepId || !machineOutOfService(d, machines, now));
}

/**
 * Deterministic tiebreak. device_id is a stable machine fingerprint, so the same
 * candidate set always yields the same answer — the property `last_seen` lacked.
 */
const stable = (list: MachineCandidate[]): string | null =>
  [...list].sort((a, b) => a.device_id.localeCompare(b.device_id))[0]?.device_id ?? null;

/**
 * The server's platformCanOpenPath (shared contract) — false only where the
 * path lives in a namespace the platform provably lacks. The picker's answer is
 * STAMPED now, so defaulting to a machine that can't cd into the folder would
 * pin the mistake rather than let the server correct it.
 */
const canOpen = (d: MachineCandidate, p?: string | null): boolean =>
  !p || deviceSeesPath(d, p) || platformCanOpenPath(d.platform, p);

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

/**
 * The project the person saved as their new-session default (client_state.ui
 * default_project), while one of their machines can still open it. Absent or
 * unreachable means "where you are working": every caller's own ladder.
 */
export function savedDefaultProject(
  ui: { default_project?: string | null } | null | undefined,
  devices: Array<Pick<MachineCandidate, "local_project_roots">>,
): string | undefined {
  const path = ui?.default_project;
  return path && pathOnMyMachines(devices, path) ? path : undefined;
}

/** Last path segment — the name the whole resolver stack keys checkouts by. */
export const repoName = (path: string): string =>
  path.split("/").filter(Boolean).pop() ?? path;

/**
 * One entry per repo NAME. The same project checked out on two machines
 * (~/src/codecast here, /Users/m1/work/codecast on m1) is one project, not two
 * — the machine picker decides which concrete path a session gets, and the
 * daemon remaps by repo name on whichever machine actually serves. Within a
 * name group, keep the current path if it's there, else the variant the routed
 * machine can open, else the highest-ranked one (input order is score order).
 */
export function dedupeProjectsByRepoName<T extends { path: string }>(
  projects: T[],
  routedDevice?: Pick<MachineCandidate, "local_project_roots"> | null,
  currentPath?: string | null,
): T[] {
  const byName = new Map<string, T>();
  const order: string[] = [];
  const rank = (p: T): number =>
    p.path === currentPath ? 2 : routedDevice && deviceSeesPath(routedDevice, p.path) ? 1 : 0;
  for (const p of projects) {
    const name = repoName(p.path);
    const prev = byName.get(name);
    if (!prev) {
      byName.set(name, p);
      order.push(name);
    } else if (rank(p) > rank(prev)) {
      byName.set(name, p);
    }
  }
  return order.length === projects.length ? projects : order.map((n) => byName.get(n)!);
}

export type MachineIntentOpts = {
  projectPath?: string | null;
  /**
   * The person's "New session defaults" device (client_state.ui.default_device,
   * stamped so it follows them everywhere): THIS_DEVICE or a device id. Absent
   * means "last used", i.e. lastPicked.
   */
  defaultDevice?: string | null;
  /**
   * The machine the user last chose by hand, persisted across sessions and
   * devices. Intent beats every heuristic below it: if you work on your Mac
   * Studio, the picker opens on it until you say otherwise.
   */
  lastPicked?: string | null;
  /**
   * The machine this client runs on: the device whose daemon answers on
   * loopback (useLocalDeviceId). Its daemon answered, so it is alive whatever
   * the roster's minute-old `online` says. It ranks below a saved default and
   * the last hand pick (sd-2611): a person with three Macs who picked the
   * Studio means the Studio, from the laptop too.
   */
  localDeviceId?: string | null;
  /**
   * Accept an OFFLINE machine when this says it can still serve: a cloud host
   * that is merely asleep boots when the session starts, so a saved default of
   * it holds while it sleeps (a last pick only off a machine). Default: online only.
   */
  wakeOk?: (d: MachineCandidate) => boolean;
};

/**
 * Where the person said new work goes, in order: the default they set, their
 * last hand pick, the machine they are sitting at. A default or pick that
 * cannot serve (offline, removed, unable to open the folder) falls through to
 * the next rung rather than highlight a chip that can't run anything.
 */
export function intendedMachineId(devices: MachineCandidate[], opts: MachineIntentOpts): string | null {
  // A saved default waits for a sleeping cloud host to boot. A last pick of one
  // waits only where there is no machine here (phone, plain web): at a laptop,
  // a host asleep for days must not pull new sessions off it.
  const usable = (id: string | null | undefined, wake: boolean): string | null => {
    const d = id ? devices.find((x) => x.device_id === id) : undefined;
    if (!d) return null;
    const waking = wake && !!opts.wakeOk?.(d);
    if (!(d.online || waking)) return null;
    return canOpen(d, opts.projectPath) || waking ? d.device_id : null;
  };
  const here = opts.localDeviceId ? devices.find((d) => d.device_id === opts.localDeviceId)?.device_id ?? null : null;
  const fromDefault = opts.defaultDevice === THIS_DEVICE ? here : usable(opts.defaultDevice, true);
  return fromDefault ?? usable(opts.lastPicked, !here) ?? here;
}

export function defaultMachineId(
  devices: MachineCandidate[],
  opts: MachineIntentOpts & { ownerDeviceId?: string | null; now?: number } = {},
): string | null {
  const { ownerDeviceId, projectPath } = opts;
  const now = opts.now ?? Date.now();
  const roster = devices;
  const canServe = (d: MachineCandidate) => d.online || !!opts.wakeOk?.(d);

  // 1. An existing conversation stays on the machine that owns it. This OUTRANKS
  //    your standing choice on purpose: the pick is now stamped, so defaulting an
  //    already-owned session to a different machine would silently move it just by
  //    opening it. A standing preference is about where NEW work starts.
  const owner = ownerDeviceId ? devices.find((d) => d.device_id === ownerDeviceId) : undefined;
  if (owner && canServe(owner)) return owner.device_id;

  // 2. Your intent: saved default, last hand pick, the machine you are at.
  const intended = intendedMachineId(devices, opts);
  if (intended) return intended;

  const hasCheckout = (d: MachineCandidate) => !!projectPath && deviceSeesPath(d, projectPath);
  // Narrow to the machines that can open the path, but only on the word of
  // one that holds it or is still in service: a long-dead VM must not narrow
  // the pool down to itself.
  const openable = devices.filter((d) => canOpen(d, projectPath));
  if (openable.some((d) => hasCheckout(d) || !machineGoneQuiet(d, now))) devices = openable;

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

  // …a sleeping cloud host holding it boots for the work…
  const hostWithCheckout = devices.filter((d) => hasCheckout(d) && cloudHostBootable(d, roster));
  if (hostWithCheckout.length > 0) return stable(hostWithCheckout);

  // …otherwise the work queues for a local machine to pick up when it wakes:
  // one that has the files, else one still in service, else any.
  const locals = devices.filter((d) => !d.is_remote);
  const holders = projectPath ? locals.filter((d) => deviceServesPath(d, [projectPath])) : [];
  const live = locals.filter((d) => !machineGoneQuiet(d, now));
  for (const pool of [holders, live, locals]) {
    if (pool.length === 0) continue;
    return owner && pool.some((d) => d.device_id === owner.device_id) ? owner.device_id : stable(preferOpenable(pool, projectPath));
  }

  // Cloud-only user: an online remote is the only machine that can serve.
  return stable(devices.filter((d) => d.is_remote && d.online));
}

/**
 * The folder list to show while the machine-scoped recents query is in flight.
 *
 * Falling back to the raw union is unsafe (it offers folders the target machine
 * lacks, and the stamp would send the session to a machine that can't cd there),
 * but painting nothing is a visible flicker: the chip row opened empty and the
 * folders popped in a beat later. The union filtered by that machine's OWN
 * local_project_roots is exactly the predicate the server applies, computed from
 * the device roster already in memory — safe AND instant.
 *
 * Ladder: live scoped answer → that machine's cached answer → the union narrowed
 * to that machine → nothing (roster hasn't loaded, so we can't narrow safely).
 */
export function resolveScopedProjects<T extends { path: string }>(opts: {
  scopedDeviceId: string | null | undefined;
  scoped: T[] | undefined;
  cached: T[] | undefined;
  union: T[];
  routedDevice?: Pick<MachineCandidate, "local_project_roots"> | null;
}): T[] {
  const { scopedDeviceId, scoped, cached, union, routedDevice } = opts;
  if (!scopedDeviceId) return union;
  if (scoped) return scoped;
  if (cached?.length) return cached;
  if (!routedDevice?.local_project_roots?.length) return [];
  return union.filter((p) => deviceSeesPath(routedDevice, p.path));
}
