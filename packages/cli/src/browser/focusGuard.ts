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

import { spawnSync } from "../proc.js";
import { readState } from "./instance.js";
import { raiseAppByPidSync } from "./raiseApp.js";

/** ASN key of the frontmost app — cheap (one spawn), stable per app, so a
 *  poller can compare it between ticks and resolve the pid only on change. */
export function frontAsn(): string | null {
  if (process.platform !== "darwin") return null;
  try {
    const asn = spawnSync("lsappinfo", ["front"], { encoding: "utf-8", timeout: 3_000 });
    const key = (asn.stdout ?? "").trim();
    return asn.status === 0 && key ? key : null;
  } catch {
    return null;
  }
}

/** Resolve an ASN key from frontAsn() to its pid. */
export function pidForAsn(key: string): number | null {
  try {
    const info = spawnSync("lsappinfo", ["info", "-only", "pid", key], { encoding: "utf-8", timeout: 3_000 });
    const pid = parseInt(/=\s*(\d+)/.exec(info.stdout ?? "")?.[1] ?? "", 10);
    return pid > 0 ? pid : null;
  } catch {
    return null;
  }
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
