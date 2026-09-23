import { useWorkspaceFeature } from "../../lib/teamFeatures";
import { useEffect, useRef } from "react";
import { usePathname, useRouter } from "next/navigation";
import { toast } from "sonner";
import { useInboxStore, useTrackedStore } from "../../store/inboxStore";
import { useIsPhone } from "../../hooks/useIsPhone";
import { markOrgUpsellSeen } from "../../lib/orgIntro";
import { ORG_MEET_TOAST_ID, ORG_MEET_SETTLE_MS, orgIntroCardMayRise, composerHasText } from "../../lib/orgIntroCard";
import type { OrgIntroCardFacts } from "../../lib/orgIntroCard";
import { showOrgIntroCard } from "../../lib/showOrgIntroCard";

// ---------------------------------------------------------------- the mount

/** Mounted once in the dashboard layout. Renders nothing; raises the card
 *  when the facts allow it, after the page has settled. */
export function OrgIntroAnywhere() {
  const pathname = usePathname();
  // The org feature is per team, default off: no intro card for a workspace
  // that has it off.
  const orgOn = useWorkspaceFeature("org");
  const router = useRouter();
  const phone = useIsPhone();
  const s = useTrackedStore([
    (st) => st.clientStateInitialized,
    (st) => st.currentUser?._id,
    (st) => st.clientState.ui?.org_intro_seen,
    (st) => st.clientState.ui?.org_upsell_seen,
    (st) => st.call?.phase,
  ]);
  const risen = useRef(false);
  const initialized = s.clientStateInitialized;
  const signedIn = !!s.currentUser?._id;
  const introSeen = s.clientState.ui?.org_intro_seen === true;
  const upsellSeen = s.clientState.ui?.org_upsell_seen === true;
  const callPhase = s.call?.phase ?? "idle";
  const onOrgPage = pathname === "/org" || (pathname?.startsWith("/org/") ?? false);

  // Sold by another route while the card is up (the person opened the org
  // page from the sidebar, or answered on another device): the card goes.
  // eslint-disable-next-line no-restricted-syntax -- dismisses the toast when the upsell is seen
  useEffect(() => {
    if (risen.current && upsellSeen) toast.dismiss(ORG_MEET_TOAST_ID);
  }, [upsellSeen]);

  // eslint-disable-next-line no-restricted-syntax -- arms the rise timer when the facts that gate it change
  useEffect(() => {
    if (risen.current || !orgOn) return;
    const facts: OrgIntroCardFacts = { initialized, signedIn, onOrgPage, phone, callPhase, composerHasText: false, introSeen, upsellSeen };
    if (!orgIntroCardMayRise(facts)) return;
    const t = window.setTimeout(() => {
      // The page has settled; read the facts that can change without a
      // render (the call, a draft typed meanwhile) fresh from the store.
      const st = useInboxStore.getState();
      const now: OrgIntroCardFacts = {
        ...facts,
        introSeen: st.clientState.ui?.org_intro_seen === true,
        upsellSeen: st.clientState.ui?.org_upsell_seen === true,
        callPhase: st.call?.phase ?? "idle",
        composerHasText: composerHasText(),
      };
      if (risen.current || !orgIntroCardMayRise(now)) return;
      risen.current = true;
      showOrgIntroCard({
        onAnswer: () => markOrgUpsellSeen(useInboxStore.getState()),
        onSee: () => router.push("/org"),
      });
    }, ORG_MEET_SETTLE_MS);
    return () => window.clearTimeout(t);
  }, [orgOn, initialized, signedIn, onOrgPage, phone, callPhase, introSeen, upsellSeen, pathname, router]);

  return null;
}

// Dev console hook, the meeting offer's convention: __showOrgIntroCard() raises
// the card without the gate, so the look can be checked in any state.
if (process.env.NODE_ENV !== "production" && typeof window !== "undefined")
  (window as any).__showOrgIntroCard = () => showOrgIntroCard({ onAnswer: () => {}, onSee: () => { window.location.assign("/org"); } });
