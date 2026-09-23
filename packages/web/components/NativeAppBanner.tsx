import { X, Monitor, Smartphone, ArrowRight } from "lucide-react";
import { useTrackedStore } from "../store/inboxStore";
import {
  NATIVE_APP_COPY,
  NATIVE_APP_DISMISS_KEY,
  NATIVE_APP_LINKS,
  nativeAppOffer,
  trackNativeAppClick,
} from "../lib/nativeApps";

/**
 * The one-line strip under the header that offers the native app for this
 * device: the iOS app on an iPhone or iPad, the desktop app in a Mac browser.
 * Gone once dismissed, and never shown inside the app it offers; the Mac
 * offer also stays away from anyone who already runs the desktop app, since
 * the open-in-desktop handoff owns that case.
 */
export function NativeAppBanner() {
  const s = useTrackedStore([
    s => s.clientStateInitialized,
    s => s.clientState.dismissed?.desktop_app,
    s => s.clientState.dismissed?.ios_app,
    s => s.clientState.dismissed?.has_used_desktop,
  ]);
  const app = nativeAppOffer();
  if (!app || !s.clientStateInitialized) return null;
  const dismissed = s.clientState.dismissed ?? {};
  if (dismissed[NATIVE_APP_DISMISS_KEY[app]]) return null;
  if (app === "mac" && dismissed.has_used_desktop) return null;

  const copy = NATIVE_APP_COPY[app];
  const Icon = app === "mac" ? Monitor : Smartphone;

  return (
    <div className="bg-gradient-to-r from-sol-cyan/10 via-sol-blue/10 to-sol-cyan/10 border-b border-sol-cyan/30">
      <div className="px-3 sm:px-4 py-2 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <Icon className="w-4 h-4 text-sol-cyan flex-shrink-0" />
          <span className="text-sm text-sol-text truncate">{copy.nudge}</span>
        </div>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          <a
            href={NATIVE_APP_LINKS[app]}
            target={app === "ios" ? "_blank" : undefined}
            rel={app === "ios" ? "noopener noreferrer" : undefined}
            onClick={() => trackNativeAppClick(app, "banner")}
            className="inline-flex items-center gap-1.5 px-3 py-1 text-xs font-medium bg-sol-cyan/20 hover:bg-sol-cyan/30 text-sol-cyan rounded transition-colors whitespace-nowrap"
          >
            {app === "mac" ? "Download" : "App Store"}
            <ArrowRight className="w-3 h-3" />
          </a>
          <button
            onClick={() => s.updateClientDismissed(NATIVE_APP_DISMISS_KEY[app], true)}
            className="p-1 text-sol-text-dim hover:text-sol-text transition-colors"
            aria-label="Dismiss"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
