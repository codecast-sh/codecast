import type { Plugin } from "vite";

/**
 * A preconnect to the Convex deployment in index.html's <head>, so DNS and TLS
 * to it are done by the time the client opens its socket at the end of boot
 * (src/providers.tsx) instead of starting then.
 *
 * Read from the build's env with lib/convexUrl.ts's fallback: that module
 * reads import.meta.env, which the config's own bundle does not have.
 */
export const DEFAULT_CONVEX_URL = "https://convex.codecast.sh";

export function convexPreconnectPlugin(): Plugin {
  let origin = new URL(DEFAULT_CONVEX_URL).origin;
  return {
    name: "codecast-convex-preconnect",
    configResolved(config) {
      try {
        origin = new URL(config.env.VITE_CONVEX_URL || DEFAULT_CONVEX_URL).origin;
      } catch {
        // A malformed URL: lib/convexUrl.ts would fail on it too; hint the default.
      }
    },
    transformIndexHtml() {
      return [{ tag: "link", attrs: { rel: "preconnect", href: origin, crossorigin: "" }, injectTo: "head" }];
    },
  };
}
