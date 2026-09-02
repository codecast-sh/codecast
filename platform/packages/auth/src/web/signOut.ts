import { useCallback } from "react";
import { useAuthActions } from "@convex-dev/auth/react";

/**
 * The only supported explicit logout path for a web app on this stack.
 * `beforeSignOut` purges the app's local cache and in-memory state before the
 * caller is allowed to navigate; failure stops logout rather than leaving a
 * supposedly signed-out browser with a readable local copy of the account's
 * data. `purge` removes every copy of the four auth keys, because
 * @convex-dev/auth rotation intentionally leaves a refresh token IDB backup.
 */
export function useDurableSignOut(params: {
  keys: readonly string[];
  purge: (keys: readonly string[]) => Promise<void>;
  beforeSignOut?: () => Promise<void> | void;
}): () => Promise<void> {
  const { signOut } = useAuthActions();
  const { keys, purge, beforeSignOut } = params;
  return useCallback(async () => {
    await beforeSignOut?.();
    try {
      await signOut();
    } finally {
      await purge(keys);
    }
  }, [signOut, keys, purge, beforeSignOut]);
}
