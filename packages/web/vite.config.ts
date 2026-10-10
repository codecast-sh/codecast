import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { sentryVitePlugin } from "@sentry/vite-plugin";
import { VitePWA } from "vite-plugin-pwa";
import path from "path";
import { sharedResolve, sharedCss } from "./vite.shared";
import { execSync } from "node:child_process";
// By path into the vendored mirror rather than by package name: Vite leaves a
// node_modules import of the config to Node, which will not strip types there.
import { updatePromptVite } from "../../platform/packages/update-prompt/src/build";
import { storeHmrPlugin } from "./plugins/storeHmr";
import { hookRefreshPlugin } from "./plugins/hookRefresh";
import { contentOnlyHmrPlugin } from "./plugins/contentOnlyHmr";
import { handoffBootPlugin } from "./plugins/handoffBoot";
import { laneBootPlugin } from "./plugins/laneBoot";
import { depsCacheGuardPlugin } from "./plugins/depsCacheGuard";
import { castPlayerScriptPlugin } from "./plugins/castPlayerScript";
import { tailwindInWorker } from "./plugins/tailwindWorker";
import { stallWatchdogPlugin } from "./plugins/stallWatchdog";
import autoprefixer from "autoprefixer";
import { APP_SHELL_GLOB_IGNORES, APP_SHELL_GLOB_PATTERNS } from "./vite.pwa";

/**
 * Build identity for drivers (window.__CODECAST_BUILD) and for the running app
 * (/version.json, read by lib/updatePrompt). Railway exposes the commit it
 * built; a local checkout answers git; a tarball with neither says so instead
 * of guessing. @platform/update-prompt adds the release's reload prompt
 * (release-prompt.json, bumped by scripts/release-prompt.ts), bakes the whole
 * identity into __CODECAST_BUILD__ and serves the same object at /version.json.
 */
function buildIdentity(mode: string) {
  let sha = process.env.RAILWAY_GIT_COMMIT_SHA || process.env.GIT_SHA || "";
  if (!sha) {
    try {
      sha = execSync("git rev-parse HEAD", { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      sha = "unknown";
    }
  }
  return { sha, builtAt: new Date().toISOString(), mode };
}

export default defineConfig(({ mode, command }) => ({
  plugins: [
    // Replaces the dev server with a fresh one if its main thread stops running.
    stallWatchdogPlugin(),
    updatePromptVite({ releaseFile: path.resolve(__dirname, "release-prompt.json"), define: "__CODECAST_BUILD__", identity: buildIdentity }),
    // Before react(): gives hooks in plain .ts files a Fast Refresh signature,
    // so editing their hook list remounts consumers instead of crashing them.
    hookRefreshPlugin(),
    react(),
    // Lets an edit to a store action hot-swap instead of reloading the whole app.
    storeHmrPlugin(),
    // An edit to a file no window has loaded updates the stylesheet that scans
    // it instead of reloading every window.
    contentOnlyHmrPlugin(),
    // Restarts the server when node_modules/.vite is deleted underneath it
    // (vendor-platform.sh, manual cache purges); without this every dep not
    // yet served answers 504 until someone restarts by hand.
    depsCacheGuardPlugin(),
    // /cast-player.js: the published-page video player, same-origin for the landing page film.
    castPlayerScriptPlugin(),
    // Inlines the browser → desktop hand-off gate into <head> so a page bound
    // for the desktop app never boots, and re-injects the boot chunk's
    // modulepreload hints on a normal load.
    handoffBootPlugin(),
    // Puts the family token sheet and the lane flag into <head>, so a cold
    // load of a simple lane page opens on the lane's paper, not the app's splash.
    laneBootPlugin(),
    // codecast.sh/a/<slug> is a redirect to the branded artifact document the
    // Convex HTTP action serves (production: Hono route in server/index.ts).
    // Same behavior in dev so the path never falls through to the SPA shell.
    {
      name: "artifact-redirect",
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          const m = req.url?.match(/^\/a\/([A-Za-z0-9]{6,32})(?:[/?#]|$)/);
          if (!m) return next();
          const edge = process.env.ARTIFACT_EDGE_URL || "https://a.codecast.sh";
          const qs = req.url?.split("?")[1];
          res.writeHead(302, { Location: `${edge}/${m[1]}${qs ? `?${qs}` : ""}` });
          res.end();
        });
      },
    },
    // Offline app shell: precache the built app so the SPA boots with zero
    // network — the desktop (Electron) shell loads codecast.sh remotely, so
    // without this an offline launch never even gets HTML. Data comes from
    // the IndexedDB-hydrated store; this only makes the shell itself local.
    VitePWA({
      registerType: "autoUpdate",
      injectRegister: null, // registered manually from src/boot.tsx after first paint
      manifest: false, // offline shell only; not an installable PWA
      workbox: {
        globPatterns: APP_SHELL_GLOB_PATTERNS,
        globIgnores: APP_SHELL_GLOB_IGNORES,
        // Several chunks (ConversationView, tiptap, highlight) exceed
        // workbox's 2 MiB default, which would silently drop them from the
        // precache and break offline boot.
        maximumFileSizeToCacheInBytes: 15 * 1024 * 1024,
        navigateFallback: "/index.html",
        // Real server endpoints (server/index.ts) — never serve the SPA shell
        // for these. /a/ is the server-rendered artifact page: without the
        // denylist entry, a visitor with the SW installed would get the cached
        // SPA shell instead of the static page.
        navigateFallbackDenylist: [/^\/api\//, /^\/download\//, /^\/install/, /^\/a\//],
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/fonts\.googleapis\.com\//,
            handler: "StaleWhileRevalidate",
            options: { cacheName: "google-fonts-css" },
          },
          {
            urlPattern: /^https:\/\/fonts\.gstatic\.com\//,
            handler: "CacheFirst",
            options: {
              cacheName: "google-fonts-files",
              expiration: { maxEntries: 30, maxAgeSeconds: 365 * 24 * 60 * 60 },
            },
          },
        ],
        cleanupOutdatedCaches: true,
        clientsClaim: true,
        skipWaiting: true,
      },
    }),
    sentryVitePlugin({
      org: process.env.SENTRY_ORG || "codecast-a2",
      project: process.env.SENTRY_PROJECT || "javascript-react",
      authToken: process.env.SENTRY_AUTH_TOKEN,
      disable: !process.env.SENTRY_AUTH_TOKEN,
    }),
  ],
  resolve: sharedResolve,
  // Dev only: the same plugins as postcss.config.mjs, with Tailwind built in a
  // worker so a slow rebuild never blocks the server's thread. Production
  // builds read postcss.config.mjs as is.
  css:
    command === "serve"
      ? { postcss: { plugins: [tailwindInWorker(path.resolve(__dirname, "tailwind.config.ts")), autoprefixer()] } }
      : sharedCss,
  server: {
    port: 3000,
    host: true,
    allowedHosts: ["local.codecast.sh", "local.1.codecast.sh", "local.2.codecast.sh", "local.3.codecast.sh"],
    // Tests run under bun, never through vite — but a single stray HTTP fetch
    // of a test file (an agent probing the dev server) makes it a permanent
    // orphan module in the graph, and every later save of it broadcasts a
    // full-reload to EVERY connected window (the "popup keeps blinking on
    // local" storm: 40+ of one afternoon's reloads were *.test.ts saves from
    // concurrent agent sessions). Ignore them in the watcher; same for
    // underscore-prefixed scratch .html pages parked in the served root —
    // any html change full-reloads all clients by design.
    watch: {
      ignored: ["**/*.test.ts", "**/*.test.tsx", "**/__tests__/**", "**/_*.html"],
    },
    // NOTE: server.warmup is deliberately omitted. Warming up a 10k-LOC
    // module (ConversationView.tsx) on boot kicks the optimizer into a
    // dep-discovery cycle that races real page requests, producing
    // ERR_CONTENT_LENGTH_MISMATCH on the in-flight transform response and
    // leaving the boot shell stuck at "...". Vite's natural request-driven
    // pipeline plus holdUntilCrawlEnd below is more reliable than warmup
    // for a graph this large.
  },
  // Pre-bundle every heavy CJS/ESM-interop dep that the SPA's entry graph
  // reaches transitively. The goal isn't speed; it's stability: the optimizer
  // does discovery once at boot, never re-bundles mid-session, and module URLs
  // stay stable so the dev server can't serve a Content-Length that drifts
  // from the body bytes.
  optimizeDeps: {
    holdUntilCrawlEnd: true,
    // Plain ESM with a top-level await the optimizer's target refuses; the
    // browser loads it as it ships, and an excluded dep never triggers a
    // mid-session re-optimize.
    exclude: ["@novnc/novnc"],
    include: [
      "react",
      "react-dom",
      "react-dom/client",
      "react-router",
      "convex/react",
      "@convex-dev/auth/react",
      "react-markdown",
      "rehype-highlight",
      "remark-gfm",
      "@tanstack/react-virtual",
      "lucide-react",
      "sonner",
      "cmdk",
      "nanoid",
      "react-resizable-panels",
      "react-rnd",
      "@dnd-kit/core",
      "@dnd-kit/sortable",
      "@radix-ui/react-dialog",
      "@radix-ui/react-dropdown-menu",
      "@radix-ui/react-popover",
      "@radix-ui/react-tooltip",
      "@radix-ui/react-tabs",
      "@radix-ui/react-scroll-area",
      "@radix-ui/react-slot",
      "@radix-ui/react-label",
      "@radix-ui/react-accordion",
      "@radix-ui/react-avatar",
      "dexie",
      // Reached only through lazy routes (doc editor, workflow graph, plan
      // detail) — without pre-bundling, first visit mid-session triggers a
      // re-optimize that 504s their stale module URLs until restart.
      "prosemirror-collab",
      "@xyflow/react",
      // The Evals area's shared views (app/evals/page.tsx), a lazy route too.
      "@platform/evals/react",
    ],
  },
  build: {
    sourcemap: true,
    target: "es2022",
    // dist/.vite/manifest.json: the web server reads the share entry's chunk
    // graph from it to emit modulepreload hints (server/share.ts).
    manifest: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return;

          // NOTE: do NOT manual-chunk mermaid / cytoscape / dagre / d3 / katex / @xyflow.
          // They're only reached via dynamic `import("mermaid")` inside MermaidDiagram
          // (and similarly for the others' callsites). Putting them in a named
          // manualChunk pulls them into the entry's static import graph (Rollup quirk),
          // which eagerly evaluates mermaid's module body on every page and crashes
          // with `this.clear is not a function` due to a dep version mismatch in
          // mermaid's bundled lodash. Letting Rollup auto-chunk them keeps them
          // load-on-demand.

          // TipTap + ProseMirror editor: only mounted on conversation/doc views.
          if (
            id.includes("/node_modules/@tiptap/") ||
            id.includes("/node_modules/prosemirror-") ||
            id.includes("/node_modules/@convex-dev/prosemirror-sync/")
          ) {
            return "tiptap";
          }

          // Syntax highlight pipeline — only used inside markdown renderers.
          if (
            id.includes("/node_modules/lowlight/") ||
            id.includes("/node_modules/highlight.js/") ||
            id.includes("/node_modules/prismjs/") ||
            id.includes("/node_modules/refractor/")
          ) {
            return "highlight";
          }

          // Diff viewer is conversation-only.
          if (
            id.includes("/node_modules/diff/") ||
            id.includes("/node_modules/diff-match-patch/") ||
            id.includes("/node_modules/react-diff-view/")
          ) {
            return "diff";
          }

          // Drag-drop only used in queue/board UIs.
          if (id.includes("/node_modules/@dnd-kit/")) return "dnd";

          if (
            id.includes("/node_modules/react/") ||
            id.includes("/node_modules/react-dom/") ||
            id.includes("/node_modules/scheduler/") ||
            id.includes("/node_modules/react-router/")
          ) {
            return "vendor";
          }
          if (id.includes("/node_modules/convex/") || id.includes("/node_modules/@convex-dev/auth/")) return "convex";
          if (id.includes("/node_modules/@radix-ui/")) return "ui";
          if (
            id.includes("/node_modules/react-markdown/") ||
            id.includes("/node_modules/rehype-") ||
            id.includes("/node_modules/remark-") ||
            id.includes("/node_modules/mdast-")
          ) {
            return "markdown";
          }
          if (id.includes("/node_modules/@sentry/")) return "sentry";
          if (id.includes("/node_modules/posthog-js/")) return "posthog";
          if (id.includes("/node_modules/dexie/")) return "dexie";
        },
      },
    },
  },
}));
