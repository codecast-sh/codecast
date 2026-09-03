import path from "path";

/**
 * Build settings shared by every vite config in this package: the app config
 * (vite.config.ts) and the SSR config that builds the marketing prerender and
 * the share-page renderer (vite.prerender.config.ts).
 *
 * These live here, and not on one config that the other reaches into, because
 * that coupling breaks silently. vite.prerender.config.ts used to read
 * `baseConfig.resolve` off the app config's default export. When the app config
 * became a function — `defineConfig(({ mode }) => ({ … }))`, to stamp a build
 * identity — that property became undefined, the SSR build lost every alias,
 * and it failed for a week without blocking a single deploy: the prerender step
 * fails open on purpose, so crawlers quietly got the empty SPA shell instead of
 * real pages. Importing the same module from both configs cannot drift that way.
 *
 * `__dirname` is this package's root under vite's config loader, which is what
 * every path below is relative to.
 */
export const sharedResolve = {
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
};

export const sharedCss = {
  postcss: "./postcss.config.mjs",
};
