"use client";
// The org screen's left column (docs/architecture/org-staffing.md S41): the
// Head of People's standing conversation, embedded whole and live, under the
// strip of open proposals. The strip and the head row paint from the org
// tree at once; only the thread body waits on its loader. With no Head of
// People the column is the one home of the hire card and "Propose an org
// now"; a refused or failed tree read is said here too.
import { useMemo, useRef, useState } from "react";
import { ExternalLink, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { useInboxStore } from "../../store/inboxStore";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { useMountEffect } from "../../hooks/useMountEffect";
import { agoOf } from "../../lib/threadState";
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
  const { tree, head, conversationId, readState, onRetry, jump, answersStaged, onOpenSession, onResume, strip, preview } = props;
  const state = orgConversationState(props);
  // A cold open: the standing session is bucket-hidden, so the inbox never
  // seeds its row and the embed would say "Loading conversation…" until the
  // messages query answered. The same minimal row useSeedOwnership writes;
  // getConversationWithMeta merges the real one over it.
  useWatchEffect(() => {
    const st = useInboxStore.getState();
    if (conversationId && !st.conversations[conversationId] && !st.sessions[conversationId]) st.syncRecord("conversations", conversationId, { _id: conversationId });
  }, [conversationId]);
  return (
    <div className="flex h-full min-h-0 flex-col" data-org-conversation={conversationId ?? ""} data-org-conversation-state={state}>
      {strip}
      {state === "refused" || state === "error" ? (
        <div className="relative flex-1 min-h-0"><OrgReadStateBlock kind={state} message={readState.kind === "error" ? readState.message : undefined} onRetry={state === "error" ? onRetry : undefined} /></div>
      ) : state === "loading" ? (
        <CenteredNote>Loading the org…</CenteredNote>
      ) : state === "no-head" ? (
        <NoHeadColumn {...props} />
      ) : (
        <>
          <ConversationHead head={head!} conversationId={conversationId} onOpenSession={onOpenSession} />
          {state === "not-started" ? (
            <CenteredNote>{head!.name} has not started yet. Its conversation appears here when it does.</CenteredNote>
          ) : state === "preview" ? (
            <PreviewColumn head={head!} {...preview!} />
          ) : (
            <>
              {head!.status === "paused" && <RolePausedNote name={head!.name} onResume={() => onResume(head!._id)} className="mx-3 mt-2" />}
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
}

/** The head's face and name, and the way to the full thread. Its state line
 *  has one home, the thread's own pinned state panel at the foot. */
function ConversationHead({ head, conversationId, onOpenSession }: { head: OrgRole; conversationId: string | null; onOpenSession: (id: string) => void }) {
  return (
    <div className="shrink-0 h-11 px-3 flex items-center gap-2.5 border-b" style={{ borderColor: "color-mix(in srgb, var(--sol-border) 22%, transparent)" }} data-org-conversation-head>
      <RoleFace role={head} size={24} />
      <span className="min-w-0 flex-1 truncate text-[13px] font-semibold" style={{ color: "var(--sol-text)" }}>{head.name}</span>
      {conversationId && (
        <button type="button" onClick={() => onOpenSession(conversationId)} className="shrink-0 h-7 w-7 inline-flex items-center justify-center rounded-md hover:bg-sol-bg-highlight" style={{ color: "var(--sol-violet)" }} title="Open the full thread" aria-label="Open the full thread" data-org-open-thread>
          <ExternalLink className="w-3.5 h-3.5" />
        </button>
      )}
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
