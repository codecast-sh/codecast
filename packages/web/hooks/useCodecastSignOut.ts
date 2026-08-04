import { useCallback } from "react";
import { useAuthActions } from "@convex-dev/auth/react";
import {
  AUTH_JWT_STORAGE_KEY,
  AUTH_OAUTH_VERIFIER_STORAGE_KEY,
  AUTH_REFRESH_TOKEN_STORAGE_KEY,
  AUTH_SERVER_STATE_STORAGE_KEY,
} from "@/lib/localAuth";
import { purgeDurableAuthValues } from "@/lib/durableAuthStorage";
import { purgeLocalCache } from "@/store/idbCache";
import { clearProtectedInboxMemory } from "@/store/inboxStore";

const AUTH_KEYS = [
  AUTH_JWT_STORAGE_KEY,
  AUTH_REFRESH_TOKEN_STORAGE_KEY,
  AUTH_OAUTH_VERIFIER_STORAGE_KEY,
  AUTH_SERVER_STATE_STORAGE_KEY,
] as const;

/** The only supported explicit logout path for the web application. */
export function useCodecastSignOut(): () => Promise<void> {
  const { signOut } = useAuthActions();
  return useCallback(async () => {
    // Purge the local cache and in-memory state before the caller is allowed
    // to navigate. Failure stops logout rather than leaving a supposedly
    // signed-out browser with a readable local copy of the account's data.
    clearProtectedInboxMemory();
    await purgeLocalCache();
    try {
      await signOut();
    } finally {
      // @convex-dev/auth rotation intentionally leaves a refresh-token IDB
      // backup. Explicit logout must remove that copy as well as localStorage.
      await purgeDurableAuthValues(AUTH_KEYS);
    }
  }, [signOut]);
}
