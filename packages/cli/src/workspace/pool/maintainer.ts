/**
 * Pool maintainer: keeps the warm pool refreshed automatically.
 *
 * Strategy:
 *   - Run maintainPool() on a slow timer (default every 30s). This is the
 *     safety net — even without filesystem events, the pool will catch up.
 *   - Watch the repo's lockfile, HEAD and the create-demand file. On any
 *     change, call maintainPool() immediately, so a stale slot is replaced
 *     without waiting out the timer AND a create in another process (a
 *     `cast ws acquire`, a `cast spawn --isolated` served by this daemon)
 *     re-arms the slot it just consumed.
 *
 * The target size is not fixed: unless the caller pins one, every tick asks
 * demand.ts how many slots recent creates justify, so a repo nobody is
 * spawning in holds no worktrees at all.
 *
 * Designed to be embedded into the daemon (single source of truth for a
 * repo) but also runs standalone for ad-hoc use (e.g., in a script).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { lockfileNames, maintainPool } from "./manager.js";
import { POOL_MAX_SLOTS, demandFile, desiredPoolSizeForRepo } from "./demand.js";

const DEFAULT_PERIOD_MS = 30_000;

export interface PoolMaintainerOptions {
  repoRoot: string;
  /** Pin the target size. Omit to let recent create demand size the pool. */
  size?: number;
  /** Ceiling when demand sizes the pool. Default POOL_MAX_SLOTS (3). */
  maxSlots?: number;
  /** Periodic tick interval. Default 30s. */
  periodMs?: number;
  /** Watch for lockfile / HEAD / demand changes. Default true. */
  watch?: boolean;
  /** Logger. Default no-op. */
  log?: (msg: string) => void;
  /**
   * The maintenance pass to run each tick. Defaults to maintainPool. The
   * scheduler's own behaviour (period, coalescing, stop) is tested through
   * this rather than through a module mock, which in bun replaces the manager
   * for every test file in the process and breaks the ones driving a real pool.
   */
  maintain?: (repoRoot: string, size: number) => Promise<unknown>;
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
  const log = opts.log ?? (() => {});
  const periodMs = opts.periodMs ?? DEFAULT_PERIOD_MS;
  const maxSlots = opts.maxSlots ?? POOL_MAX_SLOTS;
  const maintain = opts.maintain ?? maintainPool;

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
      const size = opts.size ?? desiredPoolSizeForRepo(repoRoot, Date.now(), maxSlots);
      await maintain(repoRoot, size);
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

  // Watch lockfile + HEAD + demand if requested.
  if (opts.watch !== false) {
    for (const target of watchTargets(repoRoot)) {
      try {
        const w = fs.watch(target.path, { persistent: false }, (_event, filename) => {
          if (target.only && !String(filename ?? "").includes(target.only)) return;
          log(`pool maintainer: change detected at ${target.only ?? target.path}`);
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

interface WatchTarget {
  path: string;
  /**
   * For a directory watch, the filename whose events count — matched as a
   * SUBSTRING because an atomic write lands as `.demand.json.<pid>.<uuid>.tmp`
   * and macOS reports only that temp name, never the rename onto the final one.
   */
  only?: string;
}

/**
 * Files whose changes should trigger pool refresh. The demand file is watched
 * through its DIRECTORY, because it does not exist until the repo's first
 * create and fs.watch cannot arm on a missing path — and filtered by name,
 * because the pool state file the maintainer itself rewrites every tick lives
 * in that same directory and would otherwise wake the maintainer forever.
 */
function watchTargets(repoRoot: string): WatchTarget[] {
  const targets: WatchTarget[] = [...lockfileNames(), ".git/HEAD"]
    .map((c) => path.join(repoRoot, c))
    .filter((p) => fs.existsSync(p))
    .map((p) => ({ path: p }));
  const demand = demandFile(repoRoot);
  fs.mkdirSync(path.dirname(demand), { recursive: true });
  targets.push({ path: path.dirname(demand), only: path.basename(demand) });
  return targets;
}
