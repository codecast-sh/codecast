/**
 * Whether a cloud host has the memory to take one more session, read over
 * ssh right before a placement commits to it.
 *
 * A placement on a host that is out of memory does not fail where the memory
 * runs out. Every step stalls in swap instead (the mirror stamp read, the
 * seed's git receive, the install) until one of their timeouts fires, eight
 * to thirteen minutes in, with an error that names the step and not the box
 * (a t3.medium carrying a hundred sessions, 2026-10-14). One probe up front
 * turns that into a choice made in seconds: another awake host with room, or
 * a refusal that says what is full.
 */

import { parseLinuxMemory, parseMacMemory } from "../systemResources.js";
import { readRepoNeed, tooSmallFor, type RepoNeed } from "../repoNeed.js";
import { hostState, readHosts, resolveCloudHost, toRemoteHost, type CloudHost } from "../browser/cloudHost.js";
import { ssh } from "../remote/session-move.js";
import { CLOUD_HOST_SIZES } from "@codecast/shared/contracts";

export { readRepoNeed, tooSmallFor, type RepoNeed };

const GiB = 1024 ** 3;
const PROBE_TIMEOUT_MS = 20_000;
/** Below this a new agent, its install and a typecheck reach the OOM killer. */
const MIN_AVAILABLE = 1 * GiB;
/** Swap this full means the working set already exceeds RAM: the next spike is an OOM kill. */
const MAX_SWAP_USED = 0.8;

const PROBE = "uname -s; echo ---; if [ -r /proc/meminfo ]; then cat /proc/meminfo; echo ---; cat /proc/pressure/memory 2>/dev/null;"
  + " else vm_stat; echo ---; sysctl vm.swapusage kern.memorystatus_vm_pressure_level hw.memsize; fi";

export interface Headroom {
  fit: boolean;
  /** What is short, for the log and the error: "swap 1.9 of 2.0 GB used". */
  why?: string;
  memoryAvailable?: number;
  /** The host's whole memory, measured against what the repo declares it needs. */
  memoryTotal?: number;
}

const gb = (n: number) => (n / GiB).toFixed(1);

/** The verdict on the probe's output. Pure, for tests. */
export function headroomFromProbe(out: string): Headroom {
  const [system = "", first = "", second = ""] = out.split(/^---$/m);
  let memoryAvailable: number | undefined;
  let memoryTotal: number | undefined;
  let pressure: string;
  let swapUsed: number | undefined;
  let swapTotal: number | undefined;
  if (system.trim() === "Linux") {
    const mem = parseLinuxMemory(first, second);
    memoryAvailable = mem.memoryAvailable;
    memoryTotal = mem.memoryTotal;
    pressure = mem.pressure;
    swapUsed = mem.swapUsedBytes;
    swapTotal = Number(first.match(/^SwapTotal:\s+(\d+)/m)?.[1]) * 1024;
  } else {
    const total = Number(second.match(/hw\.memsize:\s*(\d+)/)?.[1]);
    const mem = parseMacMemory(first, second, second.split("\n").find((l) => l.startsWith("kern.memorystatus")) ?? "", total);
    memoryAvailable = mem.memoryAvailable;
    if (Number.isFinite(total) && total > 0) memoryTotal = total;
    pressure = mem.pressure;
  }
  const why = pressure === "critical" || pressure === "elevated" ? `memory pressure ${pressure}`
    : memoryAvailable !== undefined && memoryAvailable < MIN_AVAILABLE ? `${gb(memoryAvailable)} GB of memory free`
    : swapUsed !== undefined && swapTotal && swapTotal > 0 && swapUsed / swapTotal >= MAX_SWAP_USED ? `swap ${gb(swapUsed)} of ${gb(swapTotal)} GB used`
    : undefined;
  return { fit: !why, ...(why ? { why } : {}), ...(memoryAvailable !== undefined ? { memoryAvailable } : {}), ...(memoryTotal !== undefined ? { memoryTotal } : {}) };
}

export function probeHeadroom(host: CloudHost, run = ssh): Headroom {
  try {
    return headroomFromProbe(run(toRemoteHost(host), PROBE, PROBE_TIMEOUT_MS));
  } catch (err) {
    const e = err as { code?: string; stderr?: string | Buffer; message?: string };
    const detail = e.code === "ETIMEDOUT" ? `no answer over ssh within ${PROBE_TIMEOUT_MS / 1000}s`
      : `memory probe failed: ${(e.stderr?.toString() || e.message || String(err)).trim().split("\n").pop()}`;
    return { fit: false, why: detail };
  }
}

export interface HostChoiceDeps {
  resolve: (hostArg?: string) => CloudHost;
  hosts: () => CloudHost[];
  state: (host: CloudHost) => string;
  probe: (host: CloudHost) => Headroom;
}

const defaultDeps: HostChoiceDeps = {
  resolve: resolveCloudHost,
  hosts: readHosts,
  state: (host) => { try { return hostState(host).state; } catch { return "unknown"; } },
  probe: (host) => probeHeadroom(host),
};

/** Autoscale as the laptop applies it: the template to copy, how many hosts it may add, at what size. */
export interface AutoscalePlan {
  template: CloudHost;
  maxExtra: number;
  size: string;
}

/** Free memory a host keeps a placement at: below it, a roomier host takes the session. */
const ROOMY = 4 * GiB;

export interface HostChoice {
  host: CloudHost;
  moved: boolean;
  /** The host asked for, when the placement went elsewhere, and why. */
  from?: CloudHost;
  why?: string;
  /** Autoscale's answer: launch a host like this one first, then place there. */
  launch?: { like: CloudHost; size: string };
  /** The host is smaller than the repo needs and nothing that fits was free: why, for the session to be told. */
  small?: string;
}

/** The smallest offered size whose memory covers the need, never below the one asked for. */
export function sizeFor(need: RepoNeed | undefined, atLeast: string): string {
  const fits = CLOUD_HOST_SIZES.filter((s) => s.memory_gb * GiB * 0.9 >= (need?.memoryBytes ?? 0));
  const floor = CLOUD_HOST_SIZES.find((s) => s.type === atLeast);
  const pick = fits.find((s) => !floor || s.memory_gb >= floor.memory_gb);
  return pick?.type ?? atLeast;
}

/**
 * The host a placement should use. The asked-for host keeps it when it is
 * asleep (a box that boots for this session starts empty) or has ROOMY free
 * and the memory the repo needs (`need`). Otherwise, when `fallback` allows,
 * sessions spread: the awake provisioned host with room and the repo's
 * memory, same platform first, then the most free memory, takes it; a tight
 * host that still has room keeps it when nothing roomier exists.
 * Without autoscale a sleeping host is never woken in another's place.
 *
 * With autoscale, a session that has no room anywhere awake first wakes a
 * sleeping host (same platform first), then, under the cap, launches one like
 * the template, at least as big as the repo needs. Hosts it added count
 * against the cap until they are gone from the provider, asleep or not.
 *
 * A host smaller than the repo needs but with room is the last resort: the
 * session lands there with `small` saying why, so it is told up front that
 * its typecheck and dev server will not run. Throws when no host can take
 * the session.
 */
export function chooseCloudHost(
  hostArg: string | undefined,
  log: (m: string) => void,
  opts: { fallback: boolean; autoscale?: AutoscalePlan; need?: RepoNeed },
  deps: HostChoiceDeps = defaultDeps,
): HostChoice {
  const asked = deps.resolve(hostArg);
  const awake = (h: CloudHost) => deps.state(h) === "running";
  if (!asked.address || !awake(asked)) return { host: asked, moved: false };
  const room = deps.probe(asked);
  const small = tooSmallFor(room, opts.need);
  const free = room.memoryAvailable !== undefined ? `${gb(room.memoryAvailable)} GB free` : "free memory unknown";
  if (room.fit && !small && (!opts.fallback || (room.memoryAvailable ?? 0) >= ROOMY)) return { host: asked, moved: false };
  const full = `${asked.id} has no room for another session (${room.why})`;
  if (!opts.fallback) {
    if (room.fit) return { host: asked, moved: false, small };
    throw new Error(`${full}: free memory there (stop sessions on it), or start this session in its own worktree so it can go to another host`);
  }
  const platform = (h: CloudHost) => h.platform ?? "linux";
  const samePlatformFirst = (a: CloudHost, b: CloudHost) => Number(platform(b) === platform(asked)) - Number(platform(a) === platform(asked));
  const others = deps.hosts().filter((h) => h.id !== asked.id && h.deviceId);
  const best = others
    .filter((h) => h.address && awake(h))
    .map((h) => ({ h, room: deps.probe(h) }))
    .filter((c) => c.room.fit && !tooSmallFor(c.room, opts.need) && (room.fit && !small ? (c.room.memoryAvailable ?? 0) >= ROOMY : true))
    .sort((a, b) => samePlatformFirst(a.h, b.h) || (b.room.memoryAvailable ?? 0) - (a.room.memoryAvailable ?? 0))[0];
  const why = !room.fit ? room.why! : small ? `too small: ${small}` : `only ${free}`;
  const lead = `${asked.id} ${!room.fit ? `has no room for another session (${why})` : small ? `is ${why}` : `is tight (${why})`}`;
  if (best) {
    log(`${lead}: placing on ${best.h.id} instead (${best.room.memoryAvailable !== undefined ? `${gb(best.room.memoryAvailable)} GB free` : "has room"})`);
    return { host: best.h, moved: true, from: asked, why };
  }
  if (room.fit && !small) return { host: asked, moved: false };
  let capped = "";
  if (opts.autoscale) {
    const sleeping = others.filter((h) => deps.state(h) === "stopped").sort((a, b) => samePlatformFirst(a, b) || Number(!!b.autoscaled) - Number(!!a.autoscaled))[0];
    if (sleeping) {
      log(`${lead}: waking ${sleeping.id} (autoscale)`);
      return { host: sleeping, moved: true, from: asked, why };
    }
    const added = deps.hosts().filter((h) => h.autoscaled && deps.state(h) !== "missing").length;
    if (added < opts.autoscale.maxExtra) {
      const size = sizeFor(opts.need, opts.autoscale.size);
      log(`${lead}: launching a ${size} like ${opts.autoscale.template.id} (autoscale, ${added + 1} of ${opts.autoscale.maxExtra})`);
      return { host: opts.autoscale.template, moved: true, from: asked, why, launch: { like: opts.autoscale.template, size } };
    }
    capped = `; autoscale already added ${added} of ${opts.autoscale.maxExtra} hosts`;
  }
  if (room.fit) {
    log(`${asked.id} is ${why}, and no host that fits is awake${capped}: placing there anyway`);
    return { host: asked, moved: false, small };
  }
  throw new Error(`${full}, and no other awake cloud host has room${capped}: free memory there (stop sessions on it), add a cloud host, or move this session to a laptop`);
}
