import { toast } from "sonner";
import { RefreshCw } from "lucide-react";
import { createUpdatePrompt, type ServedVersion, type UpdatePromptKind } from "@platform/update-prompt";
import { RisingCard } from "../components/RisingCard";

// What a running window shows when the service worker reports a new deploy.
//
// Every deploy is applied silently: boot's onNeedReload reloads the window the
// next time it is hidden (@platform/update-prompt's serviceWorkerHooks). A
// window that never hides (a desktop main window on its own screen) would
// otherwise run the old bundle for days, so two cases also raise a card asking
// the person to reload:
//
//  - release: the deploy bumped release-prompt.json's generation past this
//    bundle's (scripts/release-prompt.ts). Later dismisses that generation for
//    good, in every window.
//  - stale: an update has been waiting in this window for a day. Later snoozes
//    it for another day.
//
// Routine deploys therefore never interrupt anyone; the card is reserved for
// releases someone chose to announce and for windows left far behind. The
// rules and the per-window loop live in @platform/update-prompt; the card is ours.

const TOAST_ID = "update-prompt";

function showCard(kind: UpdatePromptKind, served: ServedVersion, close: () => void) {
  toast.custom(
    (id) => (
      <RisingCard
        face={
          <span className="update-prompt-face">
            <RefreshCw size={20} strokeWidth={2.2} />
          </span>
        }
        title={kind === "release" ? "A new version is ready" : "Codecast has moved on"}
        lines={[
          kind === "release" && served.promptMessage
            ? served.promptMessage
            : "This window is running an older build. Reload to pick up the latest fixes; your drafts come with you.",
        ]}
        primaryLabel="Reload"
        onPrimary={() => window.location.reload()}
        laterLabel="Later"
        onLater={() => { close(); toast.dismiss(id); }}
        accent="var(--sol-cyan)"
        data-update-prompt={kind}
      />
    ),
    { id: TOAST_ID, duration: Infinity, onDismiss: close },
  );
}

const prompt = createUpdatePrompt({
  appKey: "codecast",
  bakedGeneration: __CODECAST_BUILD__.promptGeneration ?? 0,
  show: showCard,
});

/** Called (lazily, from boot's onNeedReload) each time a new deploy takes over this window. */
export const noteUpdateWaiting = prompt.noteUpdateWaiting;

// Dev console hook (the meeting offer's convention): __showUpdatePrompt("release", "Fixes the crash on deleted sessions.")
if (process.env.NODE_ENV !== "production" && typeof window !== "undefined")
  (window as any).__showUpdatePrompt = (kind: UpdatePromptKind = "release", message = "") =>
    prompt.show(kind, { promptGeneration: 0, promptMessage: message });
