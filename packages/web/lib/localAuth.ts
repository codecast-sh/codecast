import { useAuthToken } from "@convex-dev/auth/react";

/**
 * Local-first auth signal.
 *
 * There are two "authenticated" states in this stack: @convex-dev/auth's
 * provider flips to authenticated as soon as it reads the JWT from storage
 * (milliseconds, works offline), while convex/react's useConvexAuth /
 * <Authenticated> additionally wait for the backend to validate the token
 * over the WebSocket — a network round-trip that never resolves offline.
 *
 * Anything that gates *rendering* must use this local signal so the app
 * boots straight from the IndexedDB-hydrated store with no server round-trip.
 * The server-confirmed signal is still the right one for issuing authed
 * side effects; this one only decides what to draw.
 */

export const CONVEX_URL =
  import.meta.env.VITE_CONVEX_URL || "https://convex.codecast.sh";

// Mirrors @convex-dev/auth's useNamespacedStorage key layout:
// `${key}_${namespace}` with non-alphanumerics stripped from the namespace,
// which defaults to the deployment URL. Exported for the contract test —
// if a package upgrade changes this layout, offline boot silently breaks.
export const AUTH_JWT_STORAGE_KEY = `__convexAuthJWT_${CONVEX_URL.replace(/[^a-zA-Z0-9]/g, "")}`;

/** Synchronous peek: is a Convex auth JWT sitting in localStorage right now? */
export function hasStoredAuthToken(): boolean {
  try {
    return localStorage.getItem(AUTH_JWT_STORAGE_KEY) !== null;
  } catch {
    return false;
  }
}

/**
 * True when the user is authenticated as far as this device knows: the auth
 * provider holds a token, or one is stored locally (covers the first frames
 * before the provider finishes its async storage read). Token expiry is
 * deliberately ignored — refresh happens against the server in the
 * background, and offline the cached UI must keep rendering regardless.
 */
export function useLocalAuth(): boolean {
  const token = useAuthToken();
  return token !== null || hasStoredAuthToken();
}
