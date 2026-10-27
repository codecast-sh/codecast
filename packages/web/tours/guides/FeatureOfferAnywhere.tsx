"use client";
// The one time the app brings up a feature a team never decided on (Org,
// then Flows): a card rises in the corner, once per person per feature, with
// the guide one press away. It rides the same rising card and the same "may it
// rise now" rule as the org introduction (lib/orgIntroCard): the page has
// settled, no call, no composer holding text, not on a phone, not on the
// feature's own page. Answering either way writes `offer:<feature>` into the
// tips bag, the record every tour and tip already shares, so it never rises
// again on any device; watching the guide by any route also counts.
//
// Nothing rises for a feature that is on (the org introduction speaks then),
// for one an admin turned off, or while tips are off.
import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { toast } from "sonner";
import { workspaceFeatureState, type TeamFeatureKey } from "@codecast/shared/contracts";
import { RisingCard } from "../../components/RisingCard";
import { RoleAvatar } from "../../components/org/avatars";
import { useInboxStore, useTrackedStore } from "../../store/inboxStore";
import { useIsPhone } from "../../hooks/useIsPhone";
import { ORG_MEET_SETTLE_MS, composerHasText, orgIntroCardMayRise } from "../../lib/orgIntroCard";
import { startTour } from "../engine";
import { isTourSeen } from "../seen";
import { tourById, watchGuideLabel } from "../registry";

type Offer = { feature: TeamFeatureKey; guide: string; home: string; face: string; accent: string; title: string; lines: [string, string] };

const OFFERS: Offer[] = [
  {
    feature: "org", guide: "org-guide", home: "/org", face: "owl", accent: "var(--sol-violet)",
    title: "New: Org",
    lines: ["Roles that each own an area of work, so most questions never reach you.", "The guide shows it on an example team."],
  },
  {
    feature: "line", guide: "flows-guide", home: "/flows", face: "hedgehog", accent: "var(--sol-cyan)",
    title: "New: Flows",
    lines: ["Every change through steps your team can see, and one card for you to decide.", "The guide shows it on an example change."],
  },
];

export const offerSeenId = (feature: TeamFeatureKey) => `offer:${feature}`;

function markOffered(feature: TeamFeatureKey) {
  const st = useInboxStore.getState();
  const dismissed = st.clientState.tips?.dismissed ?? [];
  if (!dismissed.includes(offerSeenId(feature))) st.updateClientTips({ dismissed: [...dismissed, offerSeenId(feature)] });
}

/** The offer that may rise now, if any: undecided, not answered, its guide not seen. */
function pendingOffer(st: ReturnType<typeof useInboxStore.getState>): Offer | null {
  if (st.clientState.tips?.level === "none") return null;
  const dismissed = st.clientState.tips?.dismissed ?? [];
  for (const o of OFFERS) {
    if (workspaceFeatureState(st.teams || [], st.clientState.ui?.active_team_id, o.feature) !== "offer") continue;
    if (dismissed.includes(offerSeenId(o.feature))) continue;
    const def = tourById(o.guide);
    if (def && isTourSeen(def, st.clientState)) continue;
    return o;
  }
  return null;
}

/** Mounted once in the dashboard layout. Renders nothing; raises at most one card a page load. */
export function FeatureOfferAnywhere() {
  const pathname = usePathname();
  const phone = useIsPhone();
  const s = useTrackedStore([
    (st) => st.clientStateInitialized,
    (st) => st.currentUser?._id,
    (st) => st.call?.phase,
    (st) => pendingOffer(st)?.feature ?? null,
  ]);
  const risen = useRef(false);
  const offer = pendingOffer(s);

  // eslint-disable-next-line no-restricted-syntax -- arms the rise timer when the facts that gate it change
  useEffect(() => {
    if (risen.current || !offer) return;
    const facts = () => ({
      initialized: s.clientStateInitialized,
      signedIn: !!s.currentUser?._id,
      onOrgPage: !!pathname && (pathname === offer.home || pathname.startsWith(`${offer.home}/`)),
      phone,
      callPhase: useInboxStore.getState().call?.phase ?? "idle",
      composerHasText: composerHasText(),
      introSeen: false,
      upsellSeen: false,
    });
    if (!orgIntroCardMayRise({ ...facts(), composerHasText: false })) return;
    const t = window.setTimeout(() => {
      const st = useInboxStore.getState();
      const now = pendingOffer(st);
      // A tour or guide on screen keeps the corner quiet.
      if (risen.current || st.tour || now?.feature !== offer.feature || !orgIntroCardMayRise(facts())) return;
      risen.current = true;
      showOffer(offer);
    }, ORG_MEET_SETTLE_MS + 1200);
    return () => window.clearTimeout(t);
  }, [offer?.feature, s.clientStateInitialized, s.currentUser?._id, s.call?.phase, pathname, phone]);

  return null;
}

function showOffer(o: Offer, record = true) {
  const id = `feature-offer-${o.feature}`;
  let answered = false;
  const answer = () => { if (!answered) { answered = true; if (record) markOffered(o.feature); } };
  toast.custom(
    (tid) => (
      <RisingCard
        face={<RoleAvatar avatar={o.face} size={46} />}
        title={o.title}
        lines={o.lines}
        accent={o.accent}
        primaryLabel={watchGuideLabel(o.guide)}
        onPrimary={() => { answer(); toast.dismiss(tid); startTour(o.guide, { replay: true }); }}
        laterLabel="Not now"
        onLater={() => { answer(); toast.dismiss(tid); }}
        data-feature-offer={o.feature}
      />
    ),
    { id, duration: Infinity, onDismiss: answer },
  );
}

// Dev console hook, the org introduction's convention: raise a card in any state to check its look.
if (process.env.NODE_ENV !== "production" && typeof window !== "undefined")
  (window as any).__showFeatureOffer = (feature: TeamFeatureKey = "org") => { const o = OFFERS.find((x) => x.feature === feature); if (o) showOffer(o, false); };
