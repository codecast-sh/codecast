import { toast } from "sonner";
import { RefreshCw } from "lucide-react";
import { RisingCard } from "../components/RisingCard";

// What a running window shows when the service worker reports a new deploy.
//
// Every deploy is applied silently: boot's onNeedReload reloads the window the
// next time it is hidden (lib/reloadWhenHidden). A window that never hides (a desktop main
// window on its own screen) would otherwise run the old bundle for days, so
// two cases also raise a card asking the person to reload:
//
//  - release: the deploy bumped release-prompt.json's generation past this
//    bundle's (scripts/release-prompt.ts). Later dismisses that generation for
//    good, in every window.
//  - stale: an update has been waiting in this window for a day. Later snoozes
//    it for another day.
//
// Routine deploys therefore never interrupt anyone; the card is reserved for
// releases someone chose to announce and for windows left far behind.

export const STALE_PROMPT_AFTER_MS = 24 * 60 * 60 * 1000;
const RECHECK_MS = 60 * 60 * 1000;
const DISMISSED_KEY = "codecast:update-prompt:dismissed-generation";
const SNOOZED_KEY = "codecast:update-prompt:stale-snoozed-until";
const TOAST_ID = "update-prompt";

export type UpdatePromptFacts = {
  bakedGeneration: number;
  servedGeneration: number;
  dismissedGeneration: number;
  updateWaitingSince: number;
  staleSnoozedUntil: number;
  now: number;
};

export function updatePromptKind(f: UpdatePromptFacts): "release" | "stale" | null {
  if (f.servedGeneration > f.bakedGeneration && f.servedGeneration > f.dismissedGeneration) return "release";
  if (f.now - f.updateWaitingSince >= STALE_PROMPT_AFTER_MS && f.now >= f.staleSnoozedUntil) return "stale";
  return null;
}

type Served = { promptGeneration?: number; promptMessage?: string };

async function fetchServed(): Promise<Served | null> {
  try {
    const res = await fetch(`/version.json?t=${Date.now()}`, { cache: "no-store" });
    return res.ok ? ((await res.json()) as Served) : null;
  } catch {
    return null;
  }
}

function readNumber(key: string): number {
  try { return Number(localStorage.getItem(key)) || 0; } catch { return 0; }
}

function writeNumber(key: string, value: number) {
  try { localStorage.setItem(key, String(value)); } catch {}
}

export function showUpdatePrompt(kind: "release" | "stale", served: Served, onClose?: () => void) {
  const generation = served.promptGeneration ?? 0;
  const later = () => {
    onClose?.();
    if (kind === "release") writeNumber(DISMISSED_KEY, Math.max(generation, readNumber(DISMISSED_KEY)));
    else writeNumber(SNOOZED_KEY, Date.now() + STALE_PROMPT_AFTER_MS);
  };
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
        onLater={() => { later(); toast.dismiss(id); }}
        accent="var(--sol-cyan)"
        data-update-prompt={kind}
      />
    ),
    { id: TOAST_ID, duration: Infinity, onDismiss: later },
  );
}

// Per window: when the first update arrived, and whether the card is up.
let waitingSince: number | null = null;
let shown = false;

async function evaluate() {
  if (shown || waitingSince === null) return;
  const served = await fetchServed();
  if (!served || shown) return;
  const kind = updatePromptKind({
    bakedGeneration: __CODECAST_BUILD__.promptGeneration ?? 0,
    servedGeneration: served.promptGeneration ?? 0,
    dismissedGeneration: readNumber(DISMISSED_KEY),
    updateWaitingSince: waitingSince,
    staleSnoozedUntil: readNumber(SNOOZED_KEY),
    now: Date.now(),
  });
  if (!kind) return;
  shown = true;
  showUpdatePrompt(kind, served, () => { shown = false; });
}

/** Called (lazily, from boot's onNeedReload) each time a new deploy takes over this window. */
export function noteUpdateWaiting() {
  if (waitingSince === null) {
    waitingSince = Date.now();
    window.setInterval(() => void evaluate(), RECHECK_MS);
  }
  void evaluate();
}

// Dev console hook (the meeting offer's convention): __showUpdatePrompt("release", "Fixes the crash on deleted sessions.")
if (process.env.NODE_ENV !== "production" && typeof window !== "undefined")
  (window as any).__showUpdatePrompt = (kind: "release" | "stale" = "release", message = "") =>
    showUpdatePrompt(kind, { promptGeneration: 0, promptMessage: message });
