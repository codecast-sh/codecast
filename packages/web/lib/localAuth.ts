import { createLocalAuth } from "@platform/auth/web";

import { CONVEX_URL } from "./convexUrl";

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
 *
 * The signal itself lives in @platform/auth/web; the deployment URL below is
 * the storage namespace it is built for.
 */

export { CONVEX_URL };

const localAuth = createLocalAuth(CONVEX_URL);

export const AUTH_STORAGE_NAMESPACE = localAuth.namespace;
export const namespacedAuthStorageKey = localAuth.namespacedKey;

// Mirrors @convex-dev/auth's useNamespacedStorage key layout:
// `${key}_${namespace}` with non-alphanumerics stripped from the namespace,
// which defaults to the deployment URL. Exported for the contract test —
// if a package upgrade changes this layout, offline boot silently breaks.
export const AUTH_JWT_STORAGE_KEY = localAuth.jwtKey;
export const AUTH_REFRESH_TOKEN_STORAGE_KEY = localAuth.refreshTokenKey;
export const AUTH_OAUTH_VERIFIER_STORAGE_KEY = localAuth.oauthVerifierKey;
export const AUTH_SERVER_STATE_STORAGE_KEY = localAuth.serverStateKey;

/** All four keys, the set an explicit logout must purge. */
export const AUTH_STORAGE_KEYS = localAuth.keys;

/** Synchronous peek: is a Convex auth JWT sitting in localStorage right now? */
export const hasStoredAuthToken = localAuth.hasStoredAuthToken;

/**
 * True when the user is authenticated as far as this device knows: the auth
 * provider holds a token, or one is stored locally (covers the first frames
 * before the provider finishes its async storage read). Token expiry is
 * deliberately ignored — refresh happens against the server in the
 * background, and offline the cached UI must keep rendering regardless.
 */
export const useLocalAuth = localAuth.useLocalAuth;
