"use client";
// The conversation that leads a proposal (docs/architecture/org-staffing.md
// S19, on S18's thread): the author's thread bound to op-N, rendered with the
// same embedded conversation view a session uses. Its first message is the
// letter, as the author's own bubble, with one line of introduction the first
// time a person meets the feature. The thread is a standing session with a
// history from before the proposal, so the embed starts at the proposal's
// creation, opens on the letter rather than the live tail, and folds the
// author's working turns (tool calls, files read, commands run) behind one
// line each, so it reads as a conversation and not a transcript.
//
// A line above the box says what the next message is about, only when it is
// about something: the ask whose card said "Ask about this", or the change
// the person is looking at inside a fold. The send goes through the page's
// `onSay`, which paints the bubble at once and rides dispatch to
// orgProposals.say; nothing awaits.
//
// Where it sits is the page's call (OrgPage): the wider left column on a
// desktop, the whole sheet on a phone, where a bar at the foot counts the
// asks and opens them.
import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import { ChevronDown, ChevronRight, ChevronUp, ExternalLink, MessageSquareText, X } from "lucide-react";
import { toast } from "sonner";
import { agoOf } from "../../lib/threadState";
import { cn } from "../../lib/utils";
import { AnchorConversation } from "../anchor/AnchorConversation";
import { MarkdownRenderer } from "../tools/MarkdownRenderer";
import { RoleAvatar } from "./avatars";
import { RolePausedNote } from "./RolePausedNote";
import { StatusPill } from "./StaffingPane";
import { changeLine } from "./staffingModel";
import { introducesItself, letterIntro, letterParts, type AskView } from "./staffingAsks";
import type { OrgProposalChange, OrgProposalRow } from "./orgStaffingTypes";
import type { ProposalThreadRef } from "./staffingRevise";

export type ProposalThreadLayout = "lead" | "phone";

/** What the next message is about: one ask, one change, or (null) the whole proposal. */
export type ProposalAbout = { kind: "ask"; ask: AskView } | { kind: "change"; change: OrgProposalChange } | null;

export type ProposalThreadProps = {
  proposal: Pick<OrgProposalRow, "short_id" | "summary_md" | "created_at">;
  thread: ProposalThreadRef;
  layout: ProposalThreadLayout;
  about: ProposalAbout;
  onClearAbout: () => void;
  /** The person's words and what they were about. */
  onSay: (threadConversationId: string, proposalShortId: string, about: { changeSeq: number | null; askIndex: number | null }, body: string) => void;
  onOpenSession: (conversationId: string) => void;
  /** Resume a paused role: what the person sends waits until then. */
  onResume?: (roleId: string) => void;
  /** The reader has never accepted a change: the letter opens with one line
   *  of introduction (staffingModel.hasAcceptedBefore answers it). */
  firstTime: boolean;
  now: number;
  /** Phone: the bar at the foot. How many asks wait, how many rows the
   *  author changed since the reader last looked, and the way to the asks. */
  asksBar?: { toDecide: number; total: number; updated: number; onOpen: () => void };
  /** The DEV preview has no live thread; the letter and a frame paint in its place. */
  preview?: boolean;
  autoFocus?: boolean;
};

const BORDER = "color-mix(in srgb, var(--sol-border) 30%, transparent)";

export function ProposalThread(props: ProposalThreadProps) {
  const { proposal, thread, layout, about, preview } = props;
  const paused = thread.role?.status === "paused";
  // orgProposals.say carries text only. A picture is never dropped in
  // silence: with no words the send is refused and says why; with words the
  // words go and the line says the picture did not.
  const aboutChangeSeq = about?.kind === "change" ? about.change.seq : null;
  const aboutAskIndex = about?.kind === "ask" ? about.ask.index : null;
  const onSendOverride = useCallback(async (content: string, images?: Array<{ storageId?: string }>) => {
    const body = content.trim();
    const pictures = images?.length ?? 0;
    if (!body) {
      if (pictures > 0) toast.error("The picture was not sent", { description: "This conversation takes text for now." });
      return;
    }
    props.onSay(thread.conversationId, proposal.short_id, { changeSeq: aboutChangeSeq, askIndex: aboutAskIndex }, body);
    if (pictures > 0) toast.warning(`Sent your words, not the ${pictures === 1 ? "picture" : "pictures"}`, { description: "This conversation takes text for now." });
  }, [props.onSay, thread.conversationId, proposal.short_id, aboutChangeSeq, aboutAskIndex]); // eslint-disable-line react-hooks/exhaustive-deps
  // Element props handed to the memoized conversation view keep identity
  // across this component's renders. `now` moves the letter's age and nothing
  // else, so it is read at a minute's grain.
  const minute = Math.floor(props.now / 60_000);
  const letter = useMemo(() => (
    <ProposalLetter proposal={proposal} thread={thread} firstTime={props.firstTime} now={minute * 60_000} onOpenSession={props.onOpenSession} />
  ), [proposal.summary_md, proposal.created_at, thread, props.firstTime, minute, props.onOpenSession]); // eslint-disable-line react-hooks/exhaustive-deps
  const bar = props.asksBar;
  const composerNode = useMemo(() => (
    <>
      {bar && <AsksBar {...bar} />}
      <AboutLine about={about} onClear={props.onClearAbout} />
    </>
  ), [bar?.toDecide, bar?.total, bar?.updated, bar?.onOpen, about, props.onClearAbout]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="h-full flex flex-col min-h-0" data-proposal-thread={thread.conversationId} data-thread-layout={layout}>
      {paused && thread.role && (
        <RolePausedNote name={thread.name} className="mx-3 mt-2" onResume={props.onResume ? () => props.onResume!(thread.role!._id) : undefined} />
      )}
      <div className="min-h-0 flex-1">
        {preview ? (
          <div className="h-full flex flex-col" data-thread-preview>
            <div className="flex-1 min-h-0 overflow-y-auto">{letter}</div>
            <div className="shrink-0 pb-3">
              {composerNode}
              <div className="mx-3 h-10 rounded-lg border flex items-center px-3 text-[12.5px]" style={{ borderColor: BORDER, color: "var(--sol-text-dim)" }}>Reply to {thread.named ? thread.name : "the author"}</div>
            </div>
          </div>
        ) : (
          <AnchorConversation
            conversationId={thread.conversationId}
            hideHeader
            hideDiff
            seedOwnership={false}
            since={proposal.created_at}
            leadNode={letter}
            initialDensity="condensed"
            foldWorkingTurns
            openAtTop
            composerPlaceholder={`Reply to ${thread.named ? thread.name : "the author"}`}
            onSendOverride={onSendOverride}
            composerNode={composerNode}
            autoFocusInput={props.autoFocus}
          />
        )}
      </div>
    </div>
  );
}

/**
 * The letter, as the author's own first bubble: the face and the name, when
 * it was written, then the words. Laid out on the conversation's own column
 * so it lines up with the live messages under it. The way into the full
 * session is the quiet icon on the name's line.
 */
export function ProposalLetter({ proposal, thread, firstTime, now, onOpenSession }: {
  proposal: Pick<OrgProposalRow, "summary_md" | "created_at">;
  thread: ProposalThreadRef;
  firstTime: boolean;
  now: number;
  onOpenSession: (conversationId: string) => void;
}) {
  const [restOpen, setRestOpen] = useState(false);
  const { lead, rest, evidenceHref } = useMemo(() => letterParts(proposal.summary_md), [proposal.summary_md]);
  return (
    <div className="conv-col mx-auto px-2 sm:px-3 md:px-4 pt-4 pb-2" data-proposal-letter>
      <div className="flex items-center gap-2 mb-2">
        {thread.role
          ? <RoleAvatar avatar={thread.role.avatar ?? thread.role.handle} size={24} />
          : <span className="w-6 h-6 rounded-full inline-flex items-center justify-center shrink-0" style={{ background: "color-mix(in srgb, var(--sol-violet) 16%, transparent)", color: "var(--sol-violet)" }}><MessageSquareText className="w-3.5 h-3.5" /></span>}
        <span className="text-xs font-medium" style={{ color: "var(--sol-text-secondary)" }} data-letter-author>{thread.named ? thread.name : "The agent that wrote this"}</span>
        <span className="text-xs tabular-nums" style={{ color: "var(--sol-text-dim)" }} title={new Date(proposal.created_at).toLocaleString()}>{agoOf(Math.max(0, now - proposal.created_at))}</span>
        <button type="button" onClick={() => onOpenSession(thread.conversationId)} className="ml-auto w-6 h-6 inline-flex items-center justify-center rounded-md hover:bg-sol-bg-highlight" style={{ color: "var(--sol-text-dim)" }} aria-label="Open the full session" title="Open the full session, with every step the author took" data-thread-open>
          <ExternalLink className="w-3.5 h-3.5" />
        </button>
      </div>
      <div className="pl-8 text-[13.5px] leading-relaxed" style={{ color: "var(--sol-text)" }}>
        {firstTime && !introducesItself(lead) && <p className="mb-2.5" style={{ color: "var(--sol-text-secondary)" }} data-letter-intro>{letterIntro(thread.name, thread.named)}</p>}
        <div data-letter-lead><MarkdownRenderer content={lead} /></div>
        {restOpen && rest && <div className="mt-2.5" data-letter-rest><MarkdownRenderer content={rest} /></div>}
        {(rest || evidenceHref) && (
          <div className="mt-1.5 flex items-center gap-3 text-[12px]">
            {rest && (
              <button type="button" onClick={() => setRestOpen((v) => !v)} aria-expanded={restOpen} className="inline-flex items-center gap-1 h-6 hover:underline underline-offset-2" style={{ color: "var(--sol-violet)" }} data-letter-toggle>
                {restOpen ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                {restOpen ? "Fold the letter" : "Read the rest of the letter"}
              </button>
            )}
            {evidenceHref && (restOpen || !rest) && (
              <Link href={evidenceHref} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 h-6 hover:underline underline-offset-2" style={{ color: "var(--sol-violet)" }} data-letter-evidence>
                The evidence <ExternalLink className="w-3 h-3" style={{ color: "var(--sol-text-dim)" }} />
              </Link>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** What the next message is about, above the box, only when it is about
 *  something: an ask by its title, or a change by its own line. One click
 *  goes back to talking about the whole proposal, which needs no line. */
export function AboutLine({ about, onClear }: { about: ProposalAbout; onClear: () => void }) {
  if (!about) return null;
  const label = about.kind === "ask" ? about.ask.title : changeLine(about.change.change);
  return (
    <div className="mx-3 mb-1.5 flex items-center gap-2 min-w-0 text-[12px] org-pop-in" data-about-line data-about-ask={about.kind === "ask" ? about.ask.index : undefined} data-about-change={about.kind === "change" ? about.change._id : undefined}>
      <span className="shrink-0" style={{ color: "var(--sol-violet)" }}>Asking about</span>
      {about.kind === "change" && <StatusPill status={about.change.status} />}
      <span className="min-w-0 flex-1 truncate font-medium" style={{ color: "var(--sol-text)" }} title={label}>{label}</span>
      <button type="button" onClick={onClear} className="shrink-0 w-5 h-5 inline-flex items-center justify-center rounded hover:bg-sol-bg-highlight" aria-label="Talk about the whole proposal instead" title="Talk about the whole proposal instead" style={{ color: "var(--sol-text-dim)" }} data-about-clear>
        <X className="w-3 h-3" />
      </button>
    </div>
  );
}

/** Phone (S19): the conversation is the page, and this bar at its foot says
 *  how many asks wait and opens them as a sheet. */
function AsksBar({ toDecide, total, updated, onOpen }: { toDecide: number; total: number; updated: number; onOpen: () => void }) {
  const done = toDecide === 0;
  return (
    <button type="button" onClick={onOpen} className={cn("mx-3 mb-2 w-[calc(100%-1.5rem)] h-11 rounded-xl border flex items-center gap-2.5 px-3.5 text-left")} style={{ borderColor: `color-mix(in srgb, ${done ? "var(--sol-green)" : "var(--sol-violet)"} 45%, transparent)`, background: "var(--sol-card)", color: "var(--sol-text)" }} data-asks-bar>
      <span className="min-w-0 flex-1 truncate text-[13.5px] font-semibold tabular-nums">{done ? `All ${total} decided` : `${toDecide} to decide`}</span>
      {updated > 0 && <span className="shrink-0 inline-flex items-center h-5 px-1.5 rounded-full text-[10.5px] font-semibold tabular-nums" style={{ background: "var(--sol-violet)", color: "var(--sol-bg)" }}>{updated} updated</span>}
      <ChevronUp className="w-4 h-4 shrink-0" style={{ color: "var(--sol-text-dim)" }} />
    </button>
  );
}

/** Phone (S19): the asks as a sheet over the conversation. A tap on the
 *  scrim or the handle closes it; a card's "Ask about this" closes it too,
 *  with that ask attached to the composer. */
export function AsksSheet({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="absolute inset-0 z-10 flex flex-col justify-end" data-asks-sheet>
      <button type="button" aria-label="Close the asks" onClick={onClose} className="absolute inset-0" style={{ background: "color-mix(in srgb, var(--sol-bg) 55%, transparent)" }} data-asks-scrim />
      <div className="relative max-h-[88%] rounded-t-2xl border-t flex flex-col org-sheet-in shadow-[0_-12px_40px_-12px_rgba(0,0,0,0.45)]" style={{ background: "var(--sol-bg)", borderColor: "color-mix(in srgb, var(--sol-border) 35%, transparent)" }}>
        <button type="button" onClick={onClose} aria-label="Close the asks" className="shrink-0 flex justify-center pt-2 pb-1"><span className="w-10 h-1 rounded-full" style={{ background: "color-mix(in srgb, var(--sol-border) 60%, transparent)" }} /></button>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pt-1 pb-8">{children}</div>
      </div>
    </div>
  );
}
