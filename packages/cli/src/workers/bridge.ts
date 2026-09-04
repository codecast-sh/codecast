import { WorkerHost, WorkerUnavailable, type WorkerHostOptions } from "./host.js";
import { probeForExec, type ProbeOptions, type ProbeResult } from "./operations.js";
let probe: WorkerHost | null = null;
let scan: WorkerHost | null = null;
export function configureDaemonWorkers(enabled: boolean, options: WorkerHostOptions = {}, scanOptions: WorkerHostOptions = {}): WorkerHost | null {
  closeDaemonWorkers();
  if (enabled && process.env.CODECAST_WORKER !== "1" && process.platform !== "win32") {
    probe = new WorkerHost("probe", options);
    scan = new WorkerHost("scan", scanOptions);
  }
  return probe;
}
export function closeDaemonWorkers() { probe?.close(); scan?.close(); probe = null; scan = null; }
export function scanWorkerHost(): WorkerHost | null { return scan; }
export function daemonWorkersEnabled(): boolean { return probe !== null; }
export function routeProbe<T>(file: string, args: string[], options: unknown, fallback: (options: unknown) => Promise<T>): Promise<T> {
  const payload = probe && process.env.CODECAST_WORKER !== "1" ? probeForExec(file, args, options) : null;
  if (!payload || !probe) return fallback(options);
  const host = probe;
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
