import { useCallback } from "react";
import { useAuthActions } from "@convex-dev/auth/react";

/**
 * The only supported explicit logout path for a web app on this stack.
 * `beforeSignOut` drops the app's in-memory state before the token goes, so
 * nothing of the account renders again. The token removal is the boundary
 * every window observes (see authPrincipal); `purge` then removes every copy
 * of the four auth keys, because @convex-dev/auth rotation intentionally
 * leaves a refresh token IDB backup. `afterSignOut` purges the app's disk
 * cache last: it runs once the account is already signed out everywhere, and
 * its failure still stops the caller from navigating, so a supposedly
 * signed-out browser never quietly keeps a readable copy of the account's
 * data.
 */
export function useDurableSignOut(params: {
  keys: readonly string[];
  purge: (keys: readonly string[]) => Promise<void>;
  beforeSignOut?: () => Promise<void> | void;
  afterSignOut?: () => Promise<void> | void;
}): () => Promise<void> {
  const { signOut } = useAuthActions();
  const { keys, purge, beforeSignOut, afterSignOut } = params;
  return useCallback(async () => {
    await beforeSignOut?.();
    try {
      await signOut();
    } finally {
      await purge(keys);
    }
    await afterSignOut?.();
  }, [signOut, keys, purge, beforeSignOut, afterSignOut]);
}
