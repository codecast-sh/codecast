/**
 * Pool maintainer: keeps the warm pool refreshed automatically.
 *
 * Strategy:
 *   - Run maintainPool() on a slow timer (default every 30s). This is the
 *     safety net — even without filesystem events, the pool will catch up.
 *   - Watch the repo's lockfile and HEAD. On any change, call maintainPool()
 *     immediately so users don't sit on stale slots longer than necessary.
 *
 * Designed to be embedded into the daemon (single source of truth for a
 * repo) but also runs standalone for ad-hoc use (e.g., in a script).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { maintainPool } from "./manager.js";

const DEFAULT_PERIOD_MS = 30_000;

export interface PoolMaintainerOptions {
  repoRoot: string;
  size: number;
  /** Periodic tick interval. Default 30s. */
  periodMs?: number;
  /** Watch for lockfile / HEAD changes. Default true. */
  watch?: boolean;
  /** Logger. Default no-op. */
  log?: (msg: string) => void;
}

export interface PoolMaintainerHandle {
  /** Stop watchers and timers. Idempotent. */
  stop: () => Promise<void>;
  /** Trigger an immediate maintainPool, returning when complete. */
  tickNow: () => Promise<void>;
}

/** Start a background maintainer. Returns a handle to stop it. */
export function startPoolMaintainer(
  opts: PoolMaintainerOptions,
): PoolMaintainerHandle {
  const repoRoot = opts.repoRoot;
  const size = opts.size;
  const log = opts.log ?? (() => {});
  const periodMs = opts.periodMs ?? DEFAULT_PERIOD_MS;

  let stopped = false;
  let running = false;
  let pendingTick = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  const watchers: fs.FSWatcher[] = [];

  const tick = async () => {
    if (stopped) return;
    if (running) {
      pendingTick = true;
      return;
    }
    running = true;
    try {
      await maintainPool(repoRoot, size);
    } catch (err) {
      log(`pool maintainer error: ${(err as Error).message}`);
    } finally {
      running = false;
      if (pendingTick && !stopped) {
        pendingTick = false;
        // Re-trigger immediately to coalesce events.
        void tick();
      }
    }
  };

  // Schedule first tick on next tick of event loop, then on a timer.
  void Promise.resolve().then(tick);
  timer = setInterval(tick, periodMs);

  // Watch lockfile + HEAD if requested.
  if (opts.watch !== false) {
    const targets = lockfileWatchTargets(repoRoot);
    for (const t of targets) {
      try {
        const w = fs.watch(t, { persistent: false }, () => {
          log(`pool maintainer: change detected at ${t}`);
          void tick();
        });
        watchers.push(w);
      } catch {
        // Path may not exist (e.g., no lockfile yet). Skip silently.
      }
    }
  }

  return {
    async stop() {
      if (stopped) return;
      stopped = true;
      if (timer) clearInterval(timer);
      for (const w of watchers) {
        try { w.close(); } catch {}
      }
    },
    async tickNow() {
      await tick();
    },
  };
}

/** Files whose changes should trigger pool refresh. */
function lockfileWatchTargets(repoRoot: string): string[] {
  const candidates = [
    "bun.lock",
    "bun.lockb",
    "pnpm-lock.yaml",
    "yarn.lock",
    "package-lock.json",
    "uv.lock",
    "poetry.lock",
    "Pipfile.lock",
    "Cargo.lock",
    "go.sum",
    ".git/HEAD",
  ];
  return candidates
    .map((c) => path.join(repoRoot, c))
    .filter((p) => fs.existsSync(p));
}
