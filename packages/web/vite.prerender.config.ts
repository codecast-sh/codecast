import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { sharedResolve, sharedCss } from "./vite.shared";

/**
 * SSR build config: the build-time marketing prerender (scripts/prerender.mjs)
 * and the request-time share-page renderer the web server imports.
 *
 * Aliases come from vite.shared.ts, which both this config and the app config
 * import. Never read them off the app config's default export — that export is
 * a function, so the property is undefined and every aliased import fails to
 * resolve (see vite.shared.ts for the outage this caused).
 *
 * None of the app config's plugins belong here: VitePWA would emit a service worker into the SSR outDir, Sentry
 * would upload a build-only bundle's sourcemaps, and manualChunks is invalid
 * for an SSR entry.
 */
export default defineConfig({
  plugins: [react()],
  resolve: sharedResolve,
  css: sharedCss,
  logLevel: "warn",
  build: {
    // Two SSR entries: the build-time marketing prerender, and the
    // request-time share-page renderer the web server imports.
    ssr: true,
    outDir: "dist-ssr",
    emptyOutDir: true,
    sourcemap: false,
    target: "node18",
    rollupOptions: {
      input: {
        "prerender-entry": "src/prerender-entry.tsx",
        "share-ssr": "src/share-ssr-entry.tsx",
      },
      output: { entryFileNames: "[name].mjs", format: "es" },
    },
  },
});
