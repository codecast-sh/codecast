import { X, Monitor, ArrowRight } from "lucide-react";
import { isDesktop } from "../lib/desktop";
import { useInboxStore } from "../store/inboxStore";

export function DesktopAppBanner() {
  const initialized = useInboxStore(s => s.clientStateInitialized);
  const dismissed = useInboxStore(s => s.clientState.dismissed?.desktop_app ?? false);
  const updateDismissed = useInboxStore(s => s.updateClientDismissed);

  if (!initialized || dismissed) return null;
  if (isDesktop()) return null;

  const isMac = typeof navigator !== "undefined" && /Mac/.test(navigator.userAgent) && !("ontouchend" in document);
  if (!isMac) return null;

  return (
    <div className="bg-gradient-to-r from-sol-cyan/10 via-sol-blue/10 to-sol-cyan/10 border-b border-sol-cyan/30">
      <div className="px-4 py-2 flex items-center justify-between gap-4">
        <div className="flex items-center gap-3 min-w-0">
          <Monitor className="w-4 h-4 text-sol-cyan flex-shrink-0" />
          <span className="text-sm text-sol-text truncate">Get the desktop app for a faster, native experience</span>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <a
            href="https://codecast.sh/download/mac"
            className="inline-flex items-center gap-1.5 px-3 py-1 text-xs font-medium bg-sol-cyan/20 hover:bg-sol-cyan/30 text-sol-cyan rounded transition-colors"
          >
            Download
            <ArrowRight className="w-3 h-3" />
          </a>
          <button
            onClick={() => updateDismissed("desktop_app", true)}
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
