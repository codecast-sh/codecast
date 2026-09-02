// Provider button model, shared by /login and /signup, without any styling.
//
// In a browser the buttons run the provider OAuth redirect directly. In the
// desktop app the embedded window has no provider sessions, so the SAME
// buttons instead hand the flow to the system browser: open
// /auth/cli?mode=desktop with a one time nonce and a provider hint, let the
// user authorize there, and redeem the deposited grant via the desktop-relay
// credentials provider the moment the live pendingDeposit query flips. The
// user sees identical buttons everywhere; only where the OAuth happens differs.
import { useEffect, useRef, useState } from "react";
import { useQuery } from "convex/react";
import { useAuthActions } from "@convex-dev/auth/react";

export type OAuthProviderId = "apple" | "github";

export type ProviderButton = { id: OAuthProviderId; label: string; iconPath: string };

/** Apple and GitHub, in codecast's order, with their glyph paths (24x24 viewBox). */
export const OAUTH_PROVIDER_BUTTONS: readonly ProviderButton[] = [
  {
    id: "apple",
    label: "Apple",
    iconPath:
      "M17.05 20.28c-.98.95-2.05.8-3.08.35-1.09-.46-2.09-.48-3.24 0-1.44.62-2.2.44-3.06-.35C2.79 15.25 3.51 7.59 9.05 7.31c1.35.07 2.29.74 3.08.8 1.18-.24 2.31-.93 3.57-.84 1.51.12 2.65.72 3.4 1.8-3.12 1.87-2.38 5.98.48 7.13-.57 1.5-1.31 2.99-2.53 4.09zM12.03 7.25c-.15-2.23 1.66-4.07 3.74-4.25.29 2.58-2.34 4.5-3.74 4.25z",
  },
  {
    id: "github",
    label: "GitHub",
    iconPath:
      "M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z",
  },
];

export function makeNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** The URL the desktop app opens in the system browser. */
export function desktopAuthorizeUrl(opts: {
  origin: string;
  nonce: string;
  deviceName: string;
  provider: OAuthProviderId;
  path?: string;
}): string {
  const path = opts.path ?? "/auth/cli";
  return (
    `${opts.origin}${path}?mode=desktop&nonce=${opts.nonce}` +
    `&device=${encodeURIComponent(opts.deviceName)}&provider=${opts.provider}`
  );
}

export type ProviderSignInParams = {
  verb: "in" | "up";
  redirectTo: string;
  /** The app's `api.cliAuth.pendingDeposit` query reference. */
  pendingDeposit: any;
  /**
   * Present when running inside the desktop shell with a bridge that can open
   * the system browser. Null or undefined means plain in-window OAuth.
   */
  desktop?: { openExternal: (url: string) => void; deviceName: string; origin: string } | null;
  desktopRelayProviderId?: string;
};

export type ProviderSignInState = {
  buttons: readonly ProviderButton[];
  start: (provider: OAuthProviderId, label: string) => Promise<void>;
  cancel: () => void;
  /** Non null while the desktop handoff is waiting on the browser. */
  nonce: string | null;
  loading: boolean;
  error: string;
  desktopBrowserAuth: boolean;
};

export function useProviderSignIn(params: ProviderSignInParams): ProviderSignInState {
  const { signIn } = useAuthActions();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  // Desktop browser handoff state: the nonce we're waiting on, or null.
  const [nonce, setNonce] = useState<string | null>(null);
  const redeeming = useRef(false);
  const desktop = params.desktop ?? null;
  const relayId = params.desktopRelayProviderId ?? "desktop-relay";

  const deposited = useQuery(params.pendingDeposit, nonce ? { nonce } : "skip");

  const cancel = () => {
    setNonce(null);
    redeeming.current = false;
  };

  const start = async (provider: OAuthProviderId, label: string) => {
    setError("");
    if (desktop) {
      const fresh = makeNonce();
      setNonce(fresh);
      desktop.openExternal(
        desktopAuthorizeUrl({ origin: desktop.origin, nonce: fresh, deviceName: desktop.deviceName, provider }),
      );
      return;
    }
    setLoading(true);
    try {
      await signIn(provider, { redirectTo: params.redirectTo });
    } catch {
      setError(`${label} sign ${params.verb} failed. Please try again.`);
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!nonce || !deposited || redeeming.current) return;
    redeeming.current = true;
    signIn(relayId, { nonce }).catch((err) => {
      // Claim raced away or expired; a fresh click mints a fresh nonce.
      console.error("Desktop browser sign-in redeem failed:", err);
      setError("Sign-in didn't complete. Please try again.");
      cancel();
    });
    // On success the auth provider flips isAuthenticated and the page's own
    // redirect effect takes it from there.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nonce, deposited, signIn]);

  return {
    buttons: OAUTH_PROVIDER_BUTTONS,
    start,
    cancel,
    nonce,
    loading,
    error,
    desktopBrowserAuth: !!desktop,
  };
}
