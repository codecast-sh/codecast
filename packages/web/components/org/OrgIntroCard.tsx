"use client";
// The introduction anywhere (docs/architecture/org-staffing.md S20). Once per
// person, on the next visit to any page, a card rises from the bottom right
// corner: one face, "Meet your organization", two lines and two actions. See
// it opens the org page, where the first visit (OrgIntro) does the real
// introducing; Not now closes it. Either answer, and seeing the org page by
// any route, writes org_upsell_seen through the store, so a person who found
// the feature on their own is never sold it afterwards.
//
// The card rides the app's toast (sonner, bottom right), the same rising card
// the meeting offer uses (components/calls/MeetingOfferToast), so the rise,
// the stack and the swipe to dismiss are the app's own and not a third
// primitive. Its look is in globals.css under "org-meet".
//
// When it rises is a pure question of facts (orgIntroCardMayRise): the store
// has hydrated so the pref is trustworthy, there is a signed in person, the
// page is not the org page, the window is wider than a phone, no call is
// running, no composer on the page holds text, and neither pref is set.
// OrgIntroAnywhere asks that question once the page has settled, and again
// on every route change until the card has risen once in this load.
import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { toast } from "sonner";
import { useInboxStore, useTrackedStore } from "../../store/inboxStore";
import { useIsPhone } from "../../hooks/useIsPhone";
import { RoleAvatar } from "./avatars";
import { OrgButton } from "./OrgButton";
import { ORG_INTRO_CHIEF, ORG_INTRO_TITLE, markOrgUpsellSeen } from "./OrgIntro";
import { useMountEffect } from "../../hooks/useMountEffect";

export const ORG_MEET_TOAST_ID = "org-meet";

export const ORG_MEET_TITLE = ORG_INTRO_TITLE;
export const ORG_MEET_LINES: readonly [string, string] = [
  "A chief of staff reads your workspace and proposes the roles it needs.",
  "Each role watches one area and brings you only what needs you.",
];

/** How long the page gets to settle before the card rises. */
export const ORG_MEET_SETTLE_MS = 1800;

/** Space between the card's foot and the composer's top edge. */
export const ORG_MEET_COMPOSER_GAP = 12;

/** How far the card must rise so its foot clears a composer on screen: a
 *  person must be able to send without dismissing it. Measured from the
 *  conversation composer's box and the toast's own distance from the bottom
 *  of the window; zero when no composer is on screen or it already clears. */
export function composerLift(doc: Document, viewportHeight: number, toastBottomOffset = 32): number {
  // The sticky wrapper holds the summary bar and a gap above the composer
  // itself; the form is the box a hand reaches for.
  const wrap = doc.querySelector<HTMLElement>("[data-sv-composer]");
  const composer = wrap?.querySelector<HTMLElement>("form") ?? wrap;
  if (!composer) return 0;
  const r = composer.getBoundingClientRect();
  if (r.height === 0 || r.top >= viewportHeight) return 0;
  return Math.max(0, viewportHeight - toastBottomOffset - (r.top - ORG_MEET_COMPOSER_GAP));
}

/** The lift, kept current while the card is up: the composer comes and goes
 *  with the route and moves with the window. It moves the toast's own
 *  wrapper (the app paints that wrapper's background), so the whole card
 *  rises and nothing blank is left under it. */
function useComposerLift(ref: React.RefObject<HTMLDivElement | null>): number {
  const [lift, setLift] = useState(0);
  useMountEffect(() => {
    const measure = () => setLift(composerLift(document, window.innerHeight));
    measure();
    const id = window.setInterval(measure, 500);
    window.addEventListener("resize", measure);
    return () => { window.clearInterval(id); window.removeEventListener("resize", measure); };
  });
  // eslint-disable-next-line no-restricted-syntax -- writes the row's margin to match the measured lift, and clears it on the way out
  useEffect(() => {
    const li = ref.current?.closest("li");
    if (!li) return;
    li.style.marginBottom = lift ? `${lift}px` : "";
    return () => { li.style.marginBottom = ""; };
  }, [ref, lift]);
  return lift;
}

// ---------------------------------------------------------------- the gate

export type OrgIntroCardFacts = {
  /** clientState has hydrated, so the prefs below are the person's, not the
   *  boot default. Before that, every pref reads unset. */
  initialized: boolean;
  signedIn: boolean;
  onOrgPage: boolean;
  phone: boolean;
  /** The store's call phase; anything but idle is a call in some stage. */
  callPhase: string;
  /** A composer on the page holds text. */
  composerHasText: boolean;
  introSeen: boolean;
  upsellSeen: boolean;
};

export function orgIntroCardMayRise(f: OrgIntroCardFacts): boolean {
  if (!f.initialized || !f.signedIn) return false;
  if (f.onOrgPage || f.phone) return false;
  if (f.callPhase !== "idle") return false;
  if (f.composerHasText) return false;
  if (f.introSeen || f.upsellSeen) return false;
  return true;
}

/** Any composer on the page with something typed in it: the conversation
 *  composer, a doc's comment box, the chat line. Read from the DOM at rise
 *  time because each keeps its draft under its own key. */
export function composerHasText(doc: Document = document): boolean {
  for (const el of doc.querySelectorAll<HTMLTextAreaElement | HTMLInputElement>("textarea, input[type=text]")) {
    if (el.value.trim()) return true;
  }
  for (const el of doc.querySelectorAll<HTMLElement>("[contenteditable=true], [contenteditable=''], [contenteditable=plaintext-only]")) {
    if ((el.textContent ?? "").trim()) return true;
  }
  return false;
}

// ---------------------------------------------------------------- the card

export function OrgIntroCard({ onSee, onDismiss }: { onSee: () => void; onDismiss: () => void }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const lift = useComposerLift(ref);
  return (
    <div ref={ref} className="org-meet" role="status" data-org-meet data-org-meet-lift={lift || undefined}>
      <RoleAvatar avatar={ORG_INTRO_CHIEF} size={46} className="org-meet-face" />
      <div className="org-meet-body">
        <div className="org-meet-title">{ORG_MEET_TITLE}</div>
        {ORG_MEET_LINES.map((line) => <p key={line} className="org-meet-copy">{line}</p>)}
        <div className="org-meet-actions">
          <OrgButton primary size="sm" onClick={onSee} data-org-meet-see>See it</OrgButton>
          <button type="button" className="org-meet-later" onClick={onDismiss} data-org-meet-later>Not now</button>
        </div>
      </div>
    </div>
  );
}

/** Raise the card on the app's toast. `onAnswer` runs once whichever way it
 *  closes, including a swipe, and `onSee` when the person asks to see it. */
export function showOrgIntroCard({ onSee, onAnswer }: { onSee: () => void; onAnswer: () => void }) {
  let answered = false;
  const answer = () => { if (answered) return; answered = true; onAnswer(); };
  toast.custom(
    (id) => (
      <OrgIntroCard
        onSee={() => { answer(); toast.dismiss(id); onSee(); }}
        onDismiss={() => { answer(); toast.dismiss(id); }}
      />
    ),
    { id: ORG_MEET_TOAST_ID, duration: Infinity, onDismiss: answer },
  );
}

// ---------------------------------------------------------------- the mount

/** Mounted once in the dashboard layout. Renders nothing; raises the card
 *  when the facts allow it, after the page has settled. */
export function OrgIntroAnywhere() {
  const pathname = usePathname();
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
    if (risen.current) return;
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
  }, [initialized, signedIn, onOrgPage, phone, callPhase, introSeen, upsellSeen, pathname, router]);

  return null;
}

// Dev console hook, the meeting offer's convention: __showOrgIntroCard() raises
// the card without the gate, so the look can be checked in any state.
if (process.env.NODE_ENV !== "production" && typeof window !== "undefined")
  (window as any).__showOrgIntroCard = () => showOrgIntroCard({ onAnswer: () => {}, onSee: () => { window.location.assign("/org"); } });
