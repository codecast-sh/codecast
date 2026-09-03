// Loopback probes for `cast bench daemon`. The daemon's HTTP server runs on the
// main event loop, so the response time of an unauthenticated GET /health is a
// direct meter of loop lag, independent of the daemon's own freeze log.

import * as fs from "node:fs";
import { hookPortFile, readIdentity } from "../loopbackIdentity.js";
import { summarizeLatency, type LatencySummary } from "./stats.js";

export interface ProbeIdentity {
  port: number | null;
  token: string | null;
  /** Why the token is unusable; null when it is valid. */
  reason: string | null;
}

/**
 * Port from hook-port (written on every listen) plus the token the daemon
 * persists in loopback-identity.json. loopbackIdentity.ts owns both paths and
 * the parse; the rules on top of it are the bench's own. The token counts only
 * when the identity file names the live port and its pid is alive, so a file
 * left by an older daemon never authenticates against a newer one.
 */
export function readLoopbackIdentity(configDir: string): ProbeIdentity {
  let port: number | null = null;
  try {
    const raw = fs.readFileSync(hookPortFile(configDir), "utf-8").trim();
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n > 0) port = n;
  } catch {}
  if (port === null) return { port: null, token: null, reason: "hook-port missing" };
  const identity = readIdentity(configDir);
  if (!identity) return { port, token: null, reason: "missing" };
  if (identity.port !== port) return { port, token: null, reason: "port mismatch" };
  if (identity.pid !== undefined) {
    try {
      process.kill(identity.pid, 0);
    } catch {
      return { port, token: null, reason: "pid not alive" };
    }
  }
  return { port, token: identity.token, reason: null };
}

/** The envelope authorizeLocalRequest accepts: a loopback origin and the bearer token. */
export function localAuthHeaders(port: number, token: string): Record<string, string> {
  return { Origin: `http://127.0.0.1:${port}`, Authorization: `Bearer ${token}` };
}

export interface LoopLagResult {
  summary: LatencySummary;
  samples: number[];
  /** Ticks not fired because maxInFlight requests were still open. */
  skipped: number;
  errors: number;
  intervalMs: number;
  durationMs: number;
}

const PROBE_TIMEOUT_MS = 60_000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function timedGet(url: string, headers?: Record<string, string>): Promise<{ ms: number; status: number | null }> {
  const start = performance.now();
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    await res.arrayBuffer();
    return { ms: performance.now() - start, status: res.status };
  } catch {
    return { ms: performance.now() - start, status: null };
  }
}

/**
 * GET /health every intervalMs for durationMs. A setTimeout chain, not
 * setInterval, so a stalled bench process cannot burst. A cap on open
 * requests keeps the meter from becoming the load during a long freeze.
 */
export async function runLoopLagProbe(opts: {
  port: number;
  durationMs: number;
  intervalMs?: number;
  maxInFlight?: number;
  signal?: AbortSignal;
}): Promise<LoopLagResult> {
  const intervalMs = opts.intervalMs ?? 100;
  const maxInFlight = opts.maxInFlight ?? 100;
  const url = `http://127.0.0.1:${opts.port}/health`;
  const samples: number[] = [];
  let skipped = 0;
  let errors = 0;
  const pending = new Set<Promise<void>>();
  const deadline = performance.now() + opts.durationMs;

  while (performance.now() < deadline && !opts.signal?.aborted) {
    if (pending.size >= maxInFlight) {
      skipped++;
    } else {
      const p = timedGet(url).then((r) => {
        if (r.status === 200) samples.push(r.ms);
        else errors++;
      });
      pending.add(p);
      void p.finally(() => pending.delete(p));
    }
    await sleep(intervalMs);
  }
  await Promise.all(pending);
  return { summary: summarizeLatency(samples), samples, skipped, errors, intervalMs, durationMs: opts.durationMs };
}

export interface LatencyProbeResult {
  url: string;
  summary: LatencySummary;
  statuses: Record<string, number>;
  intervalMs: number;
}

/** Sequential timed GETs of one route, one per intervalMs. */
export async function runLatencyProbe(opts: {
  url: string;
  headers?: Record<string, string>;
  durationMs: number;
  intervalMs?: number;
  signal?: AbortSignal;
}): Promise<LatencyProbeResult> {
  const intervalMs = opts.intervalMs ?? 1000;
  const samples: number[] = [];
  const statuses: Record<string, number> = {};
  const deadline = performance.now() + opts.durationMs;
  while (performance.now() < deadline && !opts.signal?.aborted) {
    const r = await timedGet(opts.url, opts.headers);
    samples.push(r.ms);
    const key = r.status === null ? "error" : String(r.status);
    statuses[key] = (statuses[key] ?? 0) + 1;
    const wait = intervalMs - r.ms;
    if (wait > 0) await sleep(wait);
  }
  return { url: opts.url, summary: summarizeLatency(samples), statuses, intervalMs };
}

export interface RouteProbes {
  loopLag: LoopLagResult;
  hookStatus: LatencyProbeResult;
  /** null when there is no terminal token to authenticate with. */
  termSessions: LatencyProbeResult | null;
}

/**
 * The three probes a bench run takes, together: loop lag on /health plus the
 * two loopback routes the daemon answers from the same event loop. Observe
 * mode runs them on an idle daemon and load mode runs them again alongside the
 * churn, so both read the same numbers from the same code.
 */
export async function runRouteProbes(opts: {
  port: number;
  durationMs: number;
  authHeaders: Record<string, string> | null;
  signal?: AbortSignal;
}): Promise<RouteProbes> {
  const { port, durationMs, signal } = opts;
  const [loopLag, hookStatus, termSessions] = await Promise.all([
    runLoopLagProbe({ port, durationMs, signal }),
    runLatencyProbe({ url: `http://127.0.0.1:${port}/hook/status`, durationMs, signal }),
    opts.authHeaders
      ? runLatencyProbe({ url: `http://127.0.0.1:${port}/term/sessions`, headers: opts.authHeaders, durationMs, signal })
      : Promise.resolve(null),
  ]);
  return { loopLag, hookStatus, termSessions };
}
