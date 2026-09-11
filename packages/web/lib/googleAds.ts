// Google Ads conversion measurement for the paid search channel (ledger
// ct-41655, task ct-48703). Two halves, and both matter:
//
//   1. The account tag loads SITE WIDE. Google writes the ad click id into its
//      own cookie on the page the visitor LANDS on, so a tag that only ran on
//      the conversion page would have nothing left to attribute — the landing
//      URL and its gclid are long gone by then.
//   2. The conversion is reported at the token mint on /auth/cli, the same
//      moment the server records `cli_authed` (convex/apiTokens.ts). Reporting
//      it anywhere else would make the two counts describe different things.
//
// Both halves are inert unless VITE_GOOGLE_ADS_SEND_TO is set, so this file
// ships with no behaviour change until someone configures the id deliberately.
//
// Known and intended gap: `cli_authed` also fires with method "setup_token"
// (`cast login <token>`), which has no browser and therefore cannot be counted
// here. Ad attributable sign ins all come through this page, so the number is
// right for ads and undercounts total sign ins. Report it as the former.
import { resolveOptOut } from "@platform/analytics/catalog";

const META_ENV = (import.meta as any).env ?? {};

// One value, exactly as Google's event snippet prints it: "AW-<id>/<label>".
// Keeping it whole means the tag id and the conversion label cannot drift. Read
// on each call rather than captured at module load: Vite inlines the expression
// wherever it appears, so this costs nothing in a build, and it lets a test set
// the variable per case instead of needing a fresh module for each one.
function sendTo(): string | undefined {
  return META_ENV.VITE_GOOGLE_ADS_SEND_TO;
}

function adsId(): string | undefined {
  return sendTo()?.split("/")[0];
}

// The catalog layer stays DOM free by design and asks its caller for this
// signal, which is what @platform/analytics/web-runtime does for PostHog. Same
// three reads here, so a browser that opts out of one opts out of both.
function browserDoNotTrack(): boolean {
  if (typeof navigator === "undefined") return false;
  const nav = navigator as Navigator & { msDoNotTrack?: string };
  const win = typeof window !== "undefined" ? (window as Window & { doNotTrack?: string }) : undefined;
  return nav.doNotTrack === "1" || nav.msDoNotTrack === "1" || win?.doNotTrack === "1";
}

function measurable(): boolean {
  if (!sendTo() || !adsId()) return false;
  if (typeof window === "undefined" || typeof document === "undefined") return false;
  return !resolveOptOut({ doNotTrack: browserDoNotTrack() }).optedOut;
}

let started = false;

/** Load the account tag so Google can capture an ad click id on arrival. */
export function initGoogleAds(): void {
  if (started || !measurable()) return;
  started = true;

  const w = window as any;
  w.dataLayer = w.dataLayer || [];
  // gtag must exist before the remote script loads: calls made in between are
  // queued on dataLayer and replayed once it arrives.
  w.gtag =
    w.gtag ||
    function gtag() {
      w.dataLayer.push(arguments);
    };
  w.gtag("js", new Date());
  w.gtag("config", adsId());

  const script = document.createElement("script");
  script.async = true;
  script.src = `https://www.googletagmanager.com/gtag/js?id=${adsId()}`;
  document.head.appendChild(script);
}

/**
 * Report one completed CLI sign in. Safe to call when the tag never loaded:
 * the queue swallows it and nothing is sent.
 */
export function reportSignupConversion(): void {
  if (!measurable()) return;
  const w = window as any;
  if (typeof w.gtag !== "function") return;
  w.gtag("event", "conversion", { send_to: sendTo() });
}
