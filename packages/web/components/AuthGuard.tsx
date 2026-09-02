import { useRouter } from "next/navigation";
import { AuthGuard as LocalFirstAuthGuard } from "@platform/auth/web";
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
 * stored token, which flips this gate to the redirect. The rule itself is
 * @platform/auth/web's; the loader and the redirect are codecast's.
 *
 * guestOk: render children for unauthenticated visitors instead of
 * redirecting home — for routes that do their own access resolution
 * (public share links).
 *
 * blankSignedOut: render NOTHING while signed out or loading, instead of the
 * loader and the redirect — for see-through overlay windows, where a loader
 * is an opaque card floating over the person's work and a redirect lands the
 * marketing home page in an always-on-top square. Invisible glass is the
 * honest signed-out state there, and children resume the moment a sign-in
 * flips the gate.
 */
export function AuthGuard({
  children,
  guestOk,
  blankSignedOut,
}: {
  children: React.ReactNode;
  guestOk?: boolean;
  blankSignedOut?: boolean;
}) {
  return (
    <LocalFirstAuthGuard
      guestOk={guestOk}
      useLocalAuth={useLocalAuth}
      loading={blankSignedOut ? null : <AppLoader />}
      unauthenticated={blankSignedOut ? null : <RedirectToHome />}
    >
      {children}
    </LocalFirstAuthGuard>
  );
}
