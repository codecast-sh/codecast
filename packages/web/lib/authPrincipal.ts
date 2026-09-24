// Which account this window acts for: the principal named by the stored JWT,
// tracked across every window of the profile (see @platform/auth/web
// authPrincipal). One tracker per window; the cache, replication and the
// auth root all key on it.
import { createAuthPrincipalTracker, useAuthPrincipal as useTrackedAuthPrincipal, type AuthPrincipalTracker } from "@platform/auth/web";
import { readDurableAuthValue, subscribeAuthStorageWrites } from "./durableAuthStorage";
import { AUTH_JWT_STORAGE_KEY } from "./localAuth";

// One per window, across dev hot swaps too: a second tracker would report
// every change twice and clear the store twice.
export const authPrincipal: AuthPrincipalTracker =
  import.meta.hot?.data?.authPrincipal ??
  createAuthPrincipalTracker({
    jwtKey: AUTH_JWT_STORAGE_KEY,
    subscribeWrites: subscribeAuthStorageWrites,
    readDurable: readDurableAuthValue,
  });
if (import.meta.hot) import.meta.hot.data.authPrincipal = authPrincipal;

/** The principal this window acts for, re-rendering on every principal change. */
export function useAuthPrincipal(): { principalId: string | null; epoch: number } {
  return useTrackedAuthPrincipal(authPrincipal);
}
