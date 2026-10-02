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
import { RoleAvatar } from "./avatars";
import { RisingCard } from "../RisingCard";
import { ORG_INTRO_HEAD_OF_PEOPLE } from "../../lib/orgIntro";
import { ORG_MEET_TITLE, ORG_MEET_LINES } from "../../lib/orgIntroCard";

// ---------------------------------------------------------------- the card

export function OrgIntroCard({ onSee, onDismiss }: { onSee: () => void; onDismiss: () => void }) {
  return (
    <RisingCard
      face={<RoleAvatar avatar={ORG_INTRO_HEAD_OF_PEOPLE} size={46} />}
      title={ORG_MEET_TITLE}
      lines={ORG_MEET_LINES}
      primaryLabel="See it"
      onPrimary={onSee}
      laterLabel="Not now"
      onLater={onDismiss}
      data-org-meet
    />
  );
}
