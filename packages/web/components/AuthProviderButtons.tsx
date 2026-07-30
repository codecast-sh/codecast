import { useRef, useState } from "react";
import { useQuery } from "convex/react";
import { useAuthActions } from "@convex-dev/auth/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useWatchEffect } from "../hooks/useWatchEffect";
import { bridge } from "../lib/desktop";

// Apple + GitHub sign-in buttons, shared by /login and /signup.
//
// In a browser they run the provider OAuth redirect directly, as always. In
// the desktop app the embedded window has no provider sessions (issue #20),
// so the SAME buttons instead hand the flow to the system browser: open
// /auth/cli?mode=desktop with a one-time nonce and a provider hint, let the
// user authorize there, and redeem the deposited grant via the desktop-relay
// credentials provider the moment the live pendingDeposit query flips. The
// user sees identical buttons everywhere — only where the OAuth happens
// differs. Desktop builds too old to expose openExternal keep the in-window
// OAuth (pre-#20 behavior).

function desktopBrowserAuth(): boolean {
  return !!bridge("openExternal");
}

function makeNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

const PROVIDERS = [
  {
    id: "apple" as const,
    label: "Apple",
    className:
      "w-full py-3 px-4 bg-white hover:bg-gray-100 disabled:bg-white/50 disabled:cursor-not-allowed text-black font-medium rounded-lg transition-colors focus:outline-none focus:ring-2 focus:ring-amber-500 focus:ring-offset-2 focus:ring-offset-sol-bg flex items-center justify-center gap-2",
    icon: (
      <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
        <path d="M17.05 20.28c-.98.95-2.05.8-3.08.35-1.09-.46-2.09-.48-3.24 0-1.44.62-2.2.44-3.06-.35C2.79 15.25 3.51 7.59 9.05 7.31c1.35.07 2.29.74 3.08.8 1.18-.24 2.31-.93 3.57-.84 1.51.12 2.65.72 3.4 1.8-3.12 1.87-2.38 5.98.48 7.13-.57 1.5-1.31 2.99-2.53 4.09zM12.03 7.25c-.15-2.23 1.66-4.07 3.74-4.25.29 2.58-2.34 4.5-3.74 4.25z" />
      </svg>
    ),
  },
  {
    id: "github" as const,
    label: "GitHub",
    className:
      "w-full mt-3 py-3 px-4 bg-[#24292e] hover:bg-[#1a1e22] disabled:bg-[#24292e]/50 disabled:cursor-not-allowed text-white font-medium rounded-lg transition-colors focus:outline-none focus:ring-2 focus:ring-amber-500 focus:ring-offset-2 focus:ring-offset-sol-bg flex items-center justify-center gap-2",
    icon: (
      <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
        <path
          fillRule="evenodd"
          d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"
          clipRule="evenodd"
        />
      </svg>
    ),
  },
];

export function AuthProviderButtons({
  verb,
  redirectTo,
}: {
  verb: "in" | "up";
  redirectTo: string;
}) {
  const { signIn } = useAuthActions();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  // Desktop browser handoff state: the nonce we're waiting on, or null.
  const [nonce, setNonce] = useState<string | null>(null);
  const redeeming = useRef(false);

  const deposited = useQuery(api.cliAuth.pendingDeposit, nonce ? { nonce } : "skip");

  const cancel = () => {
    setNonce(null);
    redeeming.current = false;
  };

  const start = async (provider: "apple" | "github", label: string) => {
    setError("");
    if (desktopBrowserAuth()) {
      const fresh = makeNonce();
      setNonce(fresh);
      const url =
        `${window.location.origin}/auth/cli?mode=desktop&nonce=${fresh}` +
        `&device=${encodeURIComponent("Codecast Desktop")}&provider=${provider}`;
      bridge("openExternal")?.(url);
      return;
    }
    setLoading(true);
    try {
      await signIn(provider, { redirectTo });
    } catch {
      setError(`${label} sign ${verb} failed. Please try again.`);
      setLoading(false);
    }
  };

  useWatchEffect(() => {
    if (!nonce || !deposited || redeeming.current) return;
    redeeming.current = true;
    signIn("desktop-relay", { nonce }).catch((err) => {
      // Claim raced away or expired — a fresh click mints a fresh nonce.
      console.error("Desktop browser sign-in redeem failed:", err);
      setError("Sign-in didn't complete. Please try again.");
      cancel();
    });
    // On success the auth provider flips isAuthenticated and the page's own
    // redirect effect takes it from there.
  }, [nonce, deposited, signIn]);

  if (nonce) {
    return (
      <div className="w-full py-4 px-4 bg-sol-bg/50 border border-sol-border rounded-lg text-center">
        <div className="flex items-center justify-center gap-3 text-sol-text">
          <span className="inline-block w-4 h-4 border-2 border-sol-text-muted border-t-transparent rounded-full animate-spin" />
          Finishing sign-in in your browser
        </div>
        <p className="text-sol-text-muted text-sm mt-2">
          Approve it there — this window signs in by itself.
        </p>
        <button
          onClick={cancel}
          className="mt-3 text-sm text-amber-400 hover:text-amber-300 transition-colors"
        >
          Cancel
        </button>
      </div>
    );
  }

  return (
    <>
      {PROVIDERS.map((p) => (
        <button key={p.id} onClick={() => start(p.id, p.label)} disabled={loading} className={p.className}>
          {p.icon}
          Sign {verb} with {p.label}
        </button>
      ))}
      {error && <p className="mt-3 text-sm text-red-400 text-center">{error}</p>}
      {desktopBrowserAuth() && (
        <p className="mt-3 text-sm text-sol-text-dim text-center">
          Sign-in opens in your browser.
        </p>
      )}
    </>
  );
}
