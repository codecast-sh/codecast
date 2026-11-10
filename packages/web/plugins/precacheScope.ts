import type { Plugin } from "vite";
import type { OutputBundle, OutputChunk } from "rollup";

/**
 * Which built files the service worker precaches: what an app session can
 * reach, not every file the build emits.
 *
 * The precache is what makes an offline desktop launch work, so it keeps the
 * whole app: the html entry, boot, every route and every lazy piece they load
 * (followed through static and dynamic imports alike), with their CSS and the
 * fonts and images that CSS names. What it leaves to the runtime cache are the
 * lazy entries that each serve one choice among hundreds and that most
 * sessions never load: one chunk per syntax-highlighting grammar and theme,
 * the icon set mods name their icons from, and the public site's pages. With
 * the per-icon split these were 1,800 of the 2,600 precached files,
 * re-downloaded by every open window after every deploy. Once fetched they
 * are cached at runtime like any asset
 * (vite.config.ts runtimeCaching), so a grammar or an icon used once works
 * offline after that.
 *
 * Only dynamic edges into those entries are cut. A static import is always
 * followed, so an icon or grammar that a kept chunk imports statically stays
 * in the precache.
 */

/** Lazy entries the precache leaves to the runtime cache, by the module that opens the chunk. */
export const RUNTIME_ONLY_ENTRIES: RegExp[] = [
  // One chunk per grammar and per theme (@pierre/diffs → shiki).
  /\/node_modules\/@shikijs\/(?:langs|themes)\//,
  // The icon set a mod's named icon loads (components/mods/ModIcon), and the
  // one-chunk-per-icon split lucide-react/dynamic would make.
  /\/node_modules\/lucide-react\/dist\/esm\/(?:lucide-react\.js$|icons\/)/,
  // The public site: landing, blog, docs, pricing, comparisons.
  /\/app\/\(marketing\)\//,
  /\/src\/layouts\/MarketingLayout\.tsx$/,
];

/** Every emitted file an app session can reach (see the module comment). */
export function appShellFiles(bundle: OutputBundle): Set<string> {
  const runtimeOnly = (chunk: OutputChunk) => {
    const opener = chunk.facadeModuleId;
    if (opener) return RUNTIME_ONLY_ENTRIES.some((re) => re.test(opener));
    // A dynamic entry Rollup merged into a chunk without a facade: cut it only
    // when everything in the chunk is runtime-only.
    const ids = Object.keys(chunk.modules);
    return ids.length > 0 && ids.every((id) => RUNTIME_ONLY_ENTRIES.some((re) => re.test(id)));
  };

  const keep = new Set<string>();
  const queue = Object.values(bundle).filter((c): c is OutputChunk => c.type === "chunk" && c.isEntry);
  const visit = (file: string, dynamic: boolean) => {
    const next = bundle[file];
    if (next?.type !== "chunk" || keep.has(file)) return;
    if (dynamic && runtimeOnly(next)) return;
    queue.push(next);
  };
  while (queue.length) {
    const chunk = queue.shift()!;
    if (keep.has(chunk.fileName)) continue;
    keep.add(chunk.fileName);
    for (const css of chunk.viteMetadata?.importedCss ?? []) keep.add(css);
    for (const asset of chunk.viteMetadata?.importedAssets ?? []) keep.add(asset);
    for (const file of chunk.imports) visit(file, false);
    for (const file of chunk.dynamicImports) visit(file, true);
  }
  return keep;
}

type ManifestEntry = { url: string; revision: string | null; size: number };

/**
 * The plugin records the bundle's app-shell files; `manifestTransform` (for
 * workbox's `manifestTransforms`) narrows the precache to them. Files outside
 * the bundle's asset directory (index.html, icons, mod-host) are left to the
 * glob patterns (vite.pwa.ts).
 */
export function precacheScope(): {
  plugin: Plugin;
  manifestTransform: (entries: ManifestEntry[]) => Promise<{ manifest: ManifestEntry[]; warnings: string[] }>;
} {
  let keep: Set<string> | null = null;
  let assetsDir = "assets";
  return {
    plugin: {
      name: "codecast-precache-scope",
      apply: "build",
      configResolved(config) {
        assetsDir = config.build.assetsDir.replace(/^\.?\/+|\/+$/g, "");
      },
      generateBundle(_options, bundle) {
        keep = appShellFiles(bundle);
      },
    },
    async manifestTransform(entries) {
      // No bundle seen (an SSR or library build): precache as configured.
      if (!keep) return { manifest: entries, warnings: [] };
      const shell = keep;
      const manifest = entries.filter((entry) => {
        const url = entry.url.replace(/^\/+/, "");
        return !url.startsWith(`${assetsDir}/`) || shell.has(url);
      });
      return { manifest, warnings: [] };
    },
  };
}
