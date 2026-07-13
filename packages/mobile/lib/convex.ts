import { ConvexReactClient } from "convex/react";

// Fall back to production, never to "": build 28 shipped with a stale
// EXPO_PUBLIC_CONVEX_URL (the pre-migration Convex Cloud deployment) and every
// sign-in method errored under App Store review. Local/dev flows always set
// the env var, so the fallback only engages when a build would otherwise be
// pointed at nothing.
const CONVEX_URL = process.env.EXPO_PUBLIC_CONVEX_URL || "https://convex.codecast.sh";

export const convex = new ConvexReactClient(CONVEX_URL, {
  unsavedChangesWarning: false,
});
