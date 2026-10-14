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
import { hostState, readHosts, resolveCloudHost, toRemoteHost, type CloudHost } from "../browser/cloudHost.js";
import { ssh } from "../remote/session-move.js";

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
}

const gb = (n: number) => (n / GiB).toFixed(1);

/** The verdict on the probe's output. Pure, for tests. */
export function headroomFromProbe(out: string): Headroom {
  const [system = "", first = "", second = ""] = out.split(/^---$/m);
  let memoryAvailable: number | undefined;
  let pressure: string;
  let swapUsed: number | undefined;
  let swapTotal: number | undefined;
  if (system.trim() === "Linux") {
    const mem = parseLinuxMemory(first, second);
    memoryAvailable = mem.memoryAvailable;
    pressure = mem.pressure;
    swapUsed = mem.swapUsedBytes;
    swapTotal = Number(first.match(/^SwapTotal:\s+(\d+)/m)?.[1]) * 1024;
  } else {
    const total = Number(second.match(/hw\.memsize:\s*(\d+)/)?.[1]);
    const mem = parseMacMemory(first, second, second.split("\n").find((l) => l.startsWith("kern.memorystatus")) ?? "", total);
    memoryAvailable = mem.memoryAvailable;
    pressure = mem.pressure;
  }
  const why = pressure === "critical" || pressure === "elevated" ? `memory pressure ${pressure}`
    : memoryAvailable !== undefined && memoryAvailable < MIN_AVAILABLE ? `${gb(memoryAvailable)} GB of memory free`
    : swapUsed !== undefined && swapTotal && swapTotal > 0 && swapUsed / swapTotal >= MAX_SWAP_USED ? `swap ${gb(swapUsed)} of ${gb(swapTotal)} GB used`
    : undefined;
  return { fit: !why, ...(why ? { why } : {}), ...(memoryAvailable !== undefined ? { memoryAvailable } : {}) };
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
  awake: (host: CloudHost) => boolean;
  probe: (host: CloudHost) => Headroom;
}

const defaultDeps: HostChoiceDeps = {
  resolve: resolveCloudHost,
  hosts: readHosts,
  awake: (host) => hostState(host).state === "running",
  probe: (host) => probeHeadroom(host),
};

/** Free memory a host keeps a placement at: below it, a roomier host takes the session. */
const ROOMY = 4 * GiB;

export interface HostChoice {
  host: CloudHost;
  moved: boolean;
  /** The host asked for, when the placement went elsewhere, and why. */
  from?: CloudHost;
  why?: string;
}

/**
 * The host a placement should use. The asked-for host keeps it when it is
 * asleep (a box that boots for this session starts empty) or has ROOMY free.
 * Otherwise, when `fallback` allows, sessions spread: the awake provisioned
 * host with room, same platform first, then the most free memory, takes it;
 * a tight host that still has room keeps it when nothing roomier exists. A
 * sleeping host is never woken in another's place. Throws when no host can
 * take the session.
 */
export function chooseCloudHost(
  hostArg: string | undefined,
  log: (m: string) => void,
  opts: { fallback: boolean },
  deps: HostChoiceDeps = defaultDeps,
): HostChoice {
  const asked = deps.resolve(hostArg);
  if (!asked.address || !deps.awake(asked)) return { host: asked, moved: false };
  const room = deps.probe(asked);
  const free = room.memoryAvailable !== undefined ? `${gb(room.memoryAvailable)} GB free` : "free memory unknown";
  if (room.fit && (!opts.fallback || (room.memoryAvailable ?? 0) >= ROOMY)) return { host: asked, moved: false };
  const full = `${asked.id} has no room for another session (${room.why})`;
  if (!opts.fallback) throw new Error(`${full}: free memory there (stop sessions on it), or start this session in its own worktree so it can go to another host`);
  const platform = (h: CloudHost) => h.platform ?? "linux";
  const best = deps.hosts()
    .filter((h) => h.id !== asked.id && h.deviceId && h.address && deps.awake(h))
    .map((h) => ({ h, room: deps.probe(h) }))
    .filter((c) => c.room.fit && (room.fit ? (c.room.memoryAvailable ?? 0) >= ROOMY : true))
    .sort((a, b) => Number(platform(b.h) === platform(asked)) - Number(platform(a.h) === platform(asked))
      || (b.room.memoryAvailable ?? 0) - (a.room.memoryAvailable ?? 0))[0];
  if (best) {
    const why = room.fit ? `only ${free}` : room.why!;
    log(`${asked.id} ${room.fit ? `is tight (${why})` : `has no room for another session (${why})`}: placing on ${best.h.id} instead (${best.room.memoryAvailable !== undefined ? `${gb(best.room.memoryAvailable)} GB free` : "has room"})`);
    return { host: best.h, moved: true, from: asked, why };
  }
  if (room.fit) return { host: asked, moved: false };
  throw new Error(`${full}, and no other awake cloud host has room: free memory there (stop sessions on it), add a cloud host, or move this session to a laptop`);
}
