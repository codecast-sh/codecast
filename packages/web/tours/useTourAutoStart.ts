// A tour starts itself the first time a person meets its feature, and never
// twice. The page that owns the feature mounts this hook with `ready` true
// once the feature is really on screen (the org tree landed, a role page
// opened, the health panel is open). It waits a beat so the tour never races
// the paint, holds the first-run turn (lib/firstRunDialogs) so it never lands
// over the device-setup dialog or the inbox tour, and stays quiet when tips
// are off, when the tour was seen on any device, or when another tour runs.
import { useFirstRunDialog } from "../lib/firstRunDialogs";
import { hasOpenModal } from "../shortcuts";
import { useInboxStore, useTrackedStore } from "../store/inboxStore";
import { useWatchEffect } from "../hooks/useWatchEffect";
import { startTour } from "./engine";
import { tourById } from "./registry";
import { isTourSeen } from "./seen";

const BEAT_MS = 1200;

export function useTourAutoStart(id: string, ready: boolean, opts: { insideModal?: boolean } = {}): void {
  const def = tourById(id);
  const s = useTrackedStore([
    (st) => st.tour?.id ?? null,
    (st) => st.clientStateInitialized,
    (st) => (def ? isTourSeen(def, st.clientState) : true),
    (st) => st.clientState.tips?.level === "none",
  ]);
  const runningId = s.tour?.id ?? null;
  const initialized = s.clientStateInitialized;
  const seen = def ? isTourSeen(def, s.clientState) : true;
  const off = s.clientState.tips?.level === "none";
  const { blocked, claim } = useFirstRunDialog(`tour:${id}`, runningId === id);
  const insideModal = !!opts.insideModal;

  useWatchEffect(() => {
    if (!def || !ready || runningId || blocked || !initialized || seen || off) return;
    let t: ReturnType<typeof setTimeout>;
    const arm = () => {
      t = setTimeout(() => {
        // A modal the person has up keeps its turn; the beat repeats until
        // the screen is clear. A tour that teaches a dialog skips the check.
        if (!insideModal && hasOpenModal()) arm();
        else if (!useInboxStore.getState().tour && claim()) startTour(id);
      }, BEAT_MS);
    };
    arm();
    return () => clearTimeout(t);
  }, [def, id, ready, runningId, blocked, initialized, seen, off, insideModal, claim]);
}
