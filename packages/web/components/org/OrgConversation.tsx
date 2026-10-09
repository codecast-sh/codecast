"use client";
// One conversation in the Org screen's panel (essence spec §5): a role's
// standing thread, a session opened from the canvas, or the thread a
// proposal was posted in. A conversation id in, the transcript and the
// composer out. It can land on a proposal's card (the change lit) or on the
// place a decision was asked; the landing waits for the thread's rows when
// they have not arrived yet.
import { useCallback, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useConvex } from "convex/react";
import { useInboxStore } from "../../store/inboxStore";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { useMountEffect } from "../../hooks/useMountEffect";
import { locateDecisionAsk } from "../../hooks/useJumpToDecisionAsk";
import { cssZoomOf } from "../../lib/cssZoom";
import { proposalAnswersOf } from "../../lib/reviewActions";
import { nextFrame } from "../conversationScroll";
import { AnchorConversation } from "../anchor/AnchorConversation";
import { ComposerFade } from "../ComposerFade";
import { MarkdownRenderer } from "../tools/MarkdownRenderer";
import { ReviewComposerContext, type ReviewComposer } from "../reviewContext";
import { ProposalBody } from "./ProposalCard";
import { findProposalCardMessage, type JumpRequest } from "./orgScreenModel";
import type { DecisionAt } from "./panelTarget";
import type { OrgProposalRow } from "./orgStaffingTypes";

/** The batch an answer given on a preview card joins: nothing sends it. */
export const PREVIEW_BATCH = "preview:org";

/** Room above a card's head when the thread lands on it. */
const CARD_LANDING_PAD = 12;
/** How long the landing waits for a card to draw its entries before it lands on whatever is there. */
const CARD_LANDING_WAIT_MS = 2500;
/** How long a request waits for the thread's rows before it jumps by time. */
const TAIL_WAIT_MS = 3000;
/** How long the landing started with the request waits for the card to mount. */
const CARD_MOUNT_WAIT_MS = 8000;

/** The thread has settled on the message that draws the card: the card's
 *  head goes to the top of the view, and the focused entry is centred when it
 *  sits outside the view. The card's change rows arrive from their own
 *  feeder, often after the settle, so the landing waits (a frame at a time,
 *  capped) until the card has drawn its entries and, when a focus is set, the
 *  focused entry. One write each, inside the thread's own scroller; the
 *  thread's settle treats the move as a takeover and stops. */
function landOnProposalCard(root: HTMLElement | null, shortId: string, focused: boolean, deadline = performance.now() + CARD_LANDING_WAIT_MS) {
  const card = root?.querySelector<HTMLElement>(`[data-proposal-card="${shortId}"]`);
  const scroller = card?.closest<HTMLElement>("[data-sv-feed]");
  if (!card || !scroller) { if (root?.isConnected && performance.now() < deadline) nextFrame(() => landOnProposalCard(root, shortId, focused, deadline)); return; }
  const ready = !card.querySelector("[data-proposal-loading]") && (!focused || !!card.querySelector("[data-focused]"));
  if (!ready && performance.now() < deadline) { requestAnimationFrame(() => landOnProposalCard(root, shortId, focused, deadline)); return; }
  const zoom = cssZoomOf(scroller);
  let view = scroller.getBoundingClientRect();
  scroller.scrollTop += (card.getBoundingClientRect().top - view.top) / zoom - CARD_LANDING_PAD;
  // The innermost focused element: a focused record line sits inside its focused group.
  const entry = Array.from(card.querySelectorAll<HTMLElement>("[data-focused]")).pop();
  if (!entry) return;
  view = scroller.getBoundingClientRect();
  const r = entry.getBoundingClientRect();
  if (r.top >= view.top && r.bottom <= view.bottom) return;
  scroller.scrollTop += (r.top + r.height / 2 - (view.top + view.height / 2)) / zoom;
}

export type OrgConversationProps = {
  conversationId: string;
  /** Whom the composer addresses ("Ask Cold Email lead"). */
  name?: string | null;
  /** Land on this proposal's card, its change `seq` lit. `createdAt` tells
   *  the landing whether the rows that could hold the card have arrived. */
  proposal?: { shortId: string; createdAt?: number; seq?: number } | null;
  /** Land on the place this decision was asked. */
  decision?: DecisionAt | null;
};

export function OrgConversation({ conversationId, name, proposal = null, decision = null }: OrgConversationProps) {
  // A cold open: a standing session is bucket-hidden, so the inbox never
  // seeds its row and the embed would say "Loading conversation…" until the
  // messages query answered. The same minimal row useSeedOwnership writes;
  // getConversationWithMeta merges the real one over it.
  useWatchEffect(() => {
    const st = useInboxStore.getState();
    if (!st.conversations[conversationId] && !st.sessions[conversationId]) st.syncRecord("conversations", conversationId, { _id: conversationId });
  }, [conversationId]);
  const staged = useInboxStore((s) => (s.reviewComments[conversationId]?.length ?? 0) > 0);
  const root = useRef<HTMLDivElement | null>(null);

  // -------- landing on a proposal's card: the message that draws it when it
  // is loaded, else its time (the embed finds the card in the window that lands).
  const [jump, setJump] = useState<JumpRequest | null>(null);
  const seq = useRef(0);
  const waiting = useRef<number | null>(null);
  const tailLength = useInboxStore((st) => st.messages[conversationId]?.length ?? 0);
  const stopWaiting = () => { if (waiting.current !== null) { window.clearTimeout(waiting.current); waiting.current = null; } };
  useMountEffect(() => stopWaiting);
  const land = useCallback((force: boolean) => {
    if (!proposal) return;
    const tail = useInboxStore.getState().messages[conversationId];
    const id = findProposalCardMessage(tail, proposal.shortId);
    // The rows that could hold the card are the ones after the proposal was
    // posted: until the tail reaches past that time it has not arrived yet.
    const caughtUp = !!tail?.length && (proposal.createdAt === undefined || (tail[tail.length - 1]?.timestamp ?? 0) > proposal.createdAt);
    stopWaiting();
    if (!id && !caughtUp && !force) {
      waiting.current = window.setTimeout(() => { waiting.current = null; land(true); }, TAIL_WAIT_MS);
      return;
    }
    const focused = proposal.seq !== undefined;
    const nonce = ++seq.current;
    const onSettled = () => landOnProposalCard(root.current, proposal.shortId, focused);
    setJump(id ? { messageId: id, nonce, onSettled } : proposal.createdAt !== undefined ? { timestamp: proposal.createdAt, find: proposal.shortId, nonce, onSettled } : null);
    // The landing also starts now and waits for the card to mount: in a
    // hidden tab the thread never reports settling, while the card still
    // mounts once the list scrolls near it.
    landOnProposalCard(root.current, proposal.shortId, focused, performance.now() + CARD_MOUNT_WAIT_MS);
  }, [conversationId, proposal?.shortId, proposal?.seq, proposal?.createdAt]); // eslint-disable-line react-hooks/exhaustive-deps
  useWatchEffect(() => { land(false); }, [land]);
  // Rows arriving while the landing waits: try again with them.
  useWatchEffect(() => { if (waiting.current !== null && tailLength > 0) land(false); }, [tailLength]);

  // -------- landing on a decision: the `cast decide` call's message, else its time.
  const convex = useConvex();
  useWatchEffect(() => {
    if (!decision) return;
    const nonce = ++seq.current;
    void locateDecisionAsk(convex, conversationId, decision.id, decision.question).then((at) => {
      if (seq.current === nonce) setJump(at ? { messageId: at.id, nonce } : { timestamp: decision.createdAt, nonce });
    });
  }, [conversationId, decision?.id]);

  const who = name?.trim();
  return (
    <div ref={root} className="h-full min-h-0" data-org-conversation={conversationId}>
      <AnchorConversation
        key={conversationId}
        conversationId={conversationId}
        hideHeader
        hideDiff
        seedOwnership={false}
        foldBootstrap
        foldWorkingTurns
        initialDensity="condensed"
        // The panel's bar names the thread; its own sticky last prompt would float over the cards.
        stickyPrompt={false}
        composerPlaceholder={who ? (staged ? `Ask ${who}, or send your answers as they are` : `Ask ${who}`) : undefined}
        jump={jump}
      />
    </div>
  );
}

/** The dev preview's proposal: the fixture's card as the author's bubble,
 *  answering into a batch nothing sends, with a frame where the composer
 *  would be. Never reads or writes a real record. */
export function OrgPreviewProposal({ proposal, author, onSend }: { proposal: OrgProposalRow; author: string; onSend: (proposalId: string) => void }) {
  const composer = useMemo<ReviewComposer>(() => ({ quote() {}, submit() {}, conversationId: PREVIEW_BATCH, canSend: true }), []);
  // The preview's batch is this visit's: a reload never opens on cards
  // already "Approved" by nobody in the room.
  useMountEffect(() => {
    useInboxStore.getState().clearReviewComments(PREVIEW_BATCH);
    return () => useInboxStore.getState().clearReviewComments(PREVIEW_BATCH);
  });
  const comments = useInboxStore((s) => s.reviewComments[PREVIEW_BATCH]);
  const answered = proposalAnswersOf(comments, proposal._id).length > 0;
  return (
    <div className="flex h-full min-h-0 flex-col" data-thread-preview={proposal.short_id}>
      <div className="min-h-0 flex-1 overflow-y-auto px-[22px] py-4">
        <div className="mb-1 text-[12px] font-semibold" style={{ color: "var(--sol-text)" }}>{author}</div>
        <ReviewComposerContext.Provider value={composer}>
          <ProposalBody proposal={proposal} changes={proposal.changes} open summary={<MarkdownRenderer content={proposal.summary_md ?? ""} />} />
        </ReviewComposerContext.Provider>
      </div>
      <div className="relative shrink-0">
        <ComposerFade />
        <div className="mx-3 mb-3 flex items-center gap-3 rounded-xl border px-3 py-2.5 text-[13px]" style={{ borderColor: "color-mix(in srgb, var(--sol-border) 35%, transparent)", background: "var(--sol-card)", color: "var(--sol-text-dim)" }}>
          <span className="min-w-0 flex-1">Reply to {author}</span>
          {answered && (
            <button type="button" onClick={() => { onSend(proposal._id); toast.success("Preview: nothing is sent"); }} className="shrink-0 text-[12px] font-medium hover:underline underline-offset-2" style={{ color: "var(--sol-violet)" }} data-preview-send>
              Send the answers
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
