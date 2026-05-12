import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { sentryVitePlugin } from "@sentry/vite-plugin";
import path from "path";

export default defineConfig({
  plugins: [
    react(),
    sentryVitePlugin({
      org: process.env.SENTRY_ORG || "codecast-a2",
      project: process.env.SENTRY_PROJECT || "javascript-react",
      authToken: process.env.SENTRY_AUTH_TOKEN,
      disable: !process.env.SENTRY_AUTH_TOKEN,
    }),
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
      "next/navigation": path.resolve(__dirname, "src/compat/next-navigation.ts"),
      "next/link": path.resolve(__dirname, "src/compat/next-link.tsx"),
      // React 19 compat: stable useComposedRefs to prevent infinite re-render loop
      "@radix-ui/react-compose-refs": path.resolve(__dirname, "src/compat/radix-compose-refs.ts"),
      // @tiptap/pm v3 dropped the ./collab subpath; @convex-dev/prosemirror-sync still imports it.
      // The v2 subpath was just a re-export of prosemirror-collab, which remains installed.
      "@tiptap/pm/collab": "prosemirror-collab",
    },
    dedupe: ["convex", "react", "react-dom"],
  },
  css: {
    postcss: "./postcss.config.mjs",
  },
  server: {
    port: 3000,
    host: true,
    allowedHosts: ["local.codecast.sh", "local.1.codecast.sh", "local.2.codecast.sh"],
  },
  build: {
    sourcemap: true,
    target: "es2022",
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
});
