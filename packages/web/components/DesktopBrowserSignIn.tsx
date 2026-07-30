import { useRef, useState } from "react";
import { useQuery } from "convex/react";
import { useAuthActions } from "@convex-dev/auth/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useWatchEffect } from "../hooks/useWatchEffect";
import { bridge } from "../lib/desktop";

// Desktop (Electron) sign-in via the system browser — GitHub issue #20.
//
// The embedded window is a blank browser profile: no Google/GitHub cookies, so
// OAuth inside it makes the user re-authenticate with every provider from
// scratch. Instead the desktop hands the whole flow to the browser where those
// sessions already live: it opens /auth/cli?mode=desktop with a one-time
// nonce, the user authorizes there (signing in or up first if needed — the
// page's return_to chain handles that), the page deposits a relay grant, and
// this component — live-subscribed to cliAuth.pendingDeposit — redeems it via
// the desktop-relay credentials provider for a normal session.
//
// Gated on the openExternal bridge method: older desktop builds without it
// keep the in-window provider buttons, so nothing regresses.
export function canUseDesktopBrowserSignIn(): boolean {
  return !!bridge("openExternal");
}

function makeNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function DesktopBrowserSignIn() {
  const { signIn } = useAuthActions();
  const [nonce, setNonce] = useState<string | null>(null);
  const [error, setError] = useState("");
  const redeeming = useRef(false);

  const deposited = useQuery(
    api.cliAuth.pendingDeposit,
    nonce ? { nonce } : "skip"
  );

  const start = () => {
    const fresh = makeNonce();
    setError("");
    setNonce(fresh);
    const url = `${window.location.origin}/auth/cli?mode=desktop&nonce=${fresh}&device=${encodeURIComponent("Codecast Desktop")}`;
    bridge("openExternal")?.(url);
  };

  const cancel = () => {
    setNonce(null);
    redeeming.current = false;
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
    // On success the auth provider flips isAuthenticated and the login page's
    // own redirect effect takes it from there.
  }, [nonce, deposited, signIn]);

  if (nonce) {
    return (
      <div className="w-full py-4 px-4 bg-sol-bg/50 border border-sol-border rounded-lg text-center">
        <div className="flex items-center justify-center gap-3 text-sol-text">
          <span className="inline-block w-4 h-4 border-2 border-amber-500 border-t-transparent rounded-full animate-spin" />
          Finish signing in in your browser
        </div>
        <p className="text-sol-text-muted text-sm mt-2">
          Authorize the sign-in on the page that just opened — this window
          continues automatically.
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
      <button
        onClick={start}
        className="w-full py-3 px-4 bg-amber-600 hover:bg-amber-500 text-white font-medium rounded-lg transition-colors focus:outline-none focus:ring-2 focus:ring-amber-500 focus:ring-offset-2 focus:ring-offset-sol-bg flex items-center justify-center gap-2"
      >
        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          <path strokeLinecap="round" strokeLinejoin="round" d="M3.6 9h16.8M3.6 15h16.8M12 3a15 15 0 010 18M12 3a15 15 0 000 18" />
        </svg>
        Continue with your browser
      </button>
      {error && <p className="mt-3 text-sm text-red-400 text-center">{error}</p>}
      <p className="mt-3 text-sm text-sol-text-muted text-center">
        Opens your browser, where you&apos;re already signed in.
      </p>
    </>
  );
}
