/**
 * Return focus stolen by any agent-driven Chrome, machine-wide.
 *
 * focusGuard.ts protects the human only from raises that happen inside a
 * `cast browser` command — it brackets the engine call. But agents also drive
 * Chromes AROUND cast: scratch rig scripts hitting raw CDP (`/json/activate`
 * before a screenshot), fresh headed Chrome launches, forks of the engine.
 * Each of those activates Chrome over whatever the human is typing in, and no
 * bracket exists to notice. Observed 2026-08-26: a two-identity call rig took
 * dozens of screenshots, each one pulling its Chrome to the front.
 *
 * This sentinel is the daemon-level answer: watch the frontmost app, and when
 * it becomes an agent-driven Chrome, hand focus straight back to the app the
 * human was in (raiseApp.ts). "Agent-driven" is read off the process command
 * line — a headed Chrome listening for CDP with its own profile dir — so the
 * human's real Chrome is never touched.
 *
 * Two kinds of front-switch are legitimate and spared:
 *  - a deliberate raise: `cast browser login` and the web's "open tab" link
 *    both funnel through focusBrowserTab, which stamps noteDeliberateRaise()
 *    (same process, the daemon) — and login also stamps
 *    InstanceState.loginRaisedAt (a CLI process the daemon can't see).
 *  - the human clicking into the window: a click activates an app, so a left
 *    or right mouse-down within the last couple of seconds means a person did
 *    this. Read via CGEventSourceSecondsSinceLastEventType (bun:ffi, no
 *    spawn). Cmd-tabbing into an agent Chrome is indistinguishable from a
 *    steal and bounces — click the window instead.
 *
 * If the click detector cannot load, the sentinel stays off: without it a
 * human clicking into the agent browser would be bounced out, which is worse
 * than the theft.
 */

import { spawnSync } from "../proc.js";
import { frontAsnAsync, pidForAsnAsync } from "./focusGuard.js";
import { raiseAppByPid } from "./raiseApp.js";
import { readState } from "./instance.js";

/** How long after a deliberate raise the sentinel leaves the front alone. */
export const DELIBERATE_RAISE_GRACE_MS = 120_000;
/** A mouse-down this recent means the human activated the window themselves. */
export const HUMAN_CLICK_GRACE_S = 2;

let lastDeliberateRaiseAt = 0;

/** Called by focusBrowserTab just before it raises: this front-switch is wanted. */
export function noteDeliberateRaise(): void {
  lastDeliberateRaiseAt = Date.now();
}

/**
 * A Chrome an agent is driving: headed, listening for CDP, on its own profile
 * dir. The human's real Chrome runs with none of these; a headless one cannot
 * take focus in the first place.
 */
export function isAgentChromeCommand(cmd: string): boolean {
  return /--remote-debugging-port=\d+/.test(cmd) && /--user-data-dir=/.test(cmd) && !/--headless/.test(cmd);
}

/** The whole policy, pure: bounce exactly the unprovoked machine raise. */
export function shouldRestoreFocus(i: {
  agentChrome: boolean;
  msSinceDeliberateRaise: number;
  secondsSinceClick: number;
}): boolean {
  if (!i.agentChrome) return false;
  if (i.msSinceDeliberateRaise < DELIBERATE_RAISE_GRACE_MS) return false;
  if (i.secondsSinceClick <= HUMAN_CLICK_GRACE_S) return false;
  return true;
}

/** Seconds since the last mouse-down, via CoreGraphics — or null when the
 *  symbol can't load (non-darwin, no bun:ffi), which turns the sentinel off. */
async function loadClickAge(): Promise<(() => number) | null> {
  if (process.platform !== "darwin") return null;
  try {
    const { dlopen, FFIType } = await import("bun:ffi");
    const cg = dlopen("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics", {
      CGEventSourceSecondsSinceLastEventType: { args: [FFIType.i32, FFIType.u32], returns: FFIType.f64 },
    });
    const since = cg.symbols.CGEventSourceSecondsSinceLastEventType;
    // kCGEventSourceStateHIDSystemState = 1; left mouse down = 1, right = 3.
    const age = () => Math.min(Number(since(1, 1)), Number(since(1, 3)));
    age(); // probe now so a broken symbol disables the sentinel, not a tick
    return age;
  } catch {
    return null;
  }
}

/** ps read of one pid's command line; "" for a pid that is already gone. */
function commandOfPid(pid: number): string {
  try {
    const r = spawnSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf-8", timeout: 3_000 });
    return (r.stdout ?? "").trim();
  } catch {
    return "";
  }
}

/**
 * Arm the sentinel. One `lsappinfo front` per tick; everything else (pid,
 * command line, instance.json) only on an actual front-app change, so the
 * idle cost stays at one small spawn a second.
 */
export async function startFocusSentinel(log: (line: string) => void): Promise<NodeJS.Timeout | null> {
  const clickAge = await loadClickAge();
  if (!clickAge) {
    if (process.platform === "darwin") log("[FOCUS] sentinel off: mouse-click detector unavailable");
    return null;
  }
  let lastAsn: string | null = null;
  let lastHumanPid: number | null = null;
  const agentByPid = new Map<number, boolean>();
  log("[FOCUS] sentinel armed: unprovoked raises by agent-driven Chromes will be bounced");

  // One probe in flight at a time: a slow lsappinfo must not stack ticks.
  let inFlight = false;
  const tick = async () => {
    if (inFlight) return;
    inFlight = true;
    try {
      const asn = await frontAsnAsync();
      if (!asn || asn === lastAsn) return;
      lastAsn = asn;
      const pid = await pidForAsnAsync(asn);
      if (!pid) return;
      if (!agentByPid.has(pid)) {
        if (agentByPid.size > 256) agentByPid.clear();
        agentByPid.set(pid, isAgentChromeCommand(commandOfPid(pid)));
      }
      if (!agentByPid.get(pid)) {
        lastHumanPid = pid;
        return;
      }
      const loginRaisedAt = readState()?.loginRaisedAt ?? 0;
      const restore = shouldRestoreFocus({
        agentChrome: true,
        msSinceDeliberateRaise: Date.now() - Math.max(lastDeliberateRaiseAt, loginRaisedAt),
        secondsSinceClick: clickAge(),
      });
      if (restore && lastHumanPid) {
        log(`[FOCUS] agent Chrome ${pid} took the front unprovoked — returning focus to pid ${lastHumanPid}`);
        raiseAppByPid(lastHumanPid, log);
        lastAsn = null; // re-read next tick; the raise lands async
      }
    } finally {
      inFlight = false;
    }
  };
  return setInterval(() => { void tick(); }, 1_000);
}
