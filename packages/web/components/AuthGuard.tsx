import { useRouter } from "next/navigation";
import { AuthGuard as LocalFirstAuthGuard } from "@platform/auth/web";
import { useMountEffect } from "../hooks/useMountEffect";
import { AUTH_REFRESH_TOKEN_STORAGE_KEY, useLocalAuth } from "../lib/localAuth";
import { noteAuthLeave } from "../lib/authReturn";
import { oauthJustFailed } from "../lib/oauthReturn";
import { AppLoader } from "./AppLoader";
import { WELCOME_PATH, readLaneHint } from "./simple/laneBoot";

/** How long a signed-out verdict must hold before the page leaves. A token
 *  refresh can read as signed out for a moment (no stored token yet, the
 *  socket not yet authenticated); a reload under load landed signed-in
 *  people on the marketing page that way. The gate unmounts this the moment
 *  auth comes back, which cancels the leave. */
const SIGNED_OUT_SETTLE_MS = 1500;
/** While a refresh token is still stored the auth layer is mid-refresh, not
 *  signed out (a definitive sign-out clears it), so the leave waits up to this
 *  long for it to land. */
const REFRESH_WAIT_MS = 15_000;

function refreshPending(): boolean {
  try {
    return localStorage.getItem(AUTH_REFRESH_TOKEN_STORAGE_KEY) !== null;
  } catch {
    return false;
  }
}

function RedirectUnsignedIn({ to }: { to: string }) {
  const router = useRouter();
  useMountEffect(() => {
    if (oauthJustFailed()) {
      router.replace("/login?reason=oauth");
      return;
    }
    // A device last seen in hosted mode signs in again on /welcome, in the
    // family's look, never on the developer marketing page.
    const target = to === "/" && readLaneHint() === "simple" ? WELCOME_PATH : to;
    const started = Date.now();
    let timer = 0;
    const settle = () => {
      if (refreshPending() && Date.now() - started < REFRESH_WAIT_MS) {
        timer = window.setTimeout(settle, SIGNED_OUT_SETTLE_MS);
        return;
      }
      // Where the person was, so the landing page can send them back if
      // auth returns (lib/authReturn).
      noteAuthLeave(`${window.location.pathname}${window.location.search}${window.location.hash}`);
      router.push(target);
    };
    timer = window.setTimeout(settle, SIGNED_OUT_SETTLE_MS);
    return () => window.clearTimeout(timer);
  });
  return <AppLoader />;
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
      unauthenticated={blankSignedOut ? null : <RedirectUnsignedIn to="/" />}
    >
      {children}
    </LocalFirstAuthGuard>
  );
}
