import { bootAfterHandoffGate, isStandaloneSharePath } from "../lib/desktopHandoff";
import "../app/globals.css";
// The bundled faces' @font-face rules (Instrument Sans is the Modern style's
// interface face, globals.css .modern-style --font-ui) in the same head
// stylesheet, so the boot shell and the first paint have them declared
// rather than waiting for boot's chunk (components/simple/laneLook).
import "@platform/design/fonts";
import { startRouteModule } from "./earlyRoutes";
import { holdTextareaTextNodes } from "../lib/holdTextareaTextNode";
import { DOCS_SHOTS } from "../lib/docsShots/flag";

/**
 * The app entry is deliberately almost empty. Everything real lives in
 * ./boot.tsx behind a dynamic import, because a browser page that is about to
 * hand itself off to the desktop app must not load the app at all: the module
 * bodies of the store, the Convex client and React run on import, so an early
 * `return` in a heavyweight entry would still have paid for a socket, an
 * IndexedDB hydration and a render nobody sees.
 *
 * That decision was already made, inlined in index.html's <head>
 * (plugins/handoffBoot.ts) — this only honors it, including the held case: a
 * background tab that will hand off once looked at boots only if the gate
 * decides against the handoff.
 *
 * globals.css and the bundled faces stay imported here so the stylesheet
 * remains a plain <link> in the built HTML, fetched in parallel on every load.
 */
// Before any box mounts, on the app and on share pages alike.
holdTextareaTextNodes();

bootAfterHandoffGate(() => {
  // Share pages boot standalone: they hydrate server-rendered markup and never
  // need the store, the inbox, or auth. Everything else is the app.
  if (isStandaloneSharePath(window.location.pathname)) return void import("./shareBoot");
  // The route's own modules load beside boot's, not after the shell reaches it.
  startRouteModule(window.location.pathname);
  // Docs shots (dev only) sign in to the fixture world before the app loads.
  if (DOCS_SHOTS) void import("../lib/docsShots/install").then(() => import("./boot"));
  else void import("./boot");
});
