import * as fs from "node:fs";
import * as path from "node:path";
import { AGENT_SCRUBBED_ENV_VARS } from "../agentEnv.js";
import { resolveCastInvocation } from "../castInvocation.js";
import { defaultConfigDir } from "../config/configDir.js";
import { isProcessRunning, readPidFile, releasePidFileIfOwned, tryAcquirePidFileLock } from "../pidFileLock.js";
import { spawn } from "../proc.js";
import { Relay, type PendingRow, type RelayClient } from "./relay.js";
import { createTargetAdapter, type TargetAdapter } from "./targets.js";

export const HEARTBEAT_EVERY_MS = 45_000;
export const RETRY_EVERY_MS = 15_000;
export const SWEEP_EVERY_MS = 60_000;

export type RelayConvexClient = RelayClient & {
  onUpdate(name: string, args: Record<string, unknown>, onResult: (value: any) => void, onError: (err: Error) => void): () => void;
  close(): Promise<void> | void;
};

export type RelayRuntimeDeps = {
  config: { auth_token?: string; convex_url?: string } | null;
  deviceId: string;
  pidFile: string;
  isRunning: () => boolean;
  acquire: () => boolean;
  release: () => void;
  spawnBackground: () => void;
  makeClient: (convexUrl: string) => RelayConvexClient;
  adapter: TargetAdapter;
  log: (line: string) => void;
  onSignal: (handler: () => void) => void;
  intervals?: { heartbeat: number; retry: number; sweep: number };
};

export function relayPaths(configDir: string = defaultConfigDir()): { pidFile: string; logFile: string } {
  return { pidFile: path.join(configDir, "relay.pid"), logFile: path.join(configDir, "relay.log") };
}

export function relayChildEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = { ...env };
  for (const key of Object.keys(out)) if (key.startsWith("HERDR_")) delete out[key];
  for (const key of ["PASEO_AGENT_ID", ...AGENT_SCRUBBED_ENV_VARS]) delete out[key];
  return out;
}

export function realRuntimeDeps(config: RelayRuntimeDeps["config"], deviceId: string, makeClient: RelayRuntimeDeps["makeClient"]): RelayRuntimeDeps {
  const { pidFile, logFile } = relayPaths();
  return {
    config,
    deviceId,
    pidFile,
    isRunning: () => {
      const pid = readPidFile(pidFile);
      return !!pid && pid !== process.pid && isProcessRunning(pid);
    },
    acquire: () => {
      fs.mkdirSync(path.dirname(pidFile), { recursive: true, mode: 0o700 });
      return tryAcquirePidFileLock(pidFile, process.pid);
    },
    release: () => void releasePidFileIfOwned(pidFile, process.pid),
    spawnBackground: () => {
      const { cmd, prefixArgs } = resolveCastInvocation();
      const fd = fs.openSync(logFile, "a", 0o600);
      const child = spawn(cmd, [...prefixArgs, "relay"], { detached: true, stdio: ["ignore", fd, fd], env: relayChildEnv() });
      child.unref();
      fs.closeSync(fd);
    },
    makeClient,
    adapter: createTargetAdapter(),
    log: (line) => process.stdout.write(`${new Date().toISOString()} ${line}\n`),
    onSignal: (handler) => {
      process.once("SIGINT", handler);
      process.once("SIGTERM", handler);
    },
  };
}

export async function runRelayCommand(opts: { background?: boolean }, deps: RelayRuntimeDeps): Promise<number> {
  if (!deps.config?.auth_token || !deps.config.convex_url) {
    deps.log("not logged in; run: cast auth");
    return opts.background ? 0 : 1;
  }
  if (opts.background) {
    try {
      if (deps.isRunning()) deps.log("cast relay is already running");
      else deps.spawnBackground();
    } catch (err) {
      deps.log(`could not start the relay: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
    }
    return 0;
  }
  if (!deps.acquire()) {
    deps.log("cast relay is already running");
    return 0;
  }

  const apiToken = deps.config.auth_token;
  const every = deps.intervals ?? { heartbeat: HEARTBEAT_EVERY_MS, retry: RETRY_EVERY_MS, sweep: SWEEP_EVERY_MS };
  const client = deps.makeClient(deps.config.convex_url);
  const relay = new Relay({ client, adapter: deps.adapter, apiToken, deviceId: deps.deviceId, log: deps.log });
  const timers: Array<ReturnType<typeof setInterval>> = [];
  let unsubscribe: (() => void) | null = null;

  return new Promise<number>((resolve) => {
    let stopping = false;
    const stop = async (code: number, why: string) => {
      if (stopping) return;
      stopping = true;
      deps.log(`stopping: ${why}`);
      timers.forEach(clearInterval);
      try { unsubscribe?.(); } catch {}
      try { await client.close(); } catch {}
      deps.release();
      resolve(code);
    };
    deps.onSignal(() => void stop(0, "signal"));
    deps.log(`relay started for device ${deps.deviceId}`);
    unsubscribe = client.onUpdate(
      "pendingMessages:pendingForDevice",
      { api_token: apiToken, device_id: deps.deviceId },
      (rows: PendingRow[]) => void relay.onRows(rows ?? []),
      (err) => void stop(1, `subscription error: ${err.message.split("\n")[0]}`),
    );
    void relay.heartbeat();
    void relay.sweep();
    timers.push(
      setInterval(() => void relay.heartbeat(), every.heartbeat),
      setInterval(() => void relay.tick(), every.retry),
      setInterval(() => void relay.sweep(), every.sweep),
    );
  });
}
