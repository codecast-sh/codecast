/**
 * Raise a macOS app by pid.
 *
 * How, matters on macOS 14+: a background process may not push another app to
 * the front (`set frontmost` and `NSRunningApplication.activate` silently do
 * nothing while the human's app has focus). What is allowed is an app
 * activating ITSELF, which is what AppleScript's `activate` asks for — so send
 * that Apple event (`misc`/`actv`) addressed to the pid, and the app raises
 * its own window. By pid, not by app name: `tell application "Google Chrome"`
 * would reach the user's real Chrome, a different process from a driven one.
 *
 * Even this is honored only when the sender descends from the ACTIVE app. From
 * the daemon (a launchd process) the event is delivered and answered, and the
 * app stays behind whatever the human is in. So the focus route also returns
 * the pid, and the desktop app, active because the human just clicked in it,
 * repeats the raise from its own process (the "raise-app" verb in
 * packages/electron/main.js).
 *
 * Used in both directions: the web's "open tab" link raises the driven Chrome
 * (focusHttp.ts), and the focus guard raises the app the human was in when an
 * engine command pulled Chrome over it (focusGuard.ts).
 */

import { execFile } from "node:child_process";
import { spawnSync } from "../proc.js";

function raiseJxa(pid: number): string {
  return (
    'ObjC.import("Foundation");' +
    `const target = $.NSAppleEventDescriptor.descriptorWithProcessIdentifier(${Math.floor(pid)});` +
    "const evt = $.NSAppleEventDescriptor.appleEventWithEventClassEventIDTargetDescriptorReturnIDTransactionID(0x6d697363, 0x61637476, target, -1, 0);" +
    // An untouched error slot reads back as a nil wrapper, which is truthy.
    "const err = Ref(); evt.sendEventWithOptionsTimeoutError(1, 10, err); !err[0] || err[0].isNil() ? 'ok' : String(err[0].localizedDescription.js);"
  );
}

/** Fire-and-forget raise, for long-lived processes (the daemon). Best effort. */
export function raiseAppByPid(pid: number, log: (line: string) => void = () => {}): void {
  if (process.platform !== "darwin") return;
  execFile("osascript", ["-l", "JavaScript", "-e", raiseJxa(pid)], (error, stdout, stderr) => {
    const out = `${stdout ?? ""}`.trim();
    if (error || out !== "ok") log(`[BROWSER] raise pid ${pid}: ${error ? error.message : out} ${`${stderr ?? ""}`.trim()}`.trim());
  });
}

/** Blocking raise, for a CLI about to exit — an async child would be killed
 *  by process.exit before the event ever sends. */
export function raiseAppByPidSync(pid: number): void {
  if (process.platform !== "darwin") return;
  spawnSync("osascript", ["-l", "JavaScript", "-e", raiseJxa(pid)], { timeout: 3_000, stdio: "ignore" });
}
