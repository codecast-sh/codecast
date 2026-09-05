/**
 * Keep the human's focus where it was while the engine drives Chrome.
 *
 * The engine raises the managed Chrome as a side effect of ordinary work:
 * `Target.createTarget` without `background: true` when it pins a fresh tab,
 * `Page.bringToFront` on every tab switch, `Target.activateTarget` when it
 * revives a tab Memory Saver discarded. On macOS each of those pulls Chrome in
 * front of whatever the human is working in — and with a fleet of agents
 * sharing the one managed browser, that means constantly (verified 2026-08-15:
 * both calls steal app focus on Darwin 25). The window must stay visible — one
 * shared browser the human can look at — so headless is not an answer.
 *
 * pinnedTab.ts removes the most common raise at the source. This guard catches
 * the rest: bracket every engine call, note who has focus before, and if the
 * managed Chrome is frontmost afterwards when it was not before, hand focus
 * straight back to the app the human was in (raiseApp.ts). The deliberate
 * raise — the web's "open tab" link — goes through the daemon's focus route,
 * not through runEngine, so it is never undone.
 */

import { execFileAsync, spawnSync } from "../proc.js";
import { readState } from "./instance.js";
import { raiseAppByPidSync } from "./raiseApp.js";

const LSAPPINFO_TIMEOUT_MS = 3_000;

function parseAsn(status: number | null, stdout: string): string | null {
  const key = stdout.trim();
  return status === 0 && key ? key : null;
}

function parsePid(stdout: string): number | null {
  const pid = parseInt(/=\s*(\d+)/.exec(stdout)?.[1] ?? "", 10);
  return pid > 0 ? pid : null;
}

/** ASN key of the frontmost app — cheap (one spawn), stable per app, so a
 *  poller can compare it between ticks and resolve the pid only on change. */
function frontAsn(): string | null {
  if (process.platform !== "darwin") return null;
  try {
    const asn = spawnSync("lsappinfo", ["front"], { encoding: "utf-8", timeout: LSAPPINFO_TIMEOUT_MS });
    return parseAsn(asn.status, asn.stdout ?? "");
  } catch {
    return null;
  }
}

/** Resolve an ASN key from frontAsn() to its pid. */
function pidForAsn(key: string): number | null {
  try {
    const info = spawnSync("lsappinfo", ["info", "-only", "pid", key], { encoding: "utf-8", timeout: LSAPPINFO_TIMEOUT_MS });
    return parsePid(info.stdout ?? "");
  } catch {
    return null;
  }
}

// The sync pair above brackets an engine call inside the `cast browser` CLI,
// where blocking is the point. A long-lived poller (the daemon's focus
// sentinel) must not block: `lsappinfo front` takes 1-2s when the machine is
// busy, and inside the daemon that is 1-2s of no delivery, once a second.
async function lsappinfo(args: string[]): Promise<{ status: number | null; stdout: string }> {
  try {
    const { stdout } = await execFileAsync("lsappinfo", args, { encoding: "utf-8", timeout: LSAPPINFO_TIMEOUT_MS });
    return { status: 0, stdout };
  } catch (error) {
    const e = error as { code?: unknown; stdout?: unknown };
    return { status: typeof e.code === "number" ? e.code : 1, stdout: String(e.stdout ?? "") };
  }
}

export async function frontAsnAsync(): Promise<string | null> {
  if (process.platform !== "darwin") return null;
  const r = await lsappinfo(["front"]);
  return parseAsn(r.status, r.stdout);
}

export async function pidForAsnAsync(key: string): Promise<number | null> {
  return parsePid((await lsappinfo(["info", "-only", "pid", key])).stdout);
}

/** Pid of the frontmost app, or null off-macOS / when it cannot be read. */
export function frontAppPid(): number | null {
  const key = frontAsn();
  return key ? pidForAsn(key) : null;
}

/**
 * If the managed Chrome took the front while an engine call ran, give focus
 * back to the app that had it. Only that exact transition: when the human was
 * already in the managed Chrome, or something other than it is frontmost now,
 * nothing moves.
 */
export function restoreFocusIfStolen(beforePid: number | null): void {
  if (beforePid == null) return;
  const chrome = readState()?.pid;
  if (!chrome || beforePid === chrome) return;
  if (frontAppPid() !== chrome) return;
  raiseAppByPidSync(beforePid);
}
