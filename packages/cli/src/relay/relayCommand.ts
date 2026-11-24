import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AGENT_SCRUBBED_ENV_VARS } from "../agentEnv.js";
import { resolveCastInvocation } from "../castInvocation.js";
import { defaultConfigDir } from "../config/configDir.js";
import { isProcessRunning, readPidFile, releasePidFileIfOwned, tryAcquirePidFileLock } from "../pidFileLock.js";
import { spawn } from "../proc.js";
import { Relay, type PendingRow, type RelayClient } from "./relay.js";
import { createTargetAdapter, LONGEST_ADAPTER_TIMEOUT_MS, type TargetAdapter } from "./targets.js";

export type RelayIntervals = {
  heartbeat: number;
  retry: number;
  sweep: number;
  resubscribeMin: number;
  resubscribeMax: number;
  replaceWait: number;
  drain: number;
};

export const DRAIN_MS = LONGEST_ADAPTER_TIMEOUT_MS + 1_000;
export const REPLACE_WAIT_MS = DRAIN_MS + 4_000;

export const DEFAULT_INTERVALS: RelayIntervals = {
  heartbeat: 45_000,
  retry: 15_000,
  sweep: 60_000,
  resubscribeMin: 1_000,
  resubscribeMax: 60_000,
  replaceWait: REPLACE_WAIT_MS,
  drain: DRAIN_MS,
};

export type RelayConvexClient = RelayClient & {
  onUpdate(name: string, args: Record<string, unknown>, onResult: (value: any) => void, onError: (err: Error) => void): () => void;
  close(): Promise<void> | void;
};

export type RelayConfig = { auth_token?: string; convex_url?: string };

export type RelayRuntimeDeps = {
  config: RelayConfig | null;
  readConfig: () => RelayConfig | null;
  deviceId: string;
  isRunning: () => boolean;
  acquire: () => boolean;
  release: () => void;
  spawnBackground: () => void;
  runningAuthHash: () => string | null;
  writeAuthHash: (hash: string) => void;
  clearAuthHash: () => void;
  signalRunning: () => void;
  sleep: (ms: number) => Promise<void>;
  makeClient: (convexUrl: string) => RelayConvexClient;
  adapter: TargetAdapter;
  log: (line: string) => void;
  onSignal: (handler: () => void) => void;
  intervals?: Partial<RelayIntervals>;
};

export function relayPaths(configDir: string = defaultConfigDir()): { pidFile: string; logFile: string; authFile: string } {
  return { pidFile: path.join(configDir, "relay.pid"), logFile: path.join(configDir, "relay.log"), authFile: path.join(configDir, "relay.auth") };
}

export function authHash(config: RelayConfig): string {
  return crypto.createHash("sha256").update(`${config.convex_url}\n${config.auth_token}`).digest("hex");
}

export function isAuthError(err: unknown): boolean {
  return /Authentication failed|Unauthorized|invalid token|not authenticated/i.test(err instanceof Error ? err.message : String(err));
}

export function relayChildEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = { ...env };
  for (const key of Object.keys(out)) if (key.startsWith("HERDR_")) delete out[key];
  for (const key of ["PASEO_AGENT_ID", ...AGENT_SCRUBBED_ENV_VARS]) delete out[key];
  return out;
}

export function relaySpawnOptions(fd: number, env: NodeJS.ProcessEnv = process.env) {
  return { detached: true, stdio: ["ignore", fd, fd] as ["ignore", number, number], env: relayChildEnv(env), cwd: os.homedir() };
}

export function realRuntimeDeps(readConfig: () => RelayConfig | null, deviceId: string, makeClient: RelayRuntimeDeps["makeClient"]): RelayRuntimeDeps {
  const { pidFile, logFile, authFile } = relayPaths();
  return {
    config: readConfig(),
    readConfig,
    deviceId,
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
      const child = spawn(cmd, [...prefixArgs, "relay"], relaySpawnOptions(fd));
      child.unref();
      fs.closeSync(fd);
    },
    runningAuthHash: () => {
      try {
        return fs.readFileSync(authFile, "utf-8").trim() || null;
      } catch {
        return null;
      }
    },
    writeAuthHash: (hash) => fs.writeFileSync(authFile, `${hash}\n`, { mode: 0o600 }),
    clearAuthHash: () => fs.rmSync(authFile, { force: true }),
    signalRunning: () => {
      const pid = readPidFile(pidFile);
      if (pid) process.kill(pid, "SIGTERM");
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    makeClient,
    adapter: createTargetAdapter(),
    log: (line) => process.stdout.write(`${new Date().toISOString()} ${line}\n`),
    onSignal: (handler) => {
      process.once("SIGINT", handler);
      process.once("SIGTERM", handler);
    },
  };
}

async function startBackground(config: Required<RelayConfig>, deps: RelayRuntimeDeps, every: RelayIntervals): Promise<void> {
  if (!deps.isRunning()) return deps.spawnBackground();
  const running = deps.runningAuthHash();
  if (!running || running === authHash(config)) return deps.log("cast relay is already running");
  deps.log("the running relay uses other credentials; replacing it");
  deps.signalRunning();
  for (let waited = 0; deps.isRunning() && waited < every.replaceWait; waited += 100) await deps.sleep(100);
  if (deps.isRunning()) return deps.log("the running relay did not stop in time; leaving it");
  deps.spawnBackground();
}

export async function runRelayCommand(opts: { background?: boolean }, deps: RelayRuntimeDeps): Promise<number> {
  const every: RelayIntervals = { ...DEFAULT_INTERVALS, ...deps.intervals };
  const config = deps.config;
  if (!config?.auth_token || !config.convex_url) {
    deps.log("not logged in; run: cast auth");
    return opts.background ? 0 : 1;
  }
  const creds = { auth_token: config.auth_token, convex_url: config.convex_url };
  if (opts.background) {
    try {
      await startBackground(creds, deps, every);
    } catch (err) {
      deps.log(`could not start the relay: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
    }
    return 0;
  }
  if (!deps.acquire()) {
    deps.log("cast relay is already running");
    return 0;
  }
  deps.writeAuthHash(authHash(creds));

  const client = deps.makeClient(creds.convex_url);
  const relay = new Relay({ client, adapter: deps.adapter, apiToken: creds.auth_token, deviceId: deps.deviceId, log: deps.log });
  const timers: Array<ReturnType<typeof setInterval>> = [];
  let resubscribeTimer: ReturnType<typeof setTimeout> | null = null;
  let unsubscribe: (() => void) | null = null;
  let backoff = every.resubscribeMin;

  return new Promise<number>((resolve) => {
    let stopping = false;
    const stop = async (code: number, why: string) => {
      if (stopping) return;
      stopping = true;
      deps.log(`stopping: ${why}`);
      timers.forEach(clearInterval);
      if (resubscribeTimer) clearTimeout(resubscribeTimer);
      try { unsubscribe?.(); } catch {}
      let drainTimer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([relay.idle(), new Promise((r) => { drainTimer = setTimeout(r, every.drain); })]);
      clearTimeout(drainTimer);
      try { await client.close(); } catch {}
      deps.clearAuthHash();
      deps.release();
      resolve(code);
    };

    const onSubscriptionError = (err: Error) => {
      if (stopping) return;
      try { unsubscribe?.(); } catch {}
      unsubscribe = null;
      if (isAuthError(err)) return void stop(1, `subscription error: ${err.message.split("\n")[0]}`);
      deps.log(`subscription error: ${err.message.split("\n")[0]}; resubscribing in ${backoff}ms`);
      resubscribeTimer = setTimeout(subscribe, backoff);
      backoff = Math.min(backoff * 2, every.resubscribeMax);
    };

    const subscribe = () => {
      if (stopping) return;
      try { unsubscribe?.(); } catch {}
      try {
        unsubscribe = client.onUpdate(
          "pendingMessages:pendingForDevice",
          { api_token: creds.auth_token, device_id: deps.deviceId },
          (rows: PendingRow[]) => {
            backoff = every.resubscribeMin;
            void relay.onRows(rows ?? []);
          },
          onSubscriptionError,
        );
      } catch (err) {
        onSubscriptionError(err instanceof Error ? err : new Error(String(err)));
      }
    };

    const beat = () => {
      const fresh = deps.readConfig();
      if (fresh && (fresh.auth_token !== creds.auth_token || fresh.convex_url !== creds.convex_url)) {
        return void stop(0, "credentials changed; the next --background starts a fresh relay");
      }
      void relay.heartbeat();
    };

    deps.onSignal(() => void stop(0, "signal"));
    deps.log(`relay started for device ${deps.deviceId}`);
    subscribe();
    void relay.heartbeat();
    void relay.sweep();
    timers.push(
      setInterval(beat, every.heartbeat),
      setInterval(() => void relay.tick(), every.retry),
      setInterval(() => void relay.sweep(), every.sweep),
    );
  });
}
