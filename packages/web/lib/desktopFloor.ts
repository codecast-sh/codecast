// The desktop version floor, as the WEB sees it.
//
// Every desktop window loads this bundle from codecast.sh, so the web layer is
// the one channel that reaches a shell whose own update path is broken. Two
// facts are readable with no bridge at all: Electron stamps `Codecast/<version>`
// into the user agent and no preload can take it away, and the floor is a
// public query. Pure, so the decision is testable without a window.

// Numeric semver compare (mirrors the daemon's compareVersions).
export function cmpVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] || 0;
    const nb = pb[i] || 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
  }
  return 0;
}

// The running desktop app's version from a user agent, or null when the agent
// is not a Codecast shell.
export function parseShellVersion(userAgent: string | null | undefined): string | null {
  if (!userAgent || !/ Electron\//.test(userAgent)) return null;
  return userAgent.match(/ Codecast\/(\d+(?:\.\d+)+)/)?.[1] ?? null;
}

export function isBelowFloor(shellVersion: string | null, floor: string | null | undefined): boolean {
  if (!shellVersion || !floor) return false;
  return cmpVersions(floor, shellVersion) > 0;
}

// A below-floor window asks the daemon to update on its own, and the daemon
// quits and relaunches the app to apply. One ask per window per interval: if
// the swap fails, the relaunched window must not ask again at once and turn a
// failed update into an app that restarts every boot.
export const FLOOR_REQUEST_INTERVAL_MS = 30 * 60_000;

export function floorRequestDue(now: number, lastRequestedAt: number | null): boolean {
  return lastRequestedAt == null || now - lastRequestedAt >= FLOOR_REQUEST_INTERVAL_MS;
}
