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

/**
 * The host a placement should use: the asked-for one when it has room or is
 * asleep (a box that boots for this session starts empty). Otherwise, when
 * `fallback` allows, the awake provisioned host with the most free memory
 * that has room; a sleeping one is never woken in its place. Throws when no
 * host can take the session.
 */
export function chooseCloudHost(
  hostArg: string | undefined,
  log: (m: string) => void,
  opts: { fallback: boolean },
  deps: HostChoiceDeps = defaultDeps,
): { host: CloudHost; moved: boolean } {
  const asked = deps.resolve(hostArg);
  if (!asked.address || !deps.awake(asked)) return { host: asked, moved: false };
  const room = deps.probe(asked);
  if (room.fit) return { host: asked, moved: false };
  const full = `${asked.id} has no room for another session (${room.why})`;
  if (opts.fallback) {
    const others = deps.hosts()
      .filter((h) => h.id !== asked.id && h.deviceId && h.address && deps.awake(h))
      .map((h) => ({ h, room: deps.probe(h) }))
      .filter((c) => c.room.fit)
      .sort((a, b) => (b.room.memoryAvailable ?? 0) - (a.room.memoryAvailable ?? 0));
    if (others[0]) {
      log(`${full}: placing on ${others[0].h.id} instead`);
      return { host: others[0].h, moved: true };
    }
    throw new Error(`${full}, and no other awake cloud host has room: free memory there (stop sessions on it) or move this session to a laptop`);
  }
  throw new Error(`${full}: free memory there (stop sessions on it), or start this session in its own worktree so it can go to another host`);
}
