/**
 * Who holds the worker hosts, and the two routers that use them.
 *
 * Every module that spawns a child process reaches this file, because `proc.ts`
 * does. That makes it the widest import in the CLI, and until ct-49758 it was
 * also a static edge into `host.js` and `operations.js` — so `cast --help` and
 * a mistyped verb loaded the worker host, the frame protocol and all six
 * payload validators, thirteen modules in all, to run code that checks a null
 * and returns.
 *
 * Only `configureDaemonWorkers` ever needs the real modules, and only the
 * daemon calls it. So it loads them, and hands what the routers need to
 * `runtime` on its way through; everything else here holds `import type` and
 * costs nothing. `routeProbe` cannot reach `runtime` while it is null, because
 * the same call that sets it is the one that creates `probe`.
 */

import type { WorkerHost, WorkerHostOptions } from "./host.js";
import type { ProbeOptions, ProbeResult } from "./operations.js";

let probe: WorkerHost | null = null;
let scan: WorkerHost | null = null;
let ingest: WorkerHost | null = null;

/** The values `routeProbe` needs, captured when the workers were turned on. */
let runtime: {
  probeForExec: typeof import("./operations.js").probeForExec;
  WorkerUnavailable: typeof import("./host.js").WorkerUnavailable;
} | null = null;

export async function configureDaemonWorkers(enabled: boolean, options: WorkerHostOptions = {}, scanOptions: WorkerHostOptions = {}, ingestOptions: WorkerHostOptions = {}): Promise<WorkerHost | null> {
  closeDaemonWorkers();
  if (enabled && process.env.CODECAST_WORKER !== "1" && process.platform !== "win32") {
    const [host, operations] = await Promise.all([import("./host.js"), import("./operations.js")]);
    runtime = { probeForExec: operations.probeForExec, WorkerUnavailable: host.WorkerUnavailable };
    probe = new host.WorkerHost("probe", options);
    scan = new host.WorkerHost("scan", scanOptions);
    ingest = new host.WorkerHost("ingest", ingestOptions);
  }
  return probe;
}

export function closeDaemonWorkers() { probe?.close(); scan?.close(); ingest?.close(); probe = null; scan = null; ingest = null; }
export function scanWorkerHost(): WorkerHost | null { return scan; }
export function ingestWorkerHost(): WorkerHost | null { return ingest; }
export function daemonWorkersEnabled(): boolean { return probe !== null; }

export function routeProbe<T>(file: string, args: string[], options: unknown, fallback: (options: unknown) => Promise<T>): Promise<T> {
  const payload = probe && runtime && process.env.CODECAST_WORKER !== "1" ? runtime.probeForExec(file, args, options) : null;
  if (!payload || !probe || !runtime) return fallback(options);
  const host = probe;
  const { WorkerUnavailable } = runtime;
  const deadline = Date.now() + (payload.options.timeout ?? 30_000);
  return host.request("read", payload, { timeoutMs: deadline - Date.now() }).then(value => {
    const r = value as ProbeResult;
    if (r.status === 0) return { stdout: r.stdout, stderr: r.stderr } as T;
    throw Object.assign(new Error(`${payload.operation} probe failed`), { code: r.code ?? r.status, status: r.status, signal: r.signal, killed: r.killed, stdout: r.stdout, stderr: r.stderr });
  }).catch(error => {
    if (!(error instanceof WorkerUnavailable) || host.state.closed) throw error;
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw Object.assign(new Error(`${payload.operation} probe timed out`), { code: "ETIMEDOUT", status: null, signal: "SIGKILL", killed: true, stdout: "", stderr: "" });
    return fallback({ ...(options as ProbeOptions), timeout: remaining });
  });
}
