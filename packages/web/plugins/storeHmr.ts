import crypto from "node:crypto";
import path from "node:path";
import type { Plugin } from "vite";

/**
 * Lets an edit to a store action hot-swap instead of reloading the whole app.
 *
 * store/inboxStore.ts exports a hook and actions, never components, so React
 * Fast Refresh cannot make it an update boundary. Vite then walks its importers
 * looking for one and finds none: lib/sounds imports the store straight back (a
 * cycle), and lib/errorToast reaches src/boot.tsx, which is the entry and has no
 * importers. Both dead ends make Vite fall back to a full page reload, and that
 * costs a fresh Convex WebSocket handshake — about four seconds before any data
 * is back — every time anyone touches the store.
 *
 * One `import.meta.hot.accept()` stops that walk at the module itself. It cannot
 * be written in the source, because Metro bundles that same file for the Expo
 * app and Hermes cannot parse `import.meta` — hence appending it here, where
 * only the web dev server sees it. The module handles the rest: it reuses the
 * surviving store instance across re-execution, so every importer's
 * `useInboxStore` reference stays valid and the data stays in memory, and
 * _hotReplaceConfig (store/mutativeMiddleware.ts) swaps in the new action bodies.
 *
 * The catch, and why this plugin is more than one appended line: a self-accepting
 * module does NOT update its importers, so they keep their old copy of every
 * OTHER export — and this module exports 70-odd helpers (classifySession,
 * sortSessions, the selectors) that components import directly. Hot-swapping an
 * edit to one of those would appear to succeed and change nothing, which is
 * worse than reloading. So the module is split at the action config: everything
 * outside it is the surface importers hold, and when that surface changes the
 * module invalidates itself and takes the reload it actually needs.
 *
 * Append-only, so every original line keeps its position and source maps stay
 * accurate without generating one.
 */

const PLUGIN_NAME = "codecast-store-hmr";
export const STORE_FILE = "store/inboxStore.ts";

// The action config, verbatim from the module. Everything between these two is
// rebuilt on a hot swap; everything outside is held by importers.
const CONFIG_OPEN = "const inboxStoreConfig = (set: any, get: any) => ({";
const CONFIG_CLOSE = "function createInboxStore() {";

export function storeHmrPlugin(): Plugin {
  return {
    name: PLUGIN_NAME,
    // Dev only. A build has no `import.meta.hot` and would drop this anyway.
    apply: "serve",
    // Before vite:esbuild, so the markers below match the TypeScript source
    // rather than whatever the type stripping leaves behind.
    enforce: "pre",
    transform(code, id) {
      const file = path.normalize(id.split("?")[0]);
      if (!file.endsWith(path.sep + path.normalize(STORE_FILE))) return null;

      const surface = surfaceHash(code);
      if (!surface) {
        // The markers moved. Say so and leave the module alone: a full reload on
        // every store edit is slow, but a hot swap that silently drops half the
        // module's changes is wrong.
        this.warn(
          `store hot swap is off: ${STORE_FILE} no longer contains the config markers ` +
            `(${JSON.stringify(CONFIG_OPEN)} … ${JSON.stringify(CONFIG_CLOSE)}). ` +
            `Update ${PLUGIN_NAME} to match.`,
        );
        return null;
      }

      const glue = `
if (import.meta.hot) {
  if (import.meta.hot.data.surface !== undefined && import.meta.hot.data.surface !== ${JSON.stringify(surface)}) {
    // Something outside the action config changed — an exported helper, a
    // selector, a type-level constant. Importers hold the previous copy and a
    // self-accepting swap would never hand them the new one, so take the reload.
    console.info("[store] exports outside the actions changed — reloading so importers pick them up");
    import.meta.hot.invalidate();
  } else {
    import.meta.hot.data.surface = ${JSON.stringify(surface)};
    import.meta.hot.accept();
  }
}
`;
      return { code: `${code}\n${glue}`, map: null };
    },
  };
}

/**
 * Fingerprint of everything OUTSIDE the action config — the exports importers
 * keep a reference to. Null when the markers are missing.
 */
function surfaceHash(code: string): string | null {
  const open = code.indexOf(CONFIG_OPEN);
  const close = code.indexOf(CONFIG_CLOSE);
  if (open === -1 || close === -1 || close < open) return null;
  const outside = code.slice(0, open) + code.slice(close);
  return crypto.createHash("sha1").update(outside).digest("hex").slice(0, 12);
}
