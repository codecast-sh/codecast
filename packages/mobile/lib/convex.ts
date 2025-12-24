import { ConvexReactClient } from "convex/react";

const CONVEX_URL = process.env.EXPO_PUBLIC_CONVEX_URL || "";

export const convex = new ConvexReactClient(CONVEX_URL, {
  unsavedChangesWarning: false,
});
