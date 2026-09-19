import type { Device } from "../components/DeviceBadge";
import { cloudPlacementFor, deviceDisplayName, platformCanOpenPath, type CloudStartFrom } from "@codecast/shared/contracts";
import { defaultMachineId, wakesOnUse, type MachineCandidate } from "./machinePicker";

export type SessionMachine = Device & { bot_name?: string | null };

type Candidate = MachineCandidate & { bot_name?: string | null };

export function sessionMachineChoices(
  devices: Device[],
  boxes: Array<Omit<Device, "local_project_roots"> & { local_project_roots?: string[]; bot_name: string | null }>,
): SessionMachine[] {
  const ids = new Set(devices.map((d) => d.device_id));
  return [...devices, ...boxes.filter((b) => !ids.has(b.device_id)).map((b) => ({
    ...b,
    local_project_roots: b.local_project_roots ?? [],
  }))];
}

/**
 * The composer's cloud host: one of YOUR machines (not a team agent box) that
 * boots itself when work arrives. An offline agent box cannot be woken by the
 * laptop — the mover needs a registry entry for it — so bot boxes never
 * qualify even when their platform matches.
 */
export function isCloudHost(d: { bot_name?: string | null; is_remote?: boolean; platform?: string }): boolean {
  return d.bot_name === undefined && wakesOnUse(d);
}

/**
 * The cloud host to offer, if the user has one — offline included, since a
 * stopped host is asleep, not gone. Only the first: one cloud box per account
 * is the shape the product has, and choosing among several belongs in the
 * machine row, which already lists them.
 */
export function cloudHostOf<T extends { bot_name?: string | null; is_remote?: boolean; platform?: string }>(devices: T[]): T | null {
  return devices.find(isCloudHost) ?? null;
}

type SelectionOpts = Parameters<typeof defaultMachineId>[1];

/**
 * Where a composer opens. The DROPDOWN is the standing choice: an explicit
 * pick is remembered (last_picked_device_id) and honoured for every later new
 * session, even while a cloud host sleeps. "Run in the cloud" is THIS
 * composer's override: it moves the component-local pick and remembers
 * nothing. Cloud mode itself is derived from whichever machine wins here
 * (`isCloudHost(selected)`), never stored beside it.
 *
 * Ladder: owner if (online || cloud host) → last pick if (online || cloud
 * host) → the checkout holder → any online local → the usual remote rungs.
 * No toggle rung: memory above the owner rung is what let an eagerly-created
 * laptop-owned row render as "Cloud Linux" without ever being parked.
 */
export function defaultSessionMachineId(devices: Candidate[], opts: SelectionOpts) {
  const own = devices.filter((d) => d.bot_name === undefined);
  const wakeOk = (d: MachineCandidate) => isCloudHost(d as Candidate);
  const intended = devices.find((d) => d.device_id === opts?.ownerDeviceId && (d.online || isCloudHost(d)))
    ?? devices.find((d) => d.device_id === opts?.lastPicked && (d.online || isCloudHost(d))
      && (!opts.projectPath || isCloudHost(d) || platformCanOpenPath(d.platform, opts.projectPath)));
  return intended?.device_id ?? defaultMachineId(own.length ? own : devices, { ...opts, wakeOk });
}

export type MachineSelection = { pickedDeviceId: string | null; cloudMode: boolean };

/** A chip click: the pick is that machine, and cloud mode follows from it. */
export function machineSelectionAfterPick(d: Candidate): MachineSelection {
  return { pickedDeviceId: d.device_id, cloudMode: isCloudHost(d) };
}

/**
 * The "run in the cloud" toggle. On → the cloud host (cloud mode false when
 * the roster has none). Off → what the ladder would choose among the non-cloud
 * machines (null when only cloud hosts exist; the toggle is disabled then, see
 * cloudToggleAvailable). Either way `cloudMode === isCloudHost(picked)`.
 */
export function machineSelectionAfterCloudToggle(
  devices: Candidate[],
  opts: SelectionOpts,
  turningOn: boolean,
): MachineSelection {
  if (turningOn) {
    const host = cloudHostOf(devices);
    return { pickedDeviceId: host?.device_id ?? null, cloudMode: !!host };
  }
  const nonCloud = devices.filter((d) => !isCloudHost(d));
  return { pickedDeviceId: defaultSessionMachineId(nonCloud, opts), cloudMode: false };
}

/**
 * Whether the toggle can act: there is a host to turn on to, and — when it is
 * already on — a non-cloud machine to turn off to. A cloud-only roster leaves
 * it on and disabled instead of bouncing the pick to null.
 */
export function cloudToggleAvailable(devices: Candidate[], cloudMode: boolean): boolean {
  if (!cloudHostOf(devices)) return false;
  return !cloudMode || devices.some((d) => !isCloudHost(d));
}

/**
 * A machine chip's tooltip. A sleeping cloud host is not an offline laptop:
 * it boots when the session starts, so its chip must not promise a fallback
 * to another machine.
 */
export function machineChipTitle(d: SessionMachine): string {
  const name = deviceDisplayName(d);
  if (d.online) return `Run this session on ${name}`;
  if (isCloudHost(d)) return `${name} is asleep — it boots when the session starts`;
  return `${name} is offline — will fall back to an online machine with this repo`;
}

/**
 * Does a switch to `target` have to PARK the row (a laptop prepares the host
 * first), or can it start there plainly? The shared predicate decides, so the
 * composer, createSessionFromStub and the server's start chokepoint agree. A
 * machine-only switch (no folder) has no path to judge and always parks.
 */
export function cloudParkNeeded(opts: {
  target: SessionMachine | undefined;
  locals: SessionMachine[];
  path: string;
}): boolean {
  if (!opts.target || !isCloudHost(opts.target)) return false;
  return !opts.path || cloudPlacementFor({ target: opts.target, locals: opts.locals, paths: [opts.path] }) !== "native";
}

/**
 * The reconfigureSession payload for a folder or machine switch.
 *
 * Two rules live here. A PARK carries the host id, the workspace pick and
 * what the worktree starts from, and never an `isolated` flag: a cloud
 * session's worktree is made on the host by the laptop that prepares it, so
 * asking for one here would build a second worktree on this machine. Every
 * other target carries the user's real toggle and the plain target device —
 * including the un-park that runs while the composer still shows cloud mode.
 */
export function switchReconfigureArgs(opts: {
  /** A machine-only switch leaves the row's folder alone. */
  machineOnly: boolean;
  path: string;
  cloudPark: boolean;
  targetDeviceId: string | null;
  isolated: boolean;
  cloudShared: boolean;
  cloudStartFrom: CloudStartFrom;
}): Record<string, unknown> {
  return {
    ...(opts.machineOnly ? {} : { project_path: opts.path, git_root: opts.path }),
    isolated: opts.cloudPark ? undefined : opts.isolated || undefined,
    ...(opts.cloudPark && opts.targetDeviceId
      ? {
          cloud_device_id: opts.targetDeviceId,
          cloud_workspace: opts.cloudShared ? "shared" : "isolated",
          cloud_start_from: opts.cloudShared ? "origin_main" : opts.cloudStartFrom,
        }
      : opts.targetDeviceId ? { target_device_id: opts.targetDeviceId } : {}),
  };
}
