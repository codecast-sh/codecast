/**
 * Per-workspace headless Chromium launcher.
 *
 * Spawns one Chrome instance per workspace with:
 *   - Unique CDP port for programmatic control (claude-in-chrome, Playwright, raw CDP)
 *   - Isolated user-data-dir so cookies/localStorage don't bleed across workspaces
 *   - Headless mode by default; non-headless available for visual debugging
 *
 * Design choices:
 *   - We do NOT bundle a Chromium binary. We discover the system's Chrome by
 *     probing well-known paths and the PATH env. Users on machines without
 *     Chrome get a clear error.
 *   - The launched process is detached so it survives a daemon restart, but we
 *     persist its pid so we can SIGTERM it on workspace release.
 *   - --remote-debugging-port=0 would let Chrome pick a free port but we'd
 *     have to parse it from DevToolsActivePort file. Instead we get a
 *     pre-validated free port from the ports module (same primitive
 *     allocatePorts uses) and pass it explicitly.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { isPortFree } from "./ports.js";

export interface ChromeInstance {
  /** OS process id of the spawned Chromium. */
  pid: number;
  /** CDP port the instance is listening on (devtools protocol). */
  cdpPort: number;
  /** Isolated user-data-dir on disk. */
  userDataDir: string;
  /** Whether --headless=new was used. */
  headless: boolean;
  /** Resolved path to the Chromium binary that was launched. */
  binaryPath: string;
}

export interface LaunchChromeOptions {
  /** CDP port to bind. Should already be probed free. */
  cdpPort: number;
  /** Where to put the isolated profile. Created if absent. */
  userDataDir: string;
  /** Default true. Pass false for visual debugging. */
  headless?: boolean;
  /** Override binary path (else auto-detect). */
  binaryPath?: string;
  /** Max seconds to wait for CDP port to become listening. Default 8. */
  readyTimeoutSec?: number;
  /** Extra args appended after the standard set. */
  extraArgs?: string[];
}

export class ChromeNotFoundError extends Error {
  constructor(probed: string[]) {
    super(
      `Could not find a Chromium binary. Set CODECAST_CHROMIUM env var, or install Chrome/Chromium. Tried: ${probed.join(", ")}`,
    );
    this.name = "ChromeNotFoundError";
  }
}

export class ChromeLaunchError extends Error {
  constructor(message: string, public readonly pid?: number) {
    super(message);
    this.name = "ChromeLaunchError";
  }
}

/**
 * Resolve the Chromium/Chrome binary path. Returns null if none found
 * (callers should throw ChromeNotFoundError with the probe list).
 */
export function findChromeBinary(): string | null {
  const probes = chromeBinaryProbes();
  for (const p of probes) {
    try {
      if (fs.existsSync(p) && !fs.statSync(p).isDirectory()) return p;
    } catch {
      /* ignore */
    }
  }
  return null;
}

/** Probe list (in priority order). Exported for error reporting. */
export function chromeBinaryProbes(): string[] {
  const env = process.env.CODECAST_CHROMIUM;
  const probes: string[] = [];
  if (env) probes.push(env);
  // macOS app bundles
  probes.push("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
  probes.push("/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary");
  probes.push("/Applications/Chromium.app/Contents/MacOS/Chromium");
  // Linux package names
  probes.push("/usr/bin/google-chrome");
  probes.push("/usr/bin/google-chrome-stable");
  probes.push("/usr/bin/chromium");
  probes.push("/usr/bin/chromium-browser");
  // Snap (Linux)
  probes.push("/snap/bin/chromium");
  return probes;
}

/** Default args used for every launch. CDP + isolation + automation-friendly. */
function defaultArgs(opts: LaunchChromeOptions): string[] {
  return [
    `--remote-debugging-port=${opts.cdpPort}`,
    `--user-data-dir=${opts.userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    // Disable Chrome's own update / metrics / telemetry side-channels.
    "--disable-background-networking",
    "--disable-sync",
    "--disable-default-apps",
    // Reduce flakiness in CI/sandbox environments.
    "--disable-dev-shm-usage",
    "--disable-features=Translate,InterestFeedContentSuggestions",
    // Faster startup; we don't need GPU for headless DOM/CDP work.
    ...(opts.headless !== false ? ["--headless=new"] : []),
    "--remote-debugging-address=127.0.0.1",
    "about:blank",
  ];
}

/**
 * Spawn Chromium and wait until its CDP endpoint is reachable.
 */
export async function launchChrome(opts: LaunchChromeOptions): Promise<ChromeInstance> {
  const binaryPath = opts.binaryPath ?? findChromeBinary();
  if (!binaryPath) {
    throw new ChromeNotFoundError(chromeBinaryProbes());
  }

  fs.mkdirSync(opts.userDataDir, { recursive: true });
  const args = [...defaultArgs(opts), ...(opts.extraArgs ?? [])];

  const child = spawn(binaryPath, args, {
    stdio: ["ignore", "ignore", "ignore"],
    detached: true,
  });

  // Detach from parent so it survives daemon restart. We track its pid.
  child.unref();

  if (!child.pid) {
    throw new ChromeLaunchError("Chromium spawn returned no pid");
  }
  const pid = child.pid;

  const readyTimeoutMs = (opts.readyTimeoutSec ?? 8) * 1000;
  const deadline = Date.now() + readyTimeoutMs;
  // CDP port goes from free → bound when Chrome is ready.
  // We poll isPortFree until it returns false (i.e., Chrome is listening).
  while (Date.now() < deadline) {
    // If the child crashed early, fail fast.
    if (!isPidAlive(pid)) {
      throw new ChromeLaunchError(
        `Chromium exited before CDP became ready (pid ${pid})`,
        pid,
      );
    }
    if (!(await isPortFree(opts.cdpPort))) {
      return {
        pid,
        cdpPort: opts.cdpPort,
        userDataDir: opts.userDataDir,
        headless: opts.headless !== false,
        binaryPath,
      };
    }
    await sleep(150);
  }
  // Timed out — kill the orphan before throwing.
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    /* ignore */
  }
  throw new ChromeLaunchError(
    `Chromium CDP port ${opts.cdpPort} did not become listening within ${opts.readyTimeoutSec ?? 8}s`,
    pid,
  );
}

/** Politely stop a Chrome instance: SIGTERM, then SIGKILL after timeout. */
export async function stopChrome(
  pid: number,
  opts: { timeoutMs?: number } = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 3000;
  if (!isPidAlive(pid)) return;

  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return; // already gone
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return;
    await sleep(100);
  }
  // Escalate.
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    /* ignore */
  }
}

/** Returns true if a process with `pid` is alive. Cheap; uses signal 0. */
export function isPidAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // EPERM means the process exists but we don't own it — still alive.
    return code === "EPERM";
  }
}
