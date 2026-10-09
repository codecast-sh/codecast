"use client";
// The org screen's left column (docs/architecture/org-staffing.md S41): the
// Head of People's standing conversation, embedded whole and live, under the
// strip of what waits on the person. The strip and the head row paint from
// the org tree at once; only the thread body waits on its loader. With no
// Head of People the column is the one home of the hire card and "Propose an
// org now"; a refused or failed tree read is said here too.
//
// The column can sit with someone else (cohesive build spec D5): the owner
// of a goal arrived at by its address, the role a person chose to talk to.
// Its head then says who that is, and a chip takes the column back to the
// Head of People.
import { useMemo, useRef, useState } from "react";
import { ArrowLeft, ExternalLink, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { useInboxStore } from "../../store/inboxStore";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { useMountEffect } from "../../hooks/useMountEffect";
import { agoOf } from "../../lib/threadState";
import { cn } from "../../lib/utils";
import { proposalAnswersOf } from "../../lib/reviewActions";
import { AnchorConversation, CenteredNote, HireHeadOfPeopleCard } from "../anchor/AnchorConversation";
import { ComposerFade } from "../ComposerFade";
import { MarkdownRenderer } from "../tools/MarkdownRenderer";
import { ReviewComposerContext, type ReviewComposer } from "../reviewContext";
import { ReviewEndedLine, ReviewSessionLink } from "./healthParts";
import { ProposalBody } from "./ProposalCard";
import { RoleFace } from "./RoleFace";
import { RolePausedNote } from "./RolePausedNote";
import { OrgReadStateBlock } from "./OrgReadStateBlock";
import type { JumpRequest } from "./orgScreenModel";
import type { OrgTreeReadState } from "./orgReadState";
import type { OrgProposalRow } from "./orgStaffingTypes";
import type { OrgRole, OrgTree } from "./orgTypes";
import type { Seat } from "./company/objects";
import { ORG_BAND, ORG_GUTTER, ORG_RULE } from "./orgFrame";
import { headCaption } from "./orgMeta";

/** The batch an answer given on a preview card joins: nothing sends it. */
export const PREVIEW_BATCH = "preview:org";

export type OrgConversationState = "refused" | "error" | "loading" | "no-head" | "not-started" | "preview" | "live";

export type OrgConversationProps = {
  tree: OrgTree | null;
  head: OrgRole | null;
  conversationId: string | null;
  readState: OrgTreeReadState;
  onRetry: () => void;
  reviewing: boolean;
  reviewEnded: boolean;
  reviewSessionId: string | null;
  onProposeNow: () => void;
  jump: JumpRequest | null;
  /** Answers wait in this conversation's batch: the placeholder says they go with the next message. */
  answersStaged: boolean;
  onOpenSession: (id: string) => void;
  onResume: (roleId: string) => void;
  strip: React.ReactNode;
  preview: null | { proposals: OrgProposalRow[]; onSend: (proposalId: string) => void; current: string | null };
  /** Someone other than the Head of People sits in the column (D5). */
  seat?: Seat | null;
  /** The chip that hands the column back to the Head of People. */
  onBackToHead?: () => void;
  /** An address named a seat whose object has not arrived yet: the column
   *  waits for it rather than show the Head of People for a moment. */
  holding?: boolean;
};

export function orgConversationState(p: Pick<OrgConversationProps, "tree" | "head" | "conversationId" | "readState" | "preview">): OrgConversationState {
  if (p.readState.kind === "refused") return "refused";
  if (p.readState.kind === "error") return "error";
  if (!p.tree) return "loading";
  if (!p.head) return "no-head";
  if (!p.conversationId) return "not-started";
  return p.preview ? "preview" : "live";
}

export function OrgConversation(props: OrgConversationProps) {
  const { tree, head, conversationId, readState, onRetry, jump, answersStaged, onOpenSession, onResume, strip, preview, seat, onBackToHead, holding } = props;
  const state = orgConversationState(props);
  // A cold open: the standing session is bucket-hidden, so the inbox never
  // seeds its row and the embed would say "Loading conversation…" until the
  // messages query answered. The same minimal row useSeedOwnership writes;
  // getConversationWithMeta merges the real one over it.
  useWatchEffect(() => {
    const st = useInboxStore.getState();
    if (conversationId && !st.conversations[conversationId] && !st.sessions[conversationId]) st.syncRecord("conversations", conversationId, { _id: conversationId });
  }, [conversationId]);
  // The Head of People's thread stays mounted under a seat, hidden: swapping
  // back (the chip, a proposal picked in the strip) finds it where the
  // person left it, scroll and all (D5).
  const held = !!seat || !!holding;
  const headColumn = (
    <div
      key="head"
      className={cn("h-full min-h-0 flex-col", held ? "hidden" : "flex")}
      {...(held ? { "data-org-conversation-held": conversationId ?? "" } : { "data-org-conversation": conversationId ?? "", "data-org-conversation-state": state })}
    >
      {!held && strip}
      {state === "refused" || state === "error" ? (
        <div className="relative flex-1 min-h-0"><OrgReadStateBlock kind={state} message={readState.kind === "error" ? readState.message : undefined} onRetry={state === "error" ? onRetry : undefined} /></div>
      ) : state === "loading" ? (
        <CenteredNote>Loading the org…</CenteredNote>
      ) : state === "no-head" ? (
        <NoHeadColumn {...props} />
      ) : (
        <>
          <SeatHead face={head!} name={head!.name} caption={headCaption(head!)} onOpenThread={conversationId ? () => onOpenSession(conversationId) : undefined} />
          {state === "not-started" ? (
            <CenteredNote>{head!.name} has not started yet. Its conversation appears here when it does.</CenteredNote>
          ) : state === "preview" ? (
            <PreviewColumn head={head!} {...preview!} />
          ) : (
            <>
              {head!.status === "paused" && <RolePausedNote name={head!.name} onResume={() => onResume(head!._id)} className="mx-4 mt-2" />}
              <div className="flex-1 min-h-0">
                <AnchorConversation
                  conversationId={conversationId!}
                  hideHeader
                  hideDiff
                  seedOwnership={false}
                  foldBootstrap
                  foldWorkingTurns
                  initialDensity="condensed"
                  // The strip is this column's pinned context; the thread's
                  // own sticky last prompt would float over the cards.
                  stickyPrompt={false}
                  composerPlaceholder={answersStaged ? `Ask ${head!.name}, or send your answers as they are` : `Ask ${head!.name}`}
                  jump={jump}
                />
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
  return (
    <>
      {seat && <SeatColumn key="seat" seat={seat} head={head} strip={strip} onOpenSession={onOpenSession} onResume={onResume} onBackToHead={onBackToHead} />}
      {!seat && holding && <div key="hold" className="flex h-full min-h-0 flex-col" data-org-conversation-state="holding">{strip}<CenteredNote>Loading…</CenteredNote></div>}
      {headColumn}
    </>
  );
}

/** The one head of the left column, whoever sits in it: the face, the name
 *  over what they are here for, any chips, and the way to the full thread.
 *  The Head of People's and a seat's are the same row, so swapping between
 *  them moves nothing. Its state line has one home, the thread's own pinned
 *  state panel at the foot. */
function SeatHead({ face, name, caption, chips, onOpenThread, seat }: { face: OrgRole | null; name: string; caption: string | null; chips?: React.ReactNode; onOpenThread?: () => void; seat?: boolean }) {
  return (
    <div className={cn("shrink-0 flex items-center gap-2.5 border-b", ORG_BAND, ORG_GUTTER)} style={{ borderColor: ORG_RULE }} data-org-conversation-head={seat ? "seat" : "head"}>
      {face ? <RoleFace role={face} size={28} /> : <span className="w-7 h-7 rounded-full shrink-0" style={{ background: "var(--sol-bg-highlight)" }} aria-hidden />}
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-semibold leading-[17px]" style={{ color: "var(--sol-text)" }} data-org-conversation-name>{name}</div>
        {caption && <div className="truncate text-[11.5px] leading-[15px]" style={{ color: "var(--sol-text-dim)" }} data-org-conversation-caption>{caption}</div>}
      </div>
      {chips}
      {onOpenThread && (
        <button type="button" onClick={onOpenThread} className="shrink-0 h-7 w-7 inline-flex items-center justify-center rounded-md hover:bg-sol-bg-highlight" style={{ color: "var(--sol-text-muted)" }} title="Open the full thread" aria-label="Open the full thread" data-org-open-thread>
          <ExternalLink className="w-3.5 h-3.5" />
        </button>
      )}
    </div>
  );
}

/** The column sitting with someone other than the Head of People: their face
 *  and why they are here ("owner of Increase top of funnel"), the chip that
 *  says who the person is talking to, and the way back. The thread is the
 *  same embed the Head of People's is. */
function SeatColumn({ seat, head, strip, onOpenSession, onResume, onBackToHead }: { seat: Seat; head: OrgRole | null; strip: React.ReactNode; onOpenSession: (id: string) => void; onResume: (roleId: string) => void; onBackToHead?: () => void }) {
  // The seat's row may not be in the inbox (a standing session is bucket
  // hidden): seed the minimal row, as the Head of People's column does.
  useWatchEffect(() => {
    const st = useInboxStore.getState();
    if (!st.conversations[seat.conversationId] && !st.sessions[seat.conversationId]) st.syncRecord("conversations", seat.conversationId, { _id: seat.conversationId });
  }, [seat.conversationId]);
  const role = seat.role;
  return (
    <div className="flex h-full min-h-0 flex-col" data-org-conversation={seat.conversationId} data-org-conversation-state="seat" data-org-seat={role?.short_id ?? "person"}>
      {strip}
      <SeatHead
        seat
        face={role}
        name={seat.name}
        caption={seat.caption}
        onOpenThread={() => onOpenSession(seat.conversationId)}
        chips={<>
          <span className="hidden md:inline-flex shrink-0 items-center rounded-[10px] px-2 py-[2px] text-[11px] whitespace-nowrap" style={{ background: "var(--sol-bg-highlight)", color: "var(--sol-text-muted)" }} data-org-talking-to>Talking to {seat.name}</span>
          {onBackToHead && (
            <button type="button" onClick={onBackToHead} className="shrink-0 inline-flex items-center gap-1 rounded-[10px] px-2 py-[2px] text-[11px] whitespace-nowrap hover:brightness-110" style={{ background: "var(--sol-bg-highlight)", color: "var(--sol-text-secondary)" }} title={head ? `Back to ${head.name}` : "Back to the Head of People"} data-org-back-to-head>
              <ArrowLeft className="w-3 h-3" /> {head?.name ?? "Head of People"}
            </button>
          )}
        </>}
      />
      {role?.status === "paused" && <RolePausedNote name={role.name} onResume={() => onResume(role._id)} className="mx-4 mt-2" />}
      <div className="flex-1 min-h-0">
        <AnchorConversation
          key={seat.conversationId}
          conversationId={seat.conversationId}
          hideHeader
          hideDiff
          seedOwnership={false}
          foldBootstrap
          foldWorkingTurns
          initialDensity="condensed"
          stickyPrompt={false}
          composerPlaceholder={`Ask ${seat.name}`}
        />
      </div>
    </div>
  );
}

/** No Head of People: the hire card, and the one line that reviews the org once instead. */
function NoHeadColumn({ reviewing, reviewEnded, reviewSessionId, onProposeNow, onOpenSession }: OrgConversationProps) {
  return (
    <div className="flex-1 min-h-0 overflow-y-auto flex flex-col justify-center py-6">
      <div className="shrink-0"><HireHeadOfPeopleCard /></div>
      <div className="mx-auto mt-4 max-w-md w-full px-6 flex flex-col items-center gap-2 text-center" data-org-propose-now-line>
        {reviewing ? (
          <>
            <p className="text-[12px] flex items-center gap-2" style={{ color: "var(--sol-text-muted)" }}>
              <Sparkles className="w-3.5 h-3.5 animate-pulse shrink-0" style={{ color: "var(--sol-violet)" }} />
              Reviewing the company. The proposal appears here when it lands.
            </p>
            {reviewSessionId && <ReviewSessionLink id={reviewSessionId} onOpenSession={onOpenSession} />}
          </>
        ) : (
          <>
            {reviewEnded && <ReviewEndedLine sessionId={reviewSessionId} onOpenSession={onOpenSession} />}
            <p className="text-[12px]" style={{ color: "var(--sol-text-muted)" }}>
              Or have a fresh session review the org once:{" "}
              <button type="button" onClick={onProposeNow} className="font-medium hover:underline underline-offset-2" style={{ color: "var(--sol-violet)" }} data-org-propose-now>Propose an org now</button>
            </p>
          </>
        )}
      </div>
    </div>
  );
}

/** The dev preview's thread: one agent bubble per fixture proposal holding
 *  its card, answering into a batch nothing sends, and a frame where the
 *  composer would be. `?proposal=op-N` scrolls to its bubble. */
function PreviewColumn({ head, proposals, onSend, current }: { head: OrgRole } & NonNullable<OrgConversationProps["preview"]>) {
  const composer = useMemo<ReviewComposer>(() => ({ quote() {}, submit() {}, conversationId: PREVIEW_BATCH, canSend: true }), []);
  // The preview's batch is this visit's: answers staged on a fixture card
  // persist with the rest of the batches, and a reload would open on cards
  // already "Approved" by nobody in the room.
  useMountEffect(() => {
    useInboxStore.getState().clearReviewComments(PREVIEW_BATCH);
    return () => useInboxStore.getState().clearReviewComments(PREVIEW_BATCH);
  });
  const comments = useInboxStore((s) => s.reviewComments[PREVIEW_BATCH]);
  const answered = proposals.filter((p) => proposalAnswersOf(comments, p._id).length > 0);
  const scroller = useRef<HTMLDivElement>(null);
  const [now] = useState(() => Date.now());
  useWatchEffect(() => {
    if (current) scroller.current?.querySelector(`[data-preview-card="${current}"]`)?.scrollIntoView({ block: "start" });
  }, [current]);
  return (
    <div className="flex-1 min-h-0 flex flex-col" data-thread-preview>
      <div ref={scroller} className="flex-1 min-h-0 overflow-y-auto px-4 py-4 flex flex-col gap-5">
        <ReviewComposerContext.Provider value={composer}>
          {proposals.map((p) => (
            <article key={p._id} className="flex gap-2.5" data-preview-card={p.short_id}>
              <RoleFace role={head} size={24} className="shrink-0 mt-0.5" />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2 text-[12px]">
                  <span className="font-semibold" style={{ color: "var(--sol-text)" }}>{head.name}</span>
                  <span style={{ color: "var(--sol-text-dim)" }}>{agoOf(now - p.created_at)}</span>
                </div>
                <div className="mt-1"><ProposalBody proposal={p} changes={p.changes} open summary={<MarkdownRenderer content={p.summary_md ?? ""} />} /></div>
              </div>
            </article>
          ))}
        </ReviewComposerContext.Provider>
      </div>
      <div className="relative shrink-0">
        <ComposerFade />
        <div className="mx-3 mb-3 rounded-xl border px-3 py-2.5 flex items-center gap-3 text-[13px]" style={{ borderColor: "color-mix(in srgb, var(--sol-border) 35%, transparent)", background: "var(--sol-card)", color: "var(--sol-text-dim)" }}>
          <span className="min-w-0 flex-1">Reply to the Head of People</span>
          {answered.length > 0 && (
            <button type="button" onClick={() => { for (const p of answered) onSend(p._id); toast.success("Preview: nothing is sent"); }} className="shrink-0 text-[12px] font-medium hover:underline underline-offset-2" style={{ color: "var(--sol-violet)" }} data-preview-send>
              Send {answered.length === 1 ? "the answers" : `answers on ${answered.length}`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
