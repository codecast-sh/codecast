import { useDurableSignOut } from "@platform/auth/web";
import { AUTH_STORAGE_KEYS } from "@/lib/localAuth";
import { purgeDurableAuthValues } from "@/lib/durableAuthStorage";
import { purgeLocalCache } from "@/store/idbCache";
import { clearProtectedInboxMemory } from "@/store/inboxStore";

/**
 * The only supported explicit logout path for the web application.
 *
 * Memory goes first, synchronously. The token removal is the boundary every
 * window observes (store/principalBoundary): siblings clear and stop writing
 * on it. Then every copy of the four auth keys goes (@convex-dev/auth rotation
 * intentionally leaves a refresh-token IDB backup), and the disk cache last,
 * awaited: a failed purge still stops the caller from navigating instead of
 * leaving a supposedly signed-out browser with a readable local copy. The
 * cache is unreadable to any other account regardless: hydration serves it
 * only to the account whose user row it holds (idbCache).
 */
export function useCodecastSignOut(): () => Promise<void> {
  return useDurableSignOut({
    keys: AUTH_STORAGE_KEYS,
    purge: purgeDurableAuthValues,
    beforeSignOut: clearProtectedInboxMemory,
    afterSignOut: purgeLocalCache,
  });
}
