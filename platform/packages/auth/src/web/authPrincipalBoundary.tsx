import { Fragment, type ReactNode } from "react";
import { type AuthPrincipalTracker, useAuthPrincipalEpoch } from "./authPrincipal";

/**
 * Remounts its subtree on every principal change, so the auth provider
 * inside re-reads storage and every component below it starts from nothing.
 * The app's own side effects (clearing memory, stopping replication) belong
 * on `tracker.subscribe`, which fires synchronously at the change, before
 * React renders anything for the next account.
 */
export function AuthPrincipalBoundary({ tracker, children }: { tracker: AuthPrincipalTracker; children: ReactNode }) {
  const epoch = useAuthPrincipalEpoch(tracker);
  return <Fragment key={epoch}>{children}</Fragment>;
}
