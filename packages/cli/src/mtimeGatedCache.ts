import * as fs from "fs";

// Keyed on the mtimes of the files the payload derives from rather than a TTL:
// a `cast accounts save` in another process, a fresh /login, or a usage refresh
// shows up on the very next heartbeat instead of after a blind expiry window.
// The compute result — including a failed/null one — is memoized against the
// same mtimes, so a broken source file isn't re-parsed every call.
// `ttlMs` adds a time bound for a payload whose sources the mtimes cannot
// fully name (the daemon's project roots also come from started sessions).
export function createMtimeGatedCache<T>(
  paths: () => string[],
  compute: () => T,
  opts?: { ttlMs?: number },
): { get(): T; invalidate(): void } {
  let cached: { value: T; mtimes: number[]; at: number } | null = null;
  const mtimeOf = (p: string): number => {
    try {
      return fs.statSync(p).mtimeMs;
    } catch {
      return 0;
    }
  };
  return {
    get() {
      const now = Date.now();
      const mtimes = paths().map(mtimeOf);
      const fresh = opts?.ttlMs === undefined || (cached !== null && now - cached.at < opts.ttlMs);
      if (cached && fresh && cached.mtimes.every((m, i) => m === mtimes[i])) {
        return cached.value;
      }
      const value = compute();
      cached = { value, mtimes, at: now };
      return value;
    },
    invalidate() {
      cached = null;
    },
  };
}
