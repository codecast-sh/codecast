/**
 * Which macOS login session this process runs in, and how to reach the
 * desktop one from here.
 *
 * WindowServer serves window captures only to processes inside the user's
 * desktop (Aqua) session. A process started from an SSH login lives in a
 * separate one: its Accessibility calls still work, but every window capture
 * comes back empty even with Screen Recording granted. So a helper spawned
 * from outside Aqua reads trees and acts, and silently has no screenshots.
 * `open -n` hands the bundle to LaunchServices, which starts it inside the
 * user's desktop session wherever the caller happens to be.
 *
 * A user with no desktop session at all (never logged in on the console or
 * over Screen Sharing) has no WindowServer connection to offer; nothing here
 * can drive apps for them.
 */

import { spawnSync } from "../proc.js";
import { ComputerError } from "./errors.js";

export type DesktopSession = "inside" | "outside" | "none";

let cached: DesktopSession | null = null;

export function desktopSession(): DesktopSession {
  if (cached) return cached;
  if (process.platform !== "darwin") return (cached = "inside");
  const manager = spawnSync("/bin/launchctl", ["managername"], { encoding: "utf8", timeout: 5_000 });
  if (manager.status === 0 && manager.stdout.trim() === "Aqua") return (cached = "inside");
  const uid = process.getuid?.() ?? 0;
  const gui = spawnSync("/bin/launchctl", ["print", `gui/${uid}`], { encoding: "utf8", timeout: 5_000 });
  return (cached = gui.status === 0 ? "outside" : "none");
}

/** Launch through LaunchServices rather than spawning directly: forced by the
 *  env switches, or required because this process is outside Aqua. */
export function launchesThroughOpen(): boolean {
  if (process.env.CODECAST_COMPUTER_PERMISSION_ROUTE === "open" || process.env.CODECAST_NO_DISCLAIM === "1") return true;
  return desktopSession() === "outside";
}

/** Why nothing can be driven from here, or null when a desktop exists. */
export function noDesktopSessionReason(): string | null {
  if (desktopSession() !== "none") return null;
  const user = process.env.USER || `uid ${process.getuid?.() ?? "?"}`;
  return `${user} has no macOS desktop session on this machine; cast computer drives apps in a logged-in desktop. Sign ${user} in on the console or over Screen Sharing, or run as the user who is.`;
}

export function requireDesktopSession(): void {
  const reason = noDesktopSessionReason();
  if (reason) throw new ComputerError("unsupported_capability", reason);
}

export function runOpen(args: string[], what: string): void {
  const result = spawnSync("/usr/bin/open", args, { encoding: "utf8", timeout: 30_000 });
  if (result.error) throw new ComputerError("accessibility_error", `could not ${what}: ${result.error.message}`);
  if (result.status === 0) return;
  const detail = (result.stderr || result.stdout || `exit ${result.status ?? "unknown"}`).replace(/\s+/g, " ").trim();
  throw new ComputerError("accessibility_error", `could not ${what}: ${detail}`);
}
