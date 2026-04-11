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
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ["react", "react-dom"],
          convex: ["convex", "@convex-dev/auth/react"],
          ui: [
            "@radix-ui/react-dialog",
            "@radix-ui/react-dropdown-menu",
            "@radix-ui/react-popover",
            "@radix-ui/react-tabs",
            "@radix-ui/react-scroll-area",
          ],
          markdown: ["react-markdown", "rehype-highlight", "remark-gfm", "prismjs"],
        },
      },
    },
  },
});
