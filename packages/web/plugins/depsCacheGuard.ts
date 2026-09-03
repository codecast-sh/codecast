import fs from "node:fs";
import path from "node:path";
import type { Plugin, ViteDevServer } from "vite";

/**
 * Restarts the dev server when its optimizer cache is deleted underneath it.
 *
 * Vite pre-bundles dependencies into `<cacheDir>/deps` once at boot and keeps
 * the resulting metadata in memory. Scripts that refresh vendored packages
 * (scripts/vendor-platform.sh, the memory recipes) delete that directory to
 * force a rebuild. A running server never notices: bundles it has already
 * served stay in its transform cache, but the first request for any other dep
 * reads a file that is gone, and Vite answers 504 "Outdated Optimize Dep".
 * Every lazy import that reaches such a dep then fails with "Failed to fetch
 * dynamically imported module", and the failure persists until someone
 * restarts the server by hand.
 *
 * This plugin polls the metadata file. When the file was present and goes
 * missing, it waits a grace period so the caller's follow-up (a `bun install`
 * that rewrites node_modules) can finish, re-checks, and restarts the server in
 * place. The restart finds no cache and rebuilds it; connected browsers reload
 * once the new server answers.
 */

const PLUGIN_NAME = "codecast-deps-cache-guard";

export interface CacheGuardOptions {
  /** Absolute path of the optimizer metadata file to watch. */
  metadataPath: string;
  /** Called once the file has been missing for the whole grace period. */
  onPurged: () => void;
  /** Poll interval in ms. */
  intervalMs?: number;
  /** How long the file must stay missing before onPurged fires, in ms. */
  graceMs?: number;
}

/** Returns a function that stops watching. */
export function watchOptimizerCache({
  metadataPath,
  onPurged,
  intervalMs = 2000,
  graceMs = 3000,
}: CacheGuardOptions): () => void {
  let present = fs.existsSync(metadataPath);
  let pending: ReturnType<typeof setTimeout> | null = null;

  const check = () => {
    const now = fs.existsSync(metadataPath);
    if (now) {
      // Back before the grace period ran out: Vite's own re-optimize swaps the
      // directory in place, and a restart would only cost the browser a reload.
      if (pending) {
        clearTimeout(pending);
        pending = null;
      }
    } else if (present && !pending) {
      pending = setTimeout(() => {
        pending = null;
        if (!fs.existsSync(metadataPath)) onPurged();
      }, graceMs);
    }
    present = now;
  };

  const timer = setInterval(check, intervalMs);
  // Keep the poll from holding the process open on its own.
  timer.unref?.();
  return () => {
    clearInterval(timer);
    if (pending) clearTimeout(pending);
  };
}

export function metadataPathFor(server: Pick<ViteDevServer, "config">): string {
  return path.join(server.config.cacheDir, "deps", "_metadata.json");
}

export function depsCacheGuardPlugin(): Plugin {
  return {
    name: PLUGIN_NAME,
    apply: "serve",
    configureServer(server) {
      const stop = watchOptimizerCache({
        metadataPath: metadataPathFor(server),
        onPurged: () => {
          server.config.logger.info(
            `[${PLUGIN_NAME}] optimizer cache was removed, restarting the server to rebuild it`,
            { timestamp: true },
          );
          server.restart().catch((err) => {
            server.config.logger.error(`[${PLUGIN_NAME}] restart failed: ${err?.message ?? err}`);
          });
        },
      });
      server.httpServer?.once("close", stop);
    },
  };
}
