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

          // Heavy diagram/math libs — only loaded when MermaidDiagram is rendered.
          if (id.includes("/node_modules/mermaid/")) return "mermaid";
          if (id.includes("/node_modules/katex/")) return "katex";
          if (id.includes("/node_modules/cytoscape")) return "cytoscape";
          if (id.includes("/node_modules/dagre") || id.includes("/node_modules/d3-")) return "diagram-deps";

          if (
            id.includes("/node_modules/react/") ||
            id.includes("/node_modules/react-dom/") ||
            id.includes("/node_modules/scheduler/")
          ) {
            return "vendor";
          }
          if (id.includes("/node_modules/convex/") || id.includes("/node_modules/@convex-dev/auth/")) return "convex";
          if (id.includes("/node_modules/@radix-ui/")) return "ui";
          if (
            id.includes("/node_modules/react-markdown/") ||
            id.includes("/node_modules/rehype-highlight/") ||
            id.includes("/node_modules/remark-gfm/") ||
            id.includes("/node_modules/prismjs/")
          ) {
            return "markdown";
          }
        },
      },
    },
  },
});
