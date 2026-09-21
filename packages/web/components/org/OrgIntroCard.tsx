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
import { RoleAvatar } from "./avatars";
import { OrgButton } from "./OrgButton";
import { ORG_INTRO_CHIEF } from "../../lib/orgIntro";
import { useMountEffect } from "../../hooks/useMountEffect";
import { ORG_MEET_TITLE, ORG_MEET_LINES, composerLift } from "../../lib/orgIntroCard";

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
