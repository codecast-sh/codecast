import path from "node:path";
import { scrubAgentEnv } from "../agentEnv.js";
import type { WorkerKind } from "./operations.js";
export function workerInvocation(kind: WorkerKind, execPath = process.execPath, entry = process.argv[1] ?? ""): { command: string; args: string[] } {
  if (/\.(?:[cm]?js|ts)$/.test(entry) && !entry.startsWith("/$bunfs/") && !entry.includes("~BUN/")) {
    if (!/^(?:main|daemon|index)\.(?:[cm]?js|ts)$/.test(path.basename(entry))) throw new Error("worker requires a CLI entry or explicit invocation");
    const ext = entry.endsWith(".ts") ? ".ts" : ".js";
    return { command: execPath, args: [path.join(path.dirname(entry), `main${ext}`), "_worker", kind] };
  }
  return { command: execPath, args: ["_worker", kind] };
}
export function workerEnv(env: NodeJS.ProcessEnv, parentPid = process.pid): NodeJS.ProcessEnv {
  const out = scrubAgentEnv({ ...env });
  for (const k of Object.keys(out)) {
    if (/^(?:CODEX_THREAD_ID|CODEX_SESSION_ID|CODECAST_SESSION_ID|CLAUDE_SESSION_ID|XPC_SERVICE_NAME|NODE_OPTIONS|BUN_OPTIONS|CONVEX_DEPLOY_KEY|CODECAST_AUTH_TOKEN)$/.test(k)) delete out[k];
  }
  out.CODECAST_WORKER = "1";
  out.CODECAST_WORKER_PARENT_PID = String(parentPid);
  return out;
}
export function killWorkerGroup(pid: number) {
  if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) return;
  try { process.kill(-pid, "SIGKILL"); } catch { try { process.kill(pid, "SIGKILL"); } catch {} }
}
