import type { ReactNode } from "react";
import { useConvexAuth } from "convex/react";

export type AuthGateDecision = "children" | "loading" | "guest";

/**
 * Local first auth gate rule: render as soon as a token exists locally,
 * without waiting for the Convex WebSocket to confirm it. The server still
 * validates the token in the background; if it is expired the auth layer
 * refreshes it, and a definitive sign-out clears the stored token, which flips
 * this gate to "guest".
 *
 * "loading": no local token yet, but the provider is still reading storage
 * (its IndexedDB fallback path), a local, offline safe wait of a few frames.
 */
export function authGateDecision(opts: {
  localAuthed: boolean;
  isAuthenticated: boolean;
  isLoading: boolean;
}): AuthGateDecision {
  if (opts.localAuthed || opts.isAuthenticated) return "children";
  if (opts.isLoading) return "loading";
  return "guest";
}

export function useAuthGate(useLocalAuth: () => boolean): AuthGateDecision {
  const localAuthed = useLocalAuth();
  const { isAuthenticated, isLoading } = useConvexAuth();
  return authGateDecision({ localAuthed, isAuthenticated, isLoading });
}

/**
 * guestOk: render children for unauthenticated visitors instead of the
 * `unauthenticated` element, for routes that do their own access resolution
 * (public share links). The app supplies its loader and its redirect element.
 */
export function AuthGuard({
  children,
  guestOk,
  useLocalAuth,
  loading,
  unauthenticated,
}: {
  children: ReactNode;
  guestOk?: boolean;
  useLocalAuth: () => boolean;
  loading: ReactNode;
  unauthenticated: ReactNode;
}) {
  const decision = useAuthGate(useLocalAuth);
  if (decision === "children") return <>{children}</>;
  if (decision === "loading") return <>{loading}</>;
  return guestOk ? <>{children}</> : <>{unauthenticated}</>;
}
