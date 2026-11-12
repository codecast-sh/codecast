import type { VitePWAOptions } from "vite-plugin-pwa";

type RuntimeCaching = NonNullable<NonNullable<VitePWAOptions["workbox"]>["runtimeCaching"]>[number];

// What the service worker may precache. Under assets/, plugins/precacheScope.ts
// narrows it further to what the app reaches (no grammar, icon or marketing
// chunks); outside it, these patterns decide. Blog and docs media, the social
// banners (brand/) and the homepage hero's stills (hero/) are the public site's.
export const APP_SHELL_GLOB_PATTERNS = ["**/*.{js,css,html,ico,png,svg,woff2}"];
export const APP_SHELL_GLOB_IGNORES = ["docs/**", "blog/**", "brand/**", "hero/**"];

// Real server endpoints (server/index.ts) that must never get the SPA shell.
// /a/ is the server-rendered artifact page, /share/ is server-rendered too
// (server/share.ts), /i/ is an install script.
export const SHELL_DENYLIST = /^\/(?:api\/|download\/|install|a\/|share\/|i\/)/;

// Navigations go to the network first; the precached shell is only the offline
// (or hung network) answer. A worker that answered every navigation from its
// precache (workbox navigateFallback) pinned a returning visitor to the build it
// installed with: after a deploy that visitor got the old index.html, whose lazy
// chunks were gone from the server, so codecast.sh showed "Couldn't load App",
// and every reload went through the same worker until the new one finished
// installing (2026-11-12, ct-92522). The response is never stored: an offline
// boot must use the shell that matches this worker's precached chunks.
// urlPattern is serialized into sw.js, so it repeats SHELL_DENYLIST inline.
export const NAVIGATION_ROUTE: RuntimeCaching = {
  urlPattern: ({ request, url }) =>
    request.mode === "navigate" && !/^\/(?:api\/|download\/|install|a\/|share\/|i\/)/.test(url.pathname),
  handler: "NetworkFirst",
  options: {
    cacheName: "navigations",
    networkTimeoutSeconds: 4,
    cacheableResponse: { statuses: [] },
    precacheFallback: { fallbackURL: "/index.html" },
  },
};
