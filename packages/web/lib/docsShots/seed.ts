// Seeds the docs shots window (./flag) with the Acme world as a settled
// account sees it: every tour finished and every nudge answered, so
// no first-run surface covers the screen. Seeds again if anything clears the
// store (a principal change clears protected memory).
import { useInboxStore } from "../../store/inboxStore";
import { settleFreshHomeLaunch } from "../../store/viewNav";
import { TOURS } from "../../tours/registry";
import { tourSeenId } from "../../tours/seen";
import { SNIPPET_CATALOG } from "@codecast/shared/contracts";
import { snippetIntroKey } from "../newSnippets";
import { placeAcmeInbox, seedAcmeWorld } from "../acmeWorld/seed";

export function seedDocsShots(ui: Record<string, unknown>) {
  const extra = {
    tips: { completed: TOURS.map((t) => tourSeenId(t.id)), seen: [], dismissed: [] },
    dismissed: {
      desktop_app: true,
      ios_app: true,
      has_used_desktop: true,
      notif_nudge: Date.now(),
      ...Object.fromEntries(SNIPPET_CATALOG.map((s) => [snippetIntroKey(s.slug), true])),
    },
  };
  const seed = () => seedAcmeWorld({ now: Date.now(), ui: { org_upsell_seen: true, ...ui }, extra });
  seed();
  // Hydration settles a fresh launch (it opens the new-session page when it
  // has nowhere to restore to); with persistence off, nothing hydrates.
  settleFreshHomeLaunch();
  // The probe a capture step or a person at the console tunes the world with.
  (window as any).__docsShots = { seed, place: placeAcmeInbox, ready: true };
  useInboxStore.subscribe((s, prev) => {
    if (s.currentUser == null && prev.currentUser != null) queueMicrotask(seed);
  });
}
