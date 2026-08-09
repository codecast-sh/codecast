// The one definition of the Convex deployment URL. A leaf module with no
// imports: localAuth (auth namespacing, Convex clients) and
// trustedImageOrigins (image trust set) both derive from it, and the latter
// is loaded by sanitizer unit tests in bare bun/jsdom environments where
// React auth modules can't come along.
//
// The fallback is load-bearing: production builds don't set VITE_CONVEX_URL,
// so a module that reads the raw env var instead of this constant compiles to
// undefined in prod. That exact divergence shipped a trust set without the
// Convex storage origin, gating every pasted screenshot and `cast image`
// upload behind click-to-load.
// Read lazily via the function where callers must see a test-stubbed env
// (bun aliases import.meta.env to process.env, so a beforeAll stub lands
// after this module is already in the cache); the const form is for
// module-init consumers (auth namespace, Convex clients).
export function getConvexUrl(): string {
  return import.meta.env.VITE_CONVEX_URL || "https://convex.codecast.sh";
}

export const CONVEX_URL = getConvexUrl();
