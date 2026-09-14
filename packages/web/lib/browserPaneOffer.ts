// The rule behind the chip: when an agent's pane offer is worth showing, what
// it is called, and whether this window may open it without being asked.
//
// Pure so the chip, the inbox card and the tests all read the same answers —
// and so the one judgement call in the feature (may a preference open a pane on
// the reader's behalf?) is written once, in a place a test can pin.

import { PANE_OFFER_TTL_MS, normalizePaneUrl, type BrowserPaneOffer } from "@codecast/shared/contracts/browserPaneOffer";
import { displayHost, isLoopbackUrl } from "./browserPane";

export type PaneOfferDecision = {
  /** Show the chip at all. */
  show: boolean;
  /** Open the pane without a click, because the reader asked for that. */
  autoOpen: boolean;
};

export function paneOfferDecision(input: {
  offer: BrowserPaneOffer | null | undefined;
  now: number;
  /** This conversation is the one the reader is attending (currentSessionId). */
  attended: boolean;
  /** The `auto_open_browser_panes` preference. */
  autoOpen: boolean;
  /** The stage can take another pane (lib/stage canOpenBeside). */
  hasRoom: boolean;
}): PaneOfferDecision {
  const { offer, now } = input;
  // Handled already — opened or dismissed, here or on another device.
  if (!offer || offer.opened_at) return { show: false, autoOpen: false };
  // A day-old offer names a dev server that died with the session. Going quiet
  // beats a chip that is always there and never worth clicking.
  if (now - offer.offered_at > PANE_OFFER_TTL_MS) return { show: false, autoOpen: false };
  return {
    show: true,
    // Auto-open is deliberately narrow. It fires only where the reader is
    // already looking, only on a stage with room, and only because they turned
    // it on: a pane appearing beside a conversation nobody is reading is the
    // machine moving the view, which is exactly what the view-motion guard
    // (store/viewNav.ts) exists to prevent.
    autoOpen: input.autoOpen && input.attended && input.hasRoom,
  };
}

/** What the chip says: what the agent called the page, else its host. */
export function paneOfferLabel(offer: BrowserPaneOffer): string {
  return offer.title?.trim() || displayHost(offer.url);
}

/**
 * The chip's tooltip. A loopback address is only answered by the machine the
 * agent ran on, so a reader on another laptop is told whose localhost this is
 * before they click — the pane still opens, and its own offline state finishes
 * the story.
 */
export function paneOfferHint(offer: BrowserPaneOffer, machine: string | null): string {
  const where = isLoopbackUrl(offer.url) && machine ? ` — served by ${machine}` : "";
  return `Open ${offer.url} beside this conversation${where}`;
}

/**
 * Whether a session may drive a pane. The route carries `s=<session>` as a
 * hint, and a hint is all it is: a hand-typed or pasted link could name any
 * session at all. Ownership is stamped from the store, not the URL — the named
 * session must be the one this conversation row belongs to, and that row must
 * hold an offer for this very address that the reader has not already handled.
 * Anything short of that is "no owner": the pane still opens, and no `cast
 * browser` gets to drive it. The offer is compared by normalized address so a
 * trailing slash or a stray `#` cannot separate the chip's click from its
 * offer.
 */
export function paneOfferOwner(input: {
  /** The `s=` hint from the route, if any. */
  hinted: string | undefined;
  /** The pane's address. */
  url: string;
  /** The conversation rows the store holds for that session id, in either
   *  collection: `session_id` and `browser_pane_offer` are the fields read. */
  rows: Array<{ session_id?: string | null; browser_pane_offer?: BrowserPaneOffer | null } | undefined>;
  now: number;
}): string | undefined {
  const { hinted, url, rows, now } = input;
  if (!hinted) return undefined;
  const want = normalizePaneUrl(url);
  if (!want) return undefined;
  for (const row of rows) {
    if (!row || row.session_id !== hinted) continue;
    const offer = row.browser_pane_offer;
    if (!offer || offer.opened_at !== undefined) continue;
    if (now - offer.offered_at > PANE_OFFER_TTL_MS) continue;
    if (normalizePaneUrl(offer.url) === want) return hinted;
  }
  return undefined;
}
