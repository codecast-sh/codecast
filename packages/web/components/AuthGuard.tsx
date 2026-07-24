import { useConvexAuth } from "convex/react";
import { useRouter } from "next/navigation";
import { useMountEffect } from "../hooks/useMountEffect";
import { useLocalAuth } from "../lib/localAuth";
import { AppLoader } from "./AppLoader";
import { usePrincipalLocalState } from "./PrincipalLocalStateProvider";

function RedirectToHome() {
  const router = useRouter();
  useMountEffect(() => { router.push("/"); });
  return null;
}

/**
 * Local-first auth gate: renders children as soon as a token exists in local
 * storage, without waiting for the Convex WebSocket to confirm it — so the
 * dashboard paints instantly from the IndexedDB-hydrated store, online or
 * offline. The server still validates the token in the background; if it's
 * expired the auth layer refreshes it, and a definitive sign-out clears the
 * stored token, which flips this gate to the redirect.
 *
 * guestOk: render children for unauthenticated visitors instead of
 * redirecting home — for routes that do their own access resolution
 * (public share links).
 */
export function AuthGuard({ children, guestOk }: { children: React.ReactNode; guestOk?: boolean }) {
  const localAuthed = useLocalAuth();
  const { isAuthenticated, isLoading } = useConvexAuth();
  const { state: principalState } = usePrincipalLocalState();

  if (principalState.phase === "offline-ready" || principalState.phase === "server-verified") {
    return <>{children}</>;
  }
  // Public/share routes may render, but protected memory has already been
  // synchronously cleared by the principal runtime.
  if (guestOk) return <>{children}</>;
  if (principalState.phase === "locked" && principalState.reason) {
    // Durable credential resolution completed and proved there is no safe
    // protected namespace. Ignore a stale access-token copy instead of leaving
    // protected routes on an infinite loader.
    return <RedirectToHome />;
  }
  // No local token yet, but the provider is still reading storage (its
  // IndexedDB fallback path) — a local, offline-safe wait of a few frames.
  if (localAuthed || isAuthenticated || isLoading) return <AppLoader />;
  return <RedirectToHome />;
}
