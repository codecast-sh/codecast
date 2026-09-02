import { useAuthToken } from "@convex-dev/auth/react";

/**
 * Local first auth signal.
 *
 * There are two "authenticated" states in this stack: @convex-dev/auth's
 * provider flips to authenticated as soon as it reads the JWT from storage
 * (milliseconds, works offline), while convex/react's useConvexAuth /
 * <Authenticated> additionally wait for the backend to validate the token
 * over the WebSocket, a network round trip that never resolves offline.
 *
 * Anything that gates *rendering* must use this local signal so the app
 * boots straight from the locally hydrated store with no server round trip.
 * The server confirmed signal is still the right one for issuing authed
 * side effects; this one only decides what to draw.
 */

// Mirrors @convex-dev/auth's useNamespacedStorage key layout:
// `${key}_${namespace}` with non alphanumerics stripped from the namespace,
// which defaults to the deployment URL. Pinned by the contract test: if a
// package upgrade changes this layout, offline boot silently breaks.
export const CONVEX_AUTH_JWT_KEY = "__convexAuthJWT";
export const CONVEX_AUTH_REFRESH_TOKEN_KEY = "__convexAuthRefreshToken";
export const CONVEX_AUTH_OAUTH_VERIFIER_KEY = "__convexAuthOAuthVerifier";
export const CONVEX_AUTH_SERVER_STATE_KEY = "__convexAuthServerStateFetchTime";

export function authStorageNamespace(convexUrl: string): string {
  return convexUrl.replace(/[^a-zA-Z0-9]/g, "");
}

export type LocalAuth = {
  namespace: string;
  namespacedKey: (key: string) => string;
  jwtKey: string;
  refreshTokenKey: string;
  oauthVerifierKey: string;
  serverStateKey: string;
  /** All four keys, the set an explicit logout must purge. */
  keys: readonly string[];
  /** Synchronous peek: is a Convex auth JWT sitting in localStorage right now? */
  hasStoredAuthToken: () => boolean;
  /**
   * True when the user is authenticated as far as this device knows: the auth
   * provider holds a token, or one is stored locally (covers the first frames
   * before the provider finishes its async storage read). Token expiry is
   * deliberately ignored: refresh happens against the server in the
   * background, and offline the cached UI must keep rendering regardless.
   */
  useLocalAuth: () => boolean;
};

/** Build the local auth signal for one deployment URL (the storage namespace). */
export function createLocalAuth(convexUrl: string): LocalAuth {
  const namespace = authStorageNamespace(convexUrl);
  const namespacedKey = (key: string) => `${key}_${namespace}`;
  const jwtKey = namespacedKey(CONVEX_AUTH_JWT_KEY);
  const refreshTokenKey = namespacedKey(CONVEX_AUTH_REFRESH_TOKEN_KEY);
  const oauthVerifierKey = namespacedKey(CONVEX_AUTH_OAUTH_VERIFIER_KEY);
  const serverStateKey = namespacedKey(CONVEX_AUTH_SERVER_STATE_KEY);

  function hasStoredAuthToken(): boolean {
    try {
      return localStorage.getItem(jwtKey) !== null;
    } catch {
      return false;
    }
  }

  function useLocalAuth(): boolean {
    const token = useAuthToken();
    return token !== null || hasStoredAuthToken();
  }

  return {
    namespace,
    namespacedKey,
    jwtKey,
    refreshTokenKey,
    oauthVerifierKey,
    serverStateKey,
    keys: [jwtKey, refreshTokenKey, oauthVerifierKey, serverStateKey],
    hasStoredAuthToken,
    useLocalAuth,
  };
}
