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

export interface BenchClock {
  now(): number;
  wall(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export const benchClock: BenchClock = {
  now: () => performance.now(),
  wall: () => Date.now(),
  sleep: (ms, signal) => new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const done = () => { signal?.removeEventListener("abort", aborted); resolve(); };
    const timer = setTimeout(done, Math.max(0, ms));
    const aborted = () => { clearTimeout(timer); signal?.removeEventListener("abort", aborted); reject(signal?.reason); };
    signal?.addEventListener("abort", aborted, { once: true });
  }),
};

export function deadlineSignal(clock: BenchClock, end: number, parent?: AbortSignal) {
  const controller = new AbortController();
  const timer = new AbortController();
  const cancel = () => controller.abort(parent?.reason);
  if (parent?.aborted) cancel();
  else parent?.addEventListener("abort", cancel, { once: true });
  const settled = clock.sleep(Math.max(0, end - clock.now()), timer.signal).then(
    () => controller.abort(new DOMException("measurement deadline", "TimeoutError")),
    () => {},
  );
  return {
    signal: controller.signal,
    async close() { timer.abort(); parent?.removeEventListener("abort", cancel); await settled; },
  };
}

export type Outcome = "ok" | "error" | "timeout" | "cancelled" | "skipped" | "missing" | "refused";
export const outcomeFor = (signal: AbortSignal): Outcome => signal.aborted
  ? signal.reason?.name === "TimeoutError" ? "timeout" : "cancelled" : "error";

export interface ProbeSample {
  slot: number;
  scheduledAt: number;
  startedAt: number | null;
  finishedAt: number;
  latenessMs: number | null;
  ms: number | null;
  status: number | null;
  outcome: Outcome;
  reason?: string;
}

export interface LatencyProbeResult {
  url: string;
  label: string;
  summary: LatencySummary;
  samples: number[];
  records: ProbeSample[];
  statuses: Record<string, number>;
  expected: number;
  attempted: number;
  errors: number;
  skipped: number;
  missing: number;
  timeouts: number;
  cancelled: number;
  lateness: LatencySummary;
  intervalMs: number;
  durationMs: number;
  startedAt: number;
  endedAt: number;
}
export type LoopLagResult = LatencyProbeResult;
export type ProbeFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface ProbeOptions {
  url: string;
  label?: string;
  headers?: Record<string, string>;
  expectedStatus?: number;
  durationMs: number;
  startAt?: number;
  intervalMs?: number;
  maxInFlight?: number;
  requestTimeoutMs?: number;
  signal?: AbortSignal;
  clock?: BenchClock;
  fetch?: ProbeFetch;
  request?: (signal: AbortSignal, slot: number) => Promise<string>;
}

export async function runLatencyProbe(opts: ProbeOptions): Promise<LatencyProbeResult> {
  const clock = opts.clock ?? benchClock;
  const intervalMs = opts.intervalMs ?? 1000;
  const maxInFlight = opts.maxInFlight ?? 4;
  if (!(intervalMs > 0 && opts.durationMs > 0 && maxInFlight > 0)) throw new Error("invalid probe bounds");
  const start = opts.startAt ?? clock.now();
  const end = start + opts.durationMs;
  const window = deadlineSignal(clock, end, opts.signal);
  const records: ProbeSample[] = [];
  const pending = new Set<Promise<void>>();
  const expected = Math.ceil(opts.durationMs / intervalMs);
  const skipped = (slot: number, outcome: Outcome, reason: string) => records.push({
    slot, scheduledAt: start + slot * intervalMs, startedAt: null, finishedAt: clock.now(),
    latenessMs: null, ms: null, status: null, outcome, reason,
  });
  let slot = 0;
  try {
    for (; slot < expected && !window.signal.aborted; slot++) {
      const scheduledAt = start + slot * intervalMs;
      if (clock.now() < scheduledAt) await clock.sleep(scheduledAt - clock.now(), window.signal);
      if (clock.now() >= end) break;
      if (clock.now() - scheduledAt >= intervalMs) { skipped(slot, "missing", "tester missed scheduled slot"); continue; }
      if (pending.size >= maxInFlight) { skipped(slot, "skipped", "in-flight cap"); continue; }
      const record: ProbeSample = { slot, scheduledAt, startedAt: clock.now(), finishedAt: clock.now(), latenessMs: clock.now() - scheduledAt, ms: null, status: null, outcome: "error" };
      records.push(record);
      const requestSlot = slot;
      const work = (async () => {
        const request = deadlineSignal(clock, Math.min(end, clock.now() + (opts.requestTimeoutMs ?? 5000)), window.signal);
        try {
          const url = opts.request ? await opts.request(request.signal, requestSlot) : opts.url;
          request.signal.throwIfAborted();
          const response = await (opts.fetch ?? fetch)(url, { headers: opts.headers, signal: request.signal });
          await response.arrayBuffer();
          request.signal.throwIfAborted();
          record.status = response.status;
          record.outcome = response.status === (opts.expectedStatus ?? 200) ? "ok" : "error";
          if (record.outcome === "error") record.reason = `HTTP ${response.status}`;
        } catch {
          record.outcome = outcomeFor(request.signal);
          record.reason = record.outcome === "error" ? "request or ownership verification failed" : record.outcome;
        } finally {
          record.finishedAt = clock.now();
          record.ms = record.finishedAt - record.startedAt!;
          await request.close();
        }
      })();
      pending.add(work);
      void work.then(() => pending.delete(work));
    }
  } catch {
    if (!window.signal.aborted) throw new Error("probe scheduler failed");
  } finally {
    for (; slot < expected; slot++) skipped(slot, window.signal.aborted ? outcomeFor(window.signal) : "missing", "window ended before slot");
    await Promise.all(pending);
    await window.close();
  }
  records.sort((a, b) => a.slot - b.slot);
  const samples = records.filter(r => r.outcome === "ok").map(r => r.ms!);
  const count = (o: Outcome) => records.filter(r => r.outcome === o).length;
  const statuses: Record<string, number> = {};
  for (const r of records) { const key = r.status === null ? r.outcome : String(r.status); statuses[key] = (statuses[key] ?? 0) + 1; }
  return {
    url: opts.url, label: opts.label ?? opts.url, summary: summarizeLatency(samples), samples, records, statuses,
    expected, attempted: records.filter(r => r.startedAt !== null).length,
    errors: count("error"), skipped: count("skipped"), missing: count("missing"), timeouts: count("timeout"), cancelled: count("cancelled"),
    lateness: summarizeLatency(records.flatMap(r => r.latenessMs === null ? [] : [r.latenessMs])),
    intervalMs, durationMs: opts.durationMs, startedAt: start, endedAt: clock.now(),
  };
}

export function runLoopLagProbe(opts: Omit<ProbeOptions, "url"> & { port: number }): Promise<LoopLagResult> {
  return runLatencyProbe({ ...opts, url: `http://127.0.0.1:${opts.port}/health`, label: "health HTTP RTT (includes tester scheduling)", intervalMs: opts.intervalMs ?? 100 });
}

export interface RouteProbes {
  loopLag: LoopLagResult;
  hookStatus: LatencyProbeResult;
  termSessions: LatencyProbeResult | null;
}

export async function runRouteProbes(opts: {
  port: number;
  durationMs: number;
  startAt?: number;
  authHeaders: Record<string, string> | null;
  signal?: AbortSignal;
  clock?: BenchClock;
  fetch?: ProbeFetch;
  hookRequest?: ProbeOptions["request"];
}): Promise<RouteProbes> {
  const { port } = opts;
  const [loopLag, hookStatus, termSessions] = await Promise.all([
    runLoopLagProbe(opts),
    runLatencyProbe({ ...opts, url: `http://127.0.0.1:${port}/hook/status`, request: opts.hookRequest, expectedStatus: opts.hookRequest ? 200 : 400, label: opts.hookRequest ? "owned hook status" : "invalid hook dispatch only (HTTP 400)" }),
    opts.authHeaders ? runLatencyProbe({ ...opts, url: `http://127.0.0.1:${port}/term/sessions`, headers: opts.authHeaders, label: "authenticated terminal HTTP RTT" }) : Promise.resolve(null),
  ]);
  return { loopLag, hookStatus, termSessions };
}
