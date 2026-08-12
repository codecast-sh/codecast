import path from "node:path";
import type { Plugin } from "vite";

/**
 * Makes the store module self-accepting in dev, so editing it hot-swaps instead
 * of reloading the page.
 *
 * store/inboxStore.ts exports a hook and actions, never components, so React
 * Fast Refresh cannot make it an update boundary. Vite then walks its importers
 * looking for one and finds none: lib/sounds imports the store straight back (a
 * cycle), and lib/errorToast reaches src/boot.tsx, which is the entry and has no
 * importers at all. Both dead ends make Vite fall back to a full page reload,
 * which costs a fresh Convex WebSocket handshake (~4s before data is back) every
 * time anyone touches the store layer.
 *
 * One `import.meta.hot.accept()` inside the module stops that walk at the module
 * itself. It cannot be written in the source, because Metro bundles that same
 * file for the Expo app and Hermes cannot parse `import.meta` — hence appending
 * it here, where only the web dev server ever sees it. The module handles the
 * rest: it reuses the surviving store instance across re-execution and swaps in
 * the new action bodies (see the hot swap notes there and _hotReplaceConfig in
 * store/mutativeMiddleware.ts).
 *
 * Append-only, so every original line keeps its position and source maps stay
 * accurate without generating one.
 */

const PLUGIN_NAME = "codecast-store-hmr";
const SELF_ACCEPTING = ["store/inboxStore.ts"];

export function storeHmrPlugin(): Plugin {
  const targets = new Set(SELF_ACCEPTING.map((file) => path.normalize(file)));

  return {
    name: PLUGIN_NAME,
    // Dev only. A build has no `import.meta.hot` and would tree-shake this away
    // anyway, but there is no reason to emit it.
    apply: "serve",
    transform(code, id) {
      const file = path.normalize(id.split("?")[0]);
      if (![...targets].some((target) => file.endsWith(path.sep + target))) return null;
      return { code: `${code}\nif (import.meta.hot) import.meta.hot.accept();\n`, map: null };
    },
  };
}
