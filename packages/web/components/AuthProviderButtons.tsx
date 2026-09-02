import { useProviderSignIn, type OAuthProviderId } from "@platform/auth/web";
import { api } from "@codecast/convex/convex/_generated/api";
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
//
// That whole flow is @platform/auth/web's `useProviderSignIn`; the markup,
// the Tailwind classes and the glyphs below are codecast's.

const BUTTON_CLASS: Record<OAuthProviderId, string> = {
  apple:
    "w-full py-3 px-4 bg-white hover:bg-gray-100 disabled:bg-white/50 disabled:cursor-not-allowed text-black font-medium rounded-lg transition-colors focus:outline-none focus:ring-2 focus:ring-amber-500 focus:ring-offset-2 focus:ring-offset-sol-bg flex items-center justify-center gap-2",
  github:
    "w-full mt-3 py-3 px-4 bg-[#24292e] hover:bg-[#1a1e22] disabled:bg-[#24292e]/50 disabled:cursor-not-allowed text-white font-medium rounded-lg transition-colors focus:outline-none focus:ring-2 focus:ring-amber-500 focus:ring-offset-2 focus:ring-offset-sol-bg flex items-center justify-center gap-2",
};

const ICON_FILL_RULE: Partial<Record<OAuthProviderId, "evenodd">> = { github: "evenodd" };

export function AuthProviderButtons({
  verb,
  redirectTo,
}: {
  verb: "in" | "up";
  redirectTo: string;
}) {
  const openExternal = bridge("openExternal");
  const { buttons, start, cancel, nonce, loading, error, desktopBrowserAuth } = useProviderSignIn({
    verb,
    redirectTo,
    pendingDeposit: api.cliAuth.pendingDeposit,
    desktop: openExternal
      ? { openExternal, deviceName: "Codecast Desktop", origin: window.location.origin }
      : null,
  });

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
      {buttons.map((p) => (
        <button
          key={p.id}
          onClick={() => start(p.id, p.label)}
          disabled={loading}
          className={BUTTON_CLASS[p.id]}
        >
          <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
            <path d={p.iconPath} fillRule={ICON_FILL_RULE[p.id]} clipRule={ICON_FILL_RULE[p.id]} />
          </svg>
          Sign {verb} with {p.label}
        </button>
      ))}
      {error && <p className="mt-3 text-sm text-red-400 text-center">{error}</p>}
      {desktopBrowserAuth && (
        <p className="mt-3 text-sm text-sol-text-dim text-center">
          Sign-in opens in your browser.
        </p>
      )}
    </>
  );
}
