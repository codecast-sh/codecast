import { handoffTookOverBoot, isStandaloneSharePath } from "../lib/desktopHandoff";
import "../app/globals.css";

/**
 * The app entry is deliberately almost empty. Everything real lives in
 * ./boot.tsx behind a dynamic import, because a browser page that is about to
 * hand itself off to the desktop app must not load the app at all: the module
 * bodies of the store, the Convex client and React run on import, so an early
 * `return` in a heavyweight entry would still have paid for a socket, an
 * IndexedDB hydration and a render nobody sees.
 *
 * That decision was already made, inlined in index.html's <head>
 * (plugins/handoffBoot.ts) — this only honors it.
 *
 * globals.css stays imported here so the stylesheet remains a plain <link> in
 * the built HTML, fetched in parallel on every load.
 */
if (!handoffTookOverBoot()) {
  // Share pages boot standalone: they hydrate server-rendered markup and never
  // need the store, the inbox, or auth. Everything else is the app.
  void (isStandaloneSharePath(window.location.pathname) ? import("./shareBoot") : import("./boot"));
}
