import { DEFAULT_OAUTH_PROVIDERS, useProviderSignIn, type OAuthProviderId, type ProviderButton } from "@platform/auth/web";
import { api } from "@codecast/convex/convex/_generated/api";
import { useQueryNoThrow } from "../hooks/useQueryNoThrow";
import { bridge } from "../lib/desktop";
import { markOAuthStarted } from "../lib/oauthReturn";
import { slackProviderRedirect } from "../lib/slackReturn";

// Provider sign-in buttons, shared by /login and /signup: Apple and GitHub
// always, Google when the deployment has its OAuth client (auth.signInProviders).
// Until that answer arrives, or on a backend that predates it, Google stays
// hidden rather than offering a button the server would refuse.
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
  // Google's light button: white fill, gray stroke, near-black label.
  google:
    "w-full py-3 px-4 bg-white hover:bg-gray-50 disabled:bg-white/50 disabled:cursor-not-allowed text-[#1f1f1f] font-medium rounded-lg border border-[#747775] transition-colors focus:outline-none focus:ring-2 focus:ring-amber-500 focus:ring-offset-2 focus:ring-offset-sol-bg flex items-center justify-center gap-2",
  apple:
    "w-full py-3 px-4 bg-white hover:bg-gray-100 disabled:bg-white/50 disabled:cursor-not-allowed text-black font-medium rounded-lg transition-colors focus:outline-none focus:ring-2 focus:ring-amber-500 focus:ring-offset-2 focus:ring-offset-sol-bg flex items-center justify-center gap-2",
  github:
    "w-full py-3 px-4 bg-[#24292e] hover:bg-[#1a1e22] disabled:bg-[#24292e]/50 disabled:cursor-not-allowed text-white font-medium rounded-lg transition-colors focus:outline-none focus:ring-2 focus:ring-amber-500 focus:ring-offset-2 focus:ring-offset-sol-bg flex items-center justify-center gap-2",
};

const ICON_FILL_RULE: Partial<Record<OAuthProviderId, "evenodd">> = { github: "evenodd" };

/** A provider's mark, as its sign-in button shows it (also the lane's
 *  "Connect Google" button). */
export function ProviderGlyph({ button, className = "w-5 h-5" }: { button: ProviderButton; className?: string }) {
  return (
    <svg className={className} fill="currentColor" viewBox="0 0 24 24" aria-hidden>
      {button.iconParts ? (
        button.iconParts.map((part) => <path key={part.fill} d={part.d} fill={part.fill} />)
      ) : (
        <path d={button.iconPath} fillRule={ICON_FILL_RULE[button.id]} clipRule={ICON_FILL_RULE[button.id]} />
      )}
    </svg>
  );
}

export function AuthProviderButtons({
  verb,
  redirectTo,
  classFor,
  listClassName = "flex flex-col gap-3",
}: {
  verb: "in" | "up";
  redirectTo: string;
  /** A surface with its own look (the simple lane's /welcome) styles each
   *  button itself; `index` is its place in the list, Google first when offered. */
  classFor?: (id: OAuthProviderId, index: number) => string;
  listClassName?: string;
}) {
  const openExternal = bridge("openExternal");
  const offered = useQueryNoThrow(api.auth.signInProviders, {}).data;
  const { buttons, start, cancel, nonce, loading, error, desktopBrowserAuth } = useProviderSignIn({
    verb,
    redirectTo: slackProviderRedirect(redirectTo),
    pendingDeposit: api.cliAuth.pendingDeposit,
    desktop: openExternal
      ? { openExternal, deviceName: "Codecast Desktop", origin: window.location.origin }
      : null,
    providers: offered?.google ? ["google", ...DEFAULT_OAUTH_PROVIDERS] : DEFAULT_OAUTH_PROVIDERS,
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
      <div className={listClassName}>
        {buttons.map((p, i) => (
          <button
            key={p.id}
            type="button"
            onClick={() => {
              markOAuthStarted();
              void start(p.id, p.label);
            }}
            disabled={loading}
            className={classFor ? classFor(p.id, i) : BUTTON_CLASS[p.id]}
            data-provider={p.id}
          >
            <ProviderGlyph button={p} />
            Sign {verb} with {p.label}
          </button>
        ))}
      </div>
      {error && <p className="mt-3 text-sm text-red-400 text-center">{error}</p>}
      {desktopBrowserAuth && (
        <p className="mt-3 text-sm text-sol-text-dim text-center">
          Sign-in opens in your browser.
        </p>
      )}
    </>
  );
}
