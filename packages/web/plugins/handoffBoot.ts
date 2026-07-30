import fs from "node:fs/promises";
import path from "node:path";
import { transformWithEsbuild, type Plugin, type ResolvedConfig } from "vite";
import type { OutputBundle } from "rollup";

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

const GATE_SOURCE = "lib/desktopHandoff.ts";
const APP_BOOT_ENTRY = "src/boot.tsx";
const GLOBAL_NAME = "__ccHandoffBoot";

export function handoffBootPlugin(): Plugin {
  let config: ResolvedConfig;

  return {
    name: "codecast-handoff-boot",
    configResolved(resolved) {
      config = resolved;
    },
    transformIndexHtml: {
      // `post` so the build bundle is available and the entry's own tags are
      // already in place.
      order: "post",
      async handler(_html, ctx) {
        const source = path.resolve(config.root, GATE_SOURCE);
        const preload = ctx.bundle ? bootChunkUrls(ctx.bundle, config.base) : [];
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
            children: `${code};${GLOBAL_NAME}.runPreBootHandoff(${JSON.stringify(preload)})`,
            injectTo: "head-prepend",
          },
        ];
      },
    },
  };
}

/** The app-boot chunk plus every chunk it statically imports, as URLs. */
function bootChunkUrls(bundle: OutputBundle, base: string): string[] {
  const entry = Object.keys(bundle).find((file) => {
    const chunk = bundle[file];
    return chunk.type === "chunk" && !!chunk.facadeModuleId?.endsWith(APP_BOOT_ENTRY);
  });
  if (!entry) return [];

  const seen = new Set<string>();
  const walk = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const chunk = bundle[file];
    if (chunk?.type !== "chunk") return;
    // Static imports only — matching what Vite would have preloaded. Dynamic
    // imports (lazy routes, mermaid, …) stay load-on-demand.
    for (const next of chunk.imports) walk(next);
  };
  walk(entry);

  const prefix = base.endsWith("/") ? base : `${base}/`;
  return [...seen].map((file) => `${prefix}${file}`);
}
