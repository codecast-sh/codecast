import { useDurableSignOut } from "@platform/auth/web";
import { AUTH_STORAGE_KEYS } from "@/lib/localAuth";
import { purgeDurableAuthValues } from "@/lib/durableAuthStorage";
import { purgeLocalCache } from "@/store/idbCache";
import { clearProtectedInboxMemory } from "@/store/inboxStore";

// Purge the local cache and in-memory state before the caller is allowed to
// navigate. Failure stops logout rather than leaving a supposedly signed-out
// browser with a readable local copy of the account's data. Module-level so
// the returned callback keeps a stable identity across renders.
async function clearCodecastLocalState(): Promise<void> {
  clearProtectedInboxMemory();
  await purgeLocalCache();
}

/** The only supported explicit logout path for the web application. */
export function useCodecastSignOut(): () => Promise<void> {
  // @convex-dev/auth rotation intentionally leaves a refresh-token IDB backup.
  // Explicit logout must remove that copy as well as localStorage.
  return useDurableSignOut({
    keys: AUTH_STORAGE_KEYS,
    purge: purgeDurableAuthValues,
    beforeSignOut: clearCodecastLocalState,
  });
}
