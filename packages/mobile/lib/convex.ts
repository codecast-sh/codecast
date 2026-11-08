import { isVideoSrc, MEDIA_ORIGIN } from "@codecast/shared/contracts/castPlayer";
import { ConvexReactClient } from "convex/react";
import { countingWebSocket } from "./socketStats";
import { STORE_SHOTS } from "./storeShots/flag";

// Fall back to production, never to "": build 28 shipped with a stale
// EXPO_PUBLIC_CONVEX_URL (the pre-migration Convex Cloud deployment) and every
// sign-in method errored under App Store review. Local/dev flows always set
// the env var, so the fallback only engages when a build would otherwise be
// pointed at nothing.
export const CONVEX_URL = process.env.EXPO_PUBLIC_CONVEX_URL || "https://convex.codecast.sh";

// Origin of CONVEX_URL, derived by regex — `new URL` is a Hermes trap.
export const CONVEX_ORIGIN = CONVEX_URL.replace(/^(https?:\/\/[^/?#]+).*$/i, "$1").toLowerCase();

/** True when an image src reaches no third party: a data: URI or an absolute
 *  URL on our own Convex storage origin (pasted transcript images, `cast image`
 *  uploads). Mirrors web's trustedImageOrigins policy; shared by the markdown
 *  renderer and the CastCanvas WebView sanitizer. */
export function isTrustedImageSrc(src: string): boolean {
  if (src.startsWith("data:")) return true;
  const m = /^(https?:\/\/[^/?#]+)(?:[/?#]|$)/i.exec(src);
  return !!m && m[1].toLowerCase() === CONVEX_ORIGIN;
}

/** A video a message may play without a tap to trust it: an upload in our own
 *  storage or on our media host (`cast image clip.mp4`). */
export function isTrustedVideoSrc(src: string): boolean {
  if (!isVideoSrc(src)) return false;
  const m = /^(https?:\/\/[^/?#]+)(?:[/?#]|$)/i.exec(src);
  const origin = m?.[1].toLowerCase();
  return origin === CONVEX_ORIGIN || origin === MEDIA_ORIGIN;
}

// Store shots mode (lib/storeShots/flag) swaps in an offline stub: the app
// renders the fixture world and no socket opens.
export const convex: ConvexReactClient = STORE_SHOTS
  ? require("./storeShots/convexStub").storeShotsConvex
  : new ConvexReactClient(CONVEX_URL, {
      unsavedChangesWarning: false,
      webSocketConstructor: countingWebSocket(),
    });
