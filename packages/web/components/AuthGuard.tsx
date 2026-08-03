import { useConvexAuth } from "convex/react";
import { useRouter } from "next/navigation";
import { useMountEffect } from "../hooks/useMountEffect";
import { useLocalAuth } from "../lib/localAuth";
import { AppLoader } from "./AppLoader";

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

  if (localAuthed || isAuthenticated) return <>{children}</>;
  // No local token yet, but the provider is still reading storage (its
  // IndexedDB fallback path) — a local, offline-safe wait of a few frames.
  if (isLoading) return <AppLoader />;
  return guestOk ? <>{children}</> : <RedirectToHome />;
}
