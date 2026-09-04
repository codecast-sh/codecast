// Discovery of the local daemon's terminal endpoint.
//
// The daemon serves the integrated terminal on an OS-assigned loopback port
// guarded by a per-boot token. The browser can't read the port file, so
// discovery goes through the authenticated daemon-command relay: one
// get_terminal_endpoint command per live device, then we probe each returned
// endpoint over 127.0.0.1 — only the machine the browser is physically on
// answers, which resolves multi-device setups with no server-side logic.

import type { ConvexReactClient } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";

export interface TerminalEndpoint {
  port: number;
  token: string;
  deviceId: string;
  tmux: boolean;
}

export interface TerminalSessionInfo {
  name: string;
  path: string;
  command: string;
  created: number;
  attached: number;
}

// Discovery is capped tighter when we already know which machine the pane is
// on: the only question left is "is that machine THIS one?", and a targeted
// daemon answers in well under a second. Waiting the full budget for a machine
// that is asleep just delays the relay fallback.
const TARGETED_POLL_TIMEOUT_MS = 3_000;

const CACHE_KEY = "cast_term_endpoint";
// Dev override: `localStorage.CAST_TERM_ENDPOINT = "42871:dev-token"` points
// the panel at a standalone terminal server (packages/cli terminal dev server)
// without a daemon round-trip.
const OVERRIDE_KEY = "CAST_TERM_ENDPOINT";
// Dev override: `localStorage.CAST_TERM_FORCE_RELAY = "1"` makes discovery
// report every pane as living elsewhere, which is the only way to exercise the
// relay transport on a single machine — the loopback probe would otherwise
// always win. Twin of CAST_TERM_ENDPOINT above.
const FORCE_RELAY_KEY = "CAST_TERM_FORCE_RELAY";

function forceRelay(): boolean {
  try {
    return localStorage.getItem(FORCE_RELAY_KEY) === "1";
  } catch {
    return false;
  }
}
const RESULT_POLL_MS = 400;
const RESULT_POLL_TIMEOUT_MS = 10_000;
const PROBE_TIMEOUT_MS = 1500;
// A probe that TIMES OUT proves something is listening on that port — a
// browser block or a closed port fails in milliseconds. So a timeout earns one
// slower second look before the daemon is declared unreachable: the local
// daemon's loop stalls for seconds under load (sync tmux calls, watcher walks),
// and giving up at 1.5s turned every stall into a "can't reach" dead end.
const PROBE_RETRY_TIMEOUT_MS = 6000;

// Keyed by the device asked for ("" = any), so a targeted lookup can't be
// served by an in-flight broadcast one.
const inflight = new Map<string, Promise<TerminalEndpoint | null>>();

/** Why the last discovery produced no endpoint. Callers surface cause-specific
 *  guidance:
 *  - "no-devices": the relay found no live daemon — it isn't running, or you're
 *    signed in as someone else.
 *  - "daemon-slow": a daemon is live but didn't answer in time — either its
 *    discovery reply never came back within the budget, or the loopback probe
 *    timed out. A timeout means something IS listening; the daemon is busy,
 *    not blocked, and a retry usually lands.
 *  - "probe-failed": every candidate answered and every probe was rejected
 *    outright. Either the answering daemons live on other machines, or the
 *    browser refused the loopback request — on a hosted origin that's Chrome's
 *    local-network permission. Restarting the daemon fixes neither.
 *  - "other-device": a targeted lookup missed; the pane lives elsewhere. */
export type DiscoveryFailure = "none" | "no-devices" | "daemon-slow" | "probe-failed" | "other-device";
let lastFailure: DiscoveryFailure = "none";
export function lastDiscoveryFailure(): DiscoveryFailure {
  return lastFailure;
}

/** How the last probe missed. fetch() folds every failure into one rejection,
 *  but the error NAME still separates "nothing answered in time" from "the
 *  request was refused before it got anywhere" — and that is the difference
 *  between a busy daemon and a blocked one. */
type ProbeMiss = "timeout" | "rejected";
let lastProbeMiss: ProbeMiss | null = null;

function isTimeoutError(e: unknown): boolean {
  const name = (e as { name?: unknown } | null)?.name;
  return name === "TimeoutError" || name === "AbortError";
}

function readOverride(): TerminalEndpoint | null {
  try {
    const raw = localStorage.getItem(OVERRIDE_KEY);
    if (!raw) return null;
    const [port, token] = raw.split(":");
    if (!port || !token) return null;
    return { port: parseInt(port, 10), token, deviceId: "dev-override", tmux: true };
  } catch {
    return null;
  }
}

function readCache(): TerminalEndpoint | null {
  try {
    const raw = sessionStorage.getItem(CACHE_KEY);
    return raw ? (JSON.parse(raw) as TerminalEndpoint) : null;
  } catch {
    return null;
  }
}

function writeCache(ep: TerminalEndpoint | null): void {
  try {
    if (ep) sessionStorage.setItem(CACHE_KEY, JSON.stringify(ep));
    else sessionStorage.removeItem(CACHE_KEY);
  } catch {}
}

export function termHttpBase(ep: TerminalEndpoint): string {
  // Literal IPv4: macOS resolves `localhost` to ::1 first and Safari won't
  // fall back when the daemon binds IPv4 only (see auth/cli/page.tsx).
  return `http://127.0.0.1:${ep.port}`;
}

export function termWsUrl(ep: TerminalEndpoint): string {
  return `ws://127.0.0.1:${ep.port}/term/ws`;
}

/** Probe an endpoint: does a daemon with this token answer on loopback? */
export async function probeEndpoint(
  ep: TerminalEndpoint,
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<TerminalSessionInfo[] | null> {
  lastProbeMiss = null;
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      const res = await fetch(`${termHttpBase(ep)}/term/sessions`, {
        headers: { Authorization: `Bearer ${ep.token}` },
        signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
      });
      if (res.status === 503) {
        const body = await res.json();
        if (body.unavailable === true) {
          lastProbeMiss = "timeout";
          await new Promise(resolve => setTimeout(resolve, Math.min(200, Math.max(0, deadline - Date.now()))));
          continue;
        }
      }
      if (!res.ok) {
        lastProbeMiss = "rejected";
        return null;
      }
      const body = (await res.json()) as { sessions?: TerminalSessionInfo[]; tmux?: boolean };
      if (!body.tmux) {
        lastProbeMiss = "rejected";
        return null;
      }
      lastProbeMiss = null;
      return body.sessions ?? [];
    }
    lastProbeMiss = "timeout";
    return null;
  } catch (e) {
    lastProbeMiss = isTimeoutError(e) ? "timeout" : "rejected";
    return null;
  }
}

/** Probe, and give a daemon that timed out one slower second chance. */
async function probeWithPatience(ep: TerminalEndpoint): Promise<TerminalSessionInfo[] | null> {
  const first = await probeEndpoint(ep);
  if (first !== null || lastProbeMiss !== "timeout") return first;
  const second = await probeEndpoint(ep, PROBE_RETRY_TIMEOUT_MS);
  // A second timeout is still a timeout: the caller reports the daemon as
  // slow, not the browser as blocking.
  if (second === null) lastProbeMiss = "timeout";
  return second;
}

async function discover(convex: ConvexReactClient, deviceId?: string): Promise<TerminalEndpoint | null> {
  const { commands } = await convex.mutation(api.users.requestTerminalEndpoints, {
    ...(deviceId ? { device_id: deviceId } : {}),
  });
  if (!commands.length) {
    lastFailure = "no-devices";
    return null;
  }
  const deadline = Date.now() + (deviceId ? TARGETED_POLL_TIMEOUT_MS : RESULT_POLL_TIMEOUT_MS);
  const unresolved = new Map(commands.map((c) => [c.command_id, c] as const));
  let sawTimeout = false;

  while (unresolved.size > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, RESULT_POLL_MS));
    const checks = await Promise.all(
      [...unresolved.keys()].map(async (id) => ({
        id,
        res: await convex.query(api.users.getCommandResult, { command_id: id }),
      })),
    );
    for (const { id, res } of checks) {
      if (!res?.executed_at) continue;
      unresolved.delete(id);
      if (!res.result) continue;
      try {
        const parsed = JSON.parse(res.result) as { port: number; token: string; device_id: string; tmux: boolean };
        const ep: TerminalEndpoint = {
          port: parsed.port,
          token: parsed.token,
          deviceId: parsed.device_id,
          tmux: parsed.tmux,
        };
        // First endpoint that actually answers on loopback wins.
        if (ep.port > 0 && (await probeWithPatience(ep)) !== null) {
          lastFailure = "none";
          return ep;
        }
        if (lastProbeMiss === "timeout") sawTimeout = true;
      } catch {}
    }
  }
  // "Blocked" is only a fair verdict when every daemon answered and every
  // probe was refused outright. A daemon that never posted its reply, or a
  // port that timed out, is a daemon that is slow — and that reads very
  // differently to the person deciding whether to restart it.
  lastFailure = unresolved.size > 0 || sawTimeout ? "daemon-slow" : "probe-failed";
  return null;
}

/**
 * Resolve the local terminal endpoint: dev override, then session cache
 * (revalidated by probe), then full discovery through the daemon-command relay.
 *
 * `deviceId` narrows discovery to one machine, which is what the conversation
 * split wants: it already knows where the pane lives, so the only question is
 * whether that machine is THIS one. A miss there is not a failure — it is the
 * signal to take the relay transport instead — so it reports "other-device"
 * and returns fast rather than waiting out the broadcast budget.
 */
export async function getTerminalEndpoint(
  convex: ConvexReactClient,
  opts?: { force?: boolean; deviceId?: string },
): Promise<TerminalEndpoint | null> {
  const override = readOverride();
  if (override) return override;
  if (forceRelay()) {
    lastFailure = "other-device";
    return null;
  }

  const want = opts?.deviceId;
  if (!opts?.force) {
    const cached = readCache();
    // A cached endpoint that still answers on loopback tells us which machine
    // this browser is on. That settles a targeted lookup either way:
    //   same device → it's local, hand back the endpoint
    //   other device → it CANNOT be local, so say so now instead of spending
    //                  the discovery budget proving a machine isn't itself
    // Probing the wrong machine's cached endpoint and returning it would be
    // the most misleading possible outcome, so the id check comes first.
    if (cached && (await probeWithPatience(cached)) !== null) {
      if (!want || cached.deviceId === want) {
        lastFailure = "none";
        return cached;
      }
      lastFailure = "other-device";
      return null;
    }
  }

  const key = want ?? "";
  const existing = inflight.get(key);
  if (existing) return existing;

  const run = discover(convex, want)
    .then((ep) => {
      // Only the broadcast lookup owns the cache. A targeted miss says nothing
      // about the local machine, so it must not evict a good local endpoint.
      if (!want || ep) writeCache(ep);
      if (!ep && want) lastFailure = "other-device";
      return ep;
    })
    .finally(() => {
      inflight.delete(key);
    });
  inflight.set(key, run);
  return run;
}

export async function killTerminalSession(ep: TerminalEndpoint, name: string): Promise<boolean> {
  try {
    const res = await fetch(`${termHttpBase(ep)}/term/kill?name=${encodeURIComponent(name)}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ep.token}` },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    return false;
  }
}
