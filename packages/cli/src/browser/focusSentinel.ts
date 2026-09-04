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
 *  - the human choosing the window with Cmd-Tab or Option-Tab: the physical
 *    chord is sampled through CoreGraphics and remembered across the app switch.
 *  - the human clicking into the window: a click activates an app, so a left
 *    or right mouse-down within the last couple of seconds means a person did
 *    this. Read via CoreGraphics as well (bun:ffi, no spawn).
 *
 * If the input detector cannot load, the sentinel stays off: without it a
 * human clicking into the agent browser would be bounced out, which is worse
 * than the theft.
 */

import { execFileAsync } from "../proc.js";
import { frontAsnAsync, pidForAsnAsync } from "./focusGuard.js";
import { raiseAppByPid } from "./raiseApp.js";
import { readState } from "./instance.js";

/** How long after a deliberate raise the sentinel leaves the front alone. */
export const DELIBERATE_RAISE_GRACE_MS = 120_000;
/** A mouse-down this recent means the human activated the window themselves. */
export const HUMAN_CLICK_GRACE_S = 2;
export const HUMAN_APP_SWITCH_GRACE_MS = 2_000;

const TAB_KEY_CODE = 48;
const APP_SWITCH_FLAGS = (1n << 20n) | (1n << 19n);

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

export function isAppSwitchChord(tabDown: boolean, flags: bigint): boolean {
  return tabDown && (flags & APP_SWITCH_FLAGS) !== 0n;
}

/** The whole policy, pure: bounce exactly the unprovoked machine raise. */
export function shouldRestoreFocus(i: {
  agentChrome: boolean;
  msSinceDeliberateRaise: number;
  msSinceAppSwitch: number;
  secondsSinceClick: number;
}): boolean {
  if (!i.agentChrome) return false;
  if (i.msSinceDeliberateRaise < DELIBERATE_RAISE_GRACE_MS) return false;
  if (i.msSinceAppSwitch <= HUMAN_APP_SWITCH_GRACE_MS) return false;
  if (i.secondsSinceClick <= HUMAN_CLICK_GRACE_S) return false;
  return true;
}

/** Seconds since the last mouse-down, via CoreGraphics — or null when the
 *  symbol can't load (non-darwin, no bun:ffi), which turns the sentinel off. */
async function loadHumanInput(): Promise<{ clickAge: () => number; appSwitchAge: () => number } | null> {
  if (process.platform !== "darwin") return null;
  try {
    const { dlopen, FFIType } = await import("bun:ffi");
    const cg = dlopen("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics", {
      CGEventSourceSecondsSinceLastEventType: { args: [FFIType.i32, FFIType.u32], returns: FFIType.f64 },
      CGEventSourceKeyState: { args: [FFIType.i32, FFIType.u16], returns: FFIType.bool },
      CGEventSourceFlagsState: { args: [FFIType.i32], returns: FFIType.u64 },
    });
    const since = cg.symbols.CGEventSourceSecondsSinceLastEventType;
    const keyState = cg.symbols.CGEventSourceKeyState;
    const flagsState = cg.symbols.CGEventSourceFlagsState;
    const clickAge = () => Math.min(Number(since(1, 1)), Number(since(1, 3)));
    let lastAppSwitchAt = 0;
    const sampleAppSwitch = () => {
      const tabDown = Boolean(keyState(1, TAB_KEY_CODE));
      const flags = BigInt(flagsState(1));
      if (isAppSwitchChord(tabDown, flags)) lastAppSwitchAt = Date.now();
    };
    clickAge();
    sampleAppSwitch();
    setInterval(sampleAppSwitch, 25).unref?.();
    return { clickAge, appSwitchAge: () => Date.now() - lastAppSwitchAt };
  } catch {
    return null;
  }
}

/** ps read of one pid's command line; "" for a pid that is already gone. */
export async function commandOfPidAsync(pid: number): Promise<string> {
  try {
    const { stdout } = await execFileAsync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf-8", timeout: 3_000 });
    return (stdout ?? "").trim();
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
  const input = await loadHumanInput();
  if (!input) {
    if (process.platform === "darwin") log("[FOCUS] sentinel off: human-input detector unavailable");
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
        agentByPid.set(pid, isAgentChromeCommand(await commandOfPidAsync(pid)));
      }
      if (!agentByPid.get(pid)) {
        lastHumanPid = pid;
        return;
      }
      const loginRaisedAt = readState()?.loginRaisedAt ?? 0;
      const restore = shouldRestoreFocus({
        agentChrome: true,
        msSinceDeliberateRaise: Date.now() - Math.max(lastDeliberateRaiseAt, loginRaisedAt),
        msSinceAppSwitch: input.appSwitchAge(),
        secondsSinceClick: input.clickAge(),
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
