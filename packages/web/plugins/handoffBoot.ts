import fs from "node:fs/promises";
import path from "node:path";
import { transformWithEsbuild, type Plugin, type ResolvedConfig } from "vite";
import type { OutputBundle, OutputChunk } from "rollup";

/**
 * Inlines the browser → desktop hand-off gate into index.html's <head>.
 *
 * A page that is only going to be handed to the desktop app should never pay
 * for an app boot, so the gate has to run before any module is fetched — which
 * means inline, in the document head. lib/desktopHandoff.ts is import-free
 * exactly so esbuild can turn it into a standalone IIFE here; nothing is
 * duplicated between it and the React fallback path.
 *
 * The plugin also hands the script the module URLs for the app entry's dynamic
 * import (src/boot.tsx and its static dependency graph). Splitting the entry is
 * what makes skipping the app possible, but it also moved those chunks out of
 * Vite's own <link rel="modulepreload"> hints; the script re-injects them
 * synchronously on a normal load, so nothing about that path got slower, and
 * skips them on a handoff, so nothing is fetched at all.
 */

const PLUGIN_NAME = "codecast-handoff-boot";
const GATE_SOURCE = "lib/desktopHandoff.ts";
const GLOBAL_NAME = "__ccHandoffBoot";

export function handoffBootPlugin(): Plugin {
  let config: ResolvedConfig;

  return {
    name: PLUGIN_NAME,
    configResolved(resolved) {
      config = resolved;
    },
    transformIndexHtml: {
      // `post` so the build bundle is available and the entry's own tags are
      // already in place.
      order: "post",
      async handler(_html, ctx) {
        const source = path.resolve(config.root, GATE_SOURCE);
        const preload = ctx.bundle ? bootChunkUrls(ctx.bundle, ctx.chunk, config.base) : { app: [], share: [] };
        const gate = await fs.readFile(source, "utf8");
        const { code } = await transformWithEsbuild(gate, source, {
          format: "iife",
          globalName: GLOBAL_NAME,
          minify: true,
          target: "es2020",
          // The inline script is not a module and has no source map of its own.
          sourcemap: false,
        });
        return [
          {
            tag: "script",
            children: `${code};${GLOBAL_NAME}.runPreBootHandoff(${JSON.stringify(preload.app)},${JSON.stringify(preload.share)})`,
            injectTo: "head-prepend",
          },
        ];
      },
    },
  };
}

const SHARE_BOOT_MODULE = "src/shareBoot.tsx";

/**
 * What the html entry chunk defers behind its dynamic imports, plus everything
 * those chunks statically pull in, as URLs — split into the app graph
 * (src/boot.tsx) and the standalone share-page graph (src/shareBoot.tsx) so
 * each kind of page preloads only what it will run.
 *
 * Deliberately keyed off the entry's `dynamicImports` rather than module
 * paths: Rollup is free to merge a dynamic entry into a shared chunk, which
 * leaves `facadeModuleId` null and makes a path-based lookup silently find
 * nothing. The share graph is the one exception — a merged share entry just
 * lands in the app set, which is the pre-split behaviour.
 */
function bootChunkUrls(
  bundle: OutputBundle,
  entryChunk: OutputChunk | undefined,
  base: string,
): { app: string[]; share: string[] } {
  const entry = entryChunk ?? (Object.values(bundle).find((c) => c.type === "chunk" && c.isEntry) as OutputChunk | undefined);
  if (!entry?.dynamicImports.length) {
    // Not fatal, but every normal page load would then wait a whole round trip
    // for the entry to run before it could even start fetching the app.
    console.warn(`[${PLUGIN_NAME}] no dynamic import found on the html entry chunk — the app preload hints are missing.`);
    return { app: [], share: [] };
  }

  const graph = (roots: string[]): string[] => {
    const seen = new Set<string>();
    const walk = (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      const chunk = bundle[file];
      if (chunk?.type !== "chunk") return;
      // Static imports only — matching what Vite would have preloaded. The boot
      // chunk's own dynamic imports (lazy routes, mermaid, …) stay on demand.
      for (const next of chunk.imports) walk(next);
    };
    roots.forEach(walk);
    const prefix = base.endsWith("/") ? base : `${base}/`;
    return [...seen].map((file) => `${prefix}${file}`);
  };

  const isShare = (file: string) => {
    const chunk = bundle[file];
    return chunk?.type === "chunk" && !!chunk.facadeModuleId?.endsWith(SHARE_BOOT_MODULE);
  };
  const share = entry.dynamicImports.filter(isShare);
  const app = entry.dynamicImports.filter((f) => !isShare(f));
  return { app: graph(app), share: graph(share) };
}
