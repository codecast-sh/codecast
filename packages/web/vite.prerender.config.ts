import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import baseConfig from "./vite.config";

/**
 * SSR build config for scripts/prerender.mjs. Reuses the main config's resolve
 * aliases (the compat shims for next/link, next/navigation, etc.) but none of
 * its plugins: VitePWA would emit a service worker into the SSR outDir, Sentry
 * would upload a build-only bundle's sourcemaps, and manualChunks is invalid
 * for an SSR entry.
 */
export default defineConfig({
  plugins: [react()],
  resolve: baseConfig.resolve,
  css: baseConfig.css,
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
