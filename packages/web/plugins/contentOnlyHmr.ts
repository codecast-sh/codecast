import { isCSSRequest, type Plugin } from "vite";

/**
 * Keeps an edit to a file no window has loaded from reloading every window.
 *
 * Tailwind reports each file it scans as a dependency of the stylesheet, and
 * Vite records one as a module node whose only importer is that stylesheet.
 * Once a window imports the file, the node gains its script importers and its
 * own Fast Refresh boundary, and an edit hot-swaps. Until then the stylesheet
 * is the only importer, and Vite's rule for a non-CSS file imported only by CSS
 * is a full page reload, broadcast to every connected window. With lazy routes
 * that is most of the tree: saving a component of a page nobody has open
 * reloaded all four desktop windows, a dozen times in twenty minutes while
 * other sessions worked on /line (2026-10-08).
 *
 * The only thing such an edit can change for a connected window is the set of
 * classes Tailwind generates, so the stylesheets that scan the file are the
 * modules to update.
 */

const PLUGIN_NAME = "codecast-content-only-hmr";

/** The part of a module node this decision reads. */
export type GraphNode = {
  url: string;
  isSelfAccepting?: boolean;
  importers: Set<GraphNode>;
  importedModules: Set<unknown>;
};

/**
 * A node no window has loaded: Vite never analyzed it (it accepts nothing and
 * records no imports of its own) and only stylesheets point at it. The entry
 * script is scanned too and has no script importer either, which is why the
 * imports matter: an edit to it must still reload.
 */
function scannedOnly(mod: GraphNode): boolean {
  if (mod.isSelfAccepting || mod.importedModules.size > 0 || isCSSRequest(mod.url)) return false;
  return mod.importers.size > 0 && [...mod.importers].every((i) => isCSSRequest(i.url));
}

/**
 * The modules to update for one changed file, or null to leave Vite's list as
 * it is. Pure, so it is testable without a server.
 */
export function swapScannedOnly<T extends GraphNode>(modules: T[]): T[] | null {
  if (!modules.some(scannedOnly)) return null;
  const out = new Set<T>();
  for (const mod of modules) {
    if (!scannedOnly(mod)) out.add(mod);
    else for (const sheet of mod.importers) out.add(sheet as T);
  }
  return [...out];
}

export function contentOnlyHmrPlugin(): Plugin {
  return {
    name: PLUGIN_NAME,
    apply: "serve",
    hotUpdate({ file, modules }) {
      // An html change reloads by design, and only the browser has windows.
      if (this.environment.name !== "client" || file.endsWith(".html")) return;
      return swapScannedOnly(modules) ?? undefined;
    },
  };
}
