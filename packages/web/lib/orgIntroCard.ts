import { ORG_INTRO_TITLE } from "./orgIntro";

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
