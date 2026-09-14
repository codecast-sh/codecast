"use client";

// "The agent found you a page." `cast browser pane <url>` writes one offer onto
// the session; this is where the reader meets it — a chip beside the session
// title that opens the page in a pane next to the conversation, and a small
// globe on the inbox card so an unread session says it has one waiting.
//
// The reader is the one who opens it. An agent writing data must never move
// what a person is looking at (store/viewNav.ts holds the same line for
// navigation), so the chip waits for a click. The one exception is a preference
// the reader turned on themselves, and even that fires only in the conversation
// they are already reading — see lib/browserPaneOffer.

import { useCallback, useEffect } from "react";
import { Globe, X } from "lucide-react";
import { api } from "@codecast/convex/convex/_generated/api";
import { deviceDisplayName, type BrowserPaneOffer } from "@codecast/shared/contracts";
import { useInboxStore } from "../../store/inboxStore";
import { useQueryNoThrow } from "../../hooks/useQueryNoThrow";
import { canOpenBeside, openBrowserPane } from "../../lib/stage";
import { isLoopbackUrl } from "../../lib/browserPane";
import { paneOfferDecision, paneOfferHint, paneOfferLabel } from "../../lib/browserPaneOffer";

/** The offer this conversation is carrying, from whichever row holds it: the
 *  meta row once the session has been opened, the inbox row before that. */
function usePaneOffer(conversationId: string): BrowserPaneOffer | null {
  return useInboxStore((s) => {
    const row: any = s.conversations[conversationId] ?? s.sessions[conversationId];
    return (row?.browser_pane_offer as BrowserPaneOffer | null | undefined) ?? null;
  });
}

/**
 * The header chip. Renders nothing at all for the great majority of sessions,
 * which is why it subscribes to one field rather than the row.
 */
export function BrowserPaneOfferChip({ conversationId }: { conversationId: string }) {
  const offer = usePaneOffer(conversationId);
  const attended = useInboxStore((s) => s.currentSessionId === conversationId);
  const autoOpenPref = useInboxStore((s) => s.clientState.ui?.auto_open_browser_panes === true);
  const dismiss = useInboxStore((s) => s.dismissBrowserPaneOffer);

  // Only a loopback address needs a machine name, so only a loopback address
  // pays for the lookup. Enrichment, so it degrades to "no name" rather than
  // taking the header down with it when the query is missing from the
  // deployment (the header-outage rule in the root CLAUDE.md).
  const loopback = !!offer && isLoopbackUrl(offer.url);
  const machineQuery = useQueryNoThrow(
    api.devices.getConversationMachine,
    loopback ? ({ conversation_id: conversationId as any } as any) : "skip",
  );
  const machine = machineQuery.data ? deviceDisplayName(machineQuery.data as any) : null;

  const decision = paneOfferDecision({
    offer,
    now: Date.now(),
    attended,
    autoOpen: autoOpenPref,
    hasRoom: canOpenBeside(),
  });

  const open = useCallback(() => {
    if (!offer) return;
    openBrowserPane({ kind: "url", url: offer.url });
    dismiss(conversationId, Date.now());
  }, [offer?.url, conversationId, dismiss]);

  // The preference, honoured once per offer: dismissing it as we open is what
  // keeps a re-render or a second window from opening the same pane twice.
  useEffect(() => {
    if (decision.autoOpen) open();
  }, [decision.autoOpen, open]);

  if (!decision.show || !offer) return null;

  return (
    <span className="inline-flex items-center flex-shrink-0 rounded border border-sol-cyan/30 bg-sol-cyan/10 text-[10px] font-mono text-sol-cyan overflow-hidden">
      <button
        type="button"
        onClick={open}
        className="inline-flex items-center gap-1 px-1.5 py-px hover:bg-sol-cyan/20 transition-colors max-w-[16rem]"
        title={paneOfferHint(offer, machine)}
      >
        <Globe className="w-3 h-3 flex-shrink-0" />
        <span className="truncate">{paneOfferLabel(offer)}</span>
        <span className="opacity-70 flex-shrink-0">open beside</span>
      </button>
      <button
        type="button"
        onClick={() => dismiss(conversationId, Date.now())}
        className="px-1 py-px text-sol-cyan/60 hover:text-sol-cyan hover:bg-sol-cyan/20 transition-colors"
        title="Dismiss — the agent's offer, not opened"
        aria-label="Dismiss the pane offer"
      >
        <X className="w-2.5 h-2.5" />
      </button>
    </span>
  );
}

/**
 * The inbox card's version: the same fact, one glyph wide. It renders from the
 * row the card already holds, so a list of 300 cards adds no subscriptions.
 */
export function BrowserPaneOfferGlyph({ offer }: { offer: BrowserPaneOffer | null | undefined }) {
  const decision = paneOfferDecision({
    offer,
    now: Date.now(),
    attended: false,
    autoOpen: false,
    hasRoom: false,
  });
  if (!decision.show || !offer) return null;
  return (
    <Globe
      className="w-2.5 h-2.5 text-sol-cyan flex-shrink-0"
      aria-label="A page is waiting to open as a pane"
    />
  );
}
