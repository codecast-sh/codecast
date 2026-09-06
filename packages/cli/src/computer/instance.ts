/**
 * State between `cast computer` invocations, in a file rather than memory.
 *
 * Every `cast computer` command is a fresh short-lived process, exactly like
 * `cast browser`. Element indexes come from the previous `get-app-state`, so a
 * helper that died with its client would hand back `element_not_found` on the
 * second command of every loop. The resolution is the one `cast browser`
 * already uses: the CLI is short lived, the helper persists, and this file
 * connects them (browser/instance.ts:1-12).
 *
 * Liveness is three-state for the reason recorded there too. The 2026-08-14
 * restart stampede came from conflating "not answering" with "not there": a
 * snapshot of a large Electron window genuinely takes seconds, and every
 * parallel agent relaunching the helper turns one slow call into a herd. So
 * `unresponsive` is reported as a busy helper and NEVER killed.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { atomicWriteFile } from "../atomicWrite.js";
import { acquireFileLock } from "../lockFile.js";
import { execSync } from "../proc.js";
import { isPidAlive } from "../workspace/chrome.js";
import { computerHome } from "./helperApp.js";
import { COMPUTER_PROTOCOL_VERSION } from "./types.js";

export interface ComputerInstanceState {
  pid: number;
  socketPath: string;
  socketDir: string;
  /** 32 random bytes as hex, minted per launch. Not the daemon's loopback
   *  token: that one authenticates the web over TCP and outlives restarts by
   *  design, this one dies with its helper. */
  token: string;
  helperPath: string;
  protocolVersion: number;
  startedAt: number;
}

export function instancePath(): string {
  return path.join(computerHome(), "instance.json");
}

export function readInstance(): ComputerInstanceState | null {
  let parsed: Partial<ComputerInstanceState>;
  try {
    parsed = JSON.parse(fs.readFileSync(instancePath(), "utf-8")) as Partial<ComputerInstanceState>;
  } catch {
    return null;
  }
  if (typeof parsed.pid !== "number" || typeof parsed.socketPath !== "string" || typeof parsed.token !== "string") return null;
  if (!parsed.pid || !parsed.socketPath || !parsed.token) return null;
  return {
    pid: parsed.pid,
    socketPath: parsed.socketPath,
    socketDir: typeof parsed.socketDir === "string" ? parsed.socketDir : path.dirname(parsed.socketPath),
    token: parsed.token,
    helperPath: typeof parsed.helperPath === "string" ? parsed.helperPath : "",
    protocolVersion: typeof parsed.protocolVersion === "number" ? parsed.protocolVersion : COMPUTER_PROTOCOL_VERSION,
    startedAt: typeof parsed.startedAt === "number" ? parsed.startedAt : 0,
  };
}

/** Publishes by rename (atomicWrite.ts), so a crash mid-write can never leave
 *  a torn file — a reader that saw one would conclude no helper is running and
 *  launch a second one over the live one. */
export function writeInstance(state: ComputerInstanceState): void {
  fs.mkdirSync(computerHome(), { recursive: true, mode: 0o700 });
  atomicWriteFile(instancePath(), JSON.stringify(state, null, 2), { mode: 0o600 });
}

export function clearInstance(): void {
  try {
    fs.unlinkSync(instancePath());
  } catch {
    /* already gone */
  }
}

export type Liveness = "live" | "unresponsive" | "dead";

/**
 * Three states, because "busy" and "gone" demand opposite reactions.
 *
 * `dead`   — no file, or the pid is gone. Launching a fresh helper is safe.
 * `unresponsive` — the pid is alive but the socket did not answer in time.
 *                  Report `action_timeout`; do not kill, do not relaunch.
 * `live`   — the socket answered a handshake at the required protocol version.
 *
 * `probe` is injected so this stays free of socket code and testable without
 * one; the client supplies the real connect-and-handshake.
 */
export async function probeLiveness(
  state: ComputerInstanceState | null,
  probe: (state: ComputerInstanceState, timeoutMs: number) => Promise<boolean>,
  patienceMs = 4_000,
): Promise<Liveness> {
  if (!state || !isPidAlive(state.pid)) return "dead";
  const deadline = Date.now() + patienceMs;
  for (;;) {
    const left = deadline - Date.now();
    if (left <= 0) return "unresponsive";
    if (await probe(state, Math.min(Math.max(left, 250), 2_000))) return "live";
    if (!isPidAlive(state.pid)) return "dead";
    const remaining = deadline - Date.now();
    if (remaining <= 0) return "unresponsive";
    await new Promise((r) => setTimeout(r, Math.min(200, remaining)));
  }
}

/** Serialize launches across processes, so two invocations that both read
 *  "dead" do not start two helpers. The loser re-reads the file and finds the
 *  winner's helper. */
export function acquireStartLock(waitMs = 30_000, onWait?: (holderPid: number) => void): Promise<() => void> {
  return acquireFileLock(path.join(computerHome(), "start.lock"), { waitMs, onWait, describe: "cast computer" });
}

/**
 * Helpers stranded by a crash, found the way `strayPids` finds stray Chromes.
 *
 * The `--` before the pattern matters: it begins with `--agent`, which pgrep
 * would otherwise read as an option and reject — silently finding nothing.
 */
export function strayHelperPids(socketDir: string): number[] {
  try {
    const out = execSync(`pgrep -f -- ${JSON.stringify(`--agent ${socketDir}`)}`, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out
      .split("\n")
      .map((line) => parseInt(line.trim(), 10))
      .filter((pid) => pid && pid !== process.pid);
  } catch {
    // pgrep exits non-zero when nothing matches — the common case.
    return [];
  }
}
