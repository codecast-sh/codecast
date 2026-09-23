// The native apps codecast ships beyond the browser, and which one a given
// device should be offered. Every upsell surface (the banner, the sidebar
// footer, the user menu, Settings > Apps, the marketing badges) reads this
// one module, so a phone is never offered the Mac app and the links, copy and
// analytics for each app are declared once.

import { SITE_LINKS } from "./siteLinks";
import { isDesktopShell } from "./desktop";
import { track } from "./analytics";
import type { ClientDismissed } from "../store/inboxStore";

export type NativeApp = "mac" | "ios";

export const NATIVE_APP_LINKS: Record<NativeApp, string> = {
  // The web server 302s this to the pinned dmg on dl.codecast.sh.
  mac: "https://codecast.sh/download/mac",
  ios: SITE_LINKS.appStore,
};

export const NATIVE_APP_COPY: Record<
  NativeApp,
  { name: string; requires: string; pitch: string; cta: string; nudge: string }
> = {
  mac: {
    name: "Codecast for Mac",
    requires: "macOS on Apple Silicon",
    pitch: "Native notifications, a menu bar presence, global shortcuts, and meeting detection.",
    cta: "Download for macOS",
    nudge: "Get the desktop app for a faster, native experience",
  },
  ios: {
    name: "Codecast for iPhone and iPad",
    requires: "iOS 17 or later",
    pitch: "A push when an agent needs you. Read, reply and approve from anywhere.",
    cta: "Get it on the App Store",
    nudge: "Codecast is on the App Store: get a push when an agent needs you",
  },
};

/** The client-state key that records a user closing this app's nudge. */
export const NATIVE_APP_DISMISS_KEY: Record<NativeApp, keyof ClientDismissed> = {
  mac: "desktop_app",
  ios: "ios_app",
};

export type PlatformFacts = {
  userAgent: string;
  platform: string;
  maxTouchPoints: number;
};

export function readPlatformFacts(): PlatformFacts | null {
  if (typeof navigator === "undefined") return null;
  return {
    userAgent: navigator.userAgent ?? "",
    platform: navigator.platform ?? "",
    maxTouchPoints: navigator.maxTouchPoints ?? 0,
  };
}

/**
 * Which native app fits the device this page runs on: iOS on an iPhone or
 * iPad, the desktop app in a Mac browser, nothing on Windows, Linux or
 * Android and nothing inside either app. iPadOS reports itself as a Mac, so a
 * Mac with more than one touch point is an iPad.
 */
export function nativeAppFor(facts: PlatformFacts | null, inDesktopShell: boolean): NativeApp | null {
  if (!facts || inDesktopShell) return null;
  if (/iPhone|iPad|iPod/.test(facts.userAgent)) return "ios";
  if (/Mac/.test(facts.platform) || /Macintosh/.test(facts.userAgent)) {
    return facts.maxTouchPoints > 1 ? "ios" : "mac";
  }
  return null;
}

export function nativeAppOffer(): NativeApp | null {
  return nativeAppFor(readPlatformFacts(), isDesktopShell());
}

/** One analytics call per app, so every surface reports into the same funnel. */
export function trackNativeAppClick(app: NativeApp, location: string): void {
  track(app === "mac" ? "desktop_download_clicked" : "ios_app_clicked", { location });
}
