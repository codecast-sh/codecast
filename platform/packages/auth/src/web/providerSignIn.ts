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

export type OAuthProviderId = "google" | "apple" | "github";

export type ProviderButton = {
  id: OAuthProviderId;
  label: string;
  /** A one color glyph (24x24 viewBox), drawn in the button's text color. */
  iconPath: string;
  /** A brand mark that must keep its own colors (Google's G); drawn instead of iconPath when present. */
  iconParts?: readonly { d: string; fill: string }[];
};

const GOOGLE_G_PARTS = [
  { fill: "#4285F4", d: "M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" },
  { fill: "#34A853", d: "M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.06-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" },
  { fill: "#FBBC05", d: "M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" },
  { fill: "#EA4335", d: "M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" },
] as const;

/** Every provider button, in display order, with its glyph (24x24 viewBox). */
export const OAUTH_PROVIDER_BUTTONS: readonly ProviderButton[] = [
  {
    id: "google",
    label: "Google",
    iconPath: GOOGLE_G_PARTS.map((p) => p.d).join(""),
    iconParts: GOOGLE_G_PARTS,
  },
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

/**
 * The providers shown when the app passes no `providers` list. Google is left
 * out because a deployment offers it only once its OAuth client is configured;
 * the app asks its server and passes the full list when Google is available.
 */
export const DEFAULT_OAUTH_PROVIDERS: readonly OAuthProviderId[] = ["apple", "github"];

/** The button for a provider id read from a URL or a prop, or undefined when it names none. */
export function oauthProviderButton(id: string | null | undefined): ProviderButton | undefined {
  return OAUTH_PROVIDER_BUTTONS.find((b) => b.id === id);
}

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
  /** Which buttons to show, in OAUTH_PROVIDER_BUTTONS order. Default DEFAULT_OAUTH_PROVIDERS. */
  providers?: readonly OAuthProviderId[];
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
    buttons: OAUTH_PROVIDER_BUTTONS.filter((b) => (params.providers ?? DEFAULT_OAUTH_PROVIDERS).includes(b.id)),
    start,
    cancel,
    nonce,
    loading,
    error,
    desktopBrowserAuth: !!desktop,
  };
}
