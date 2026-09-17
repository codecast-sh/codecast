"use client";
// The conversation that is part of a proposal (docs/architecture/org-staffing.md
// S18): the author's thread bound to op-N, rendered with the same embedded
// conversation view a session uses, so a person reads and writes there exactly
// as they do in a session and the thread survives a reload. Above the box, a
// line says which change the next message is about: the one the person is
// looking at (the selected row), cleared with one click to talk about the
// whole proposal. The send goes through the page's `onSay`, which paints the
// bubble at once and rides dispatch to orgProposals.say; nothing awaits.
//
// Where it sits is the page's call (OrgPage): its own column beside the list
// on a wide desktop, under the list when the window is narrow, and the phone
// sheet's second view, reached from the list. The page passes `layout` so the
// frame fits each.
import { useCallback } from "react";
import { ArrowLeft, ExternalLink, MessageSquareText, Pause, Play, X } from "lucide-react";
import { cn } from "../../lib/utils";
import { AnchorConversation } from "../anchor/AnchorConversation";
import { OrgButton } from "./OrgButton";
import { StatusPill } from "./StaffingPane";
import { changeLine } from "./staffingModel";
import type { OrgProposalChange, OrgProposalRow } from "./orgStaffingTypes";
import type { ProposalThreadRef } from "./staffingRevise";
import { revisedLine } from "./staffingRevise";

export type ProposalThreadLayout = "side" | "stack" | "phone";

export type ProposalThreadProps = {
  proposal: Pick<OrgProposalRow, "short_id" | "changes">;
  thread: ProposalThreadRef;
  layout: ProposalThreadLayout;
  /** The change the person is looking at: the next message names it. */
  about: OrgProposalChange | null;
  onClearAbout: () => void;
  /** The person's words and the change they were about. */
  onSay: (threadConversationId: string, proposalShortId: string, changeSeq: number | null, body: string) => void;
  onOpenSession: (conversationId: string) => void;
  /** Resume a paused role: what the person sends waits until then. */
  onResume?: (roleId: string) => void;
  /** Changes the author revised since the reader last looked; on the phone
   *  the thread says so with the way back to the list. */
  revisedRows?: OrgProposalChange[];
  onBackToList?: () => void;
  /** The DEV preview has no live thread; the frame paints in its place. */
  preview?: boolean;
  autoFocus?: boolean;
};

const BORDER = "color-mix(in srgb, var(--sol-border) 30%, transparent)";

export function ProposalThread(props: ProposalThreadProps) {
  const { proposal, thread, layout, about, preview } = props;
  const paused = thread.role?.status === "paused";
  const onSendOverride = useCallback(async (content: string) => {
    const body = content.trim();
    if (!body) return;
    props.onSay(thread.conversationId, proposal.short_id, about?.seq ?? null, body);
  }, [props.onSay, thread.conversationId, proposal.short_id, about?.seq]); // eslint-disable-line react-hooks/exhaustive-deps
  const revised = props.revisedRows ?? [];
  return (
    <div className={cn("flex flex-col min-h-0", layout === "stack" ? "mt-6 pt-4 border-t" : "h-full")} style={layout === "stack" ? { borderColor: BORDER } : undefined} data-proposal-thread={thread.conversationId} data-thread-layout={layout}>
      <div className={cn("flex items-center gap-2 shrink-0", layout === "stack" ? "mb-2" : "h-10 px-3 border-b")} style={layout === "stack" ? undefined : { borderColor: BORDER }}>
        {layout === "phone" && props.onBackToList && (
          <button type="button" onClick={props.onBackToList} className="inline-flex items-center gap-1 text-[12px] font-medium -ml-1 px-1 h-7 rounded-md hover:bg-sol-bg-highlight" style={{ color: "var(--sol-violet)" }} data-thread-back>
            <ArrowLeft className="w-3.5 h-3.5" /> Changes
          </button>
        )}
        <MessageSquareText className="w-3.5 h-3.5 shrink-0" style={{ color: "var(--sol-violet)" }} />
        <span className="min-w-0 flex-1 truncate text-[12px]" style={{ color: "var(--sol-text-secondary)" }}>
          Talk to <span className="font-medium" style={{ color: "var(--sol-text)" }}>{thread.name}</span>, who wrote this
        </span>
        <button type="button" onClick={() => props.onOpenSession(thread.conversationId)} className="inline-flex items-center gap-1 text-[11px] px-1.5 h-[22px] rounded-md hover:bg-sol-bg-highlight shrink-0" style={{ color: "var(--sol-text-dim)" }} title="Open the session in full" data-thread-open>
          Open <ExternalLink className="w-3 h-3" />
        </button>
      </div>
      {layout === "phone" && revised.length > 0 && props.onBackToList && (
        <button type="button" onClick={props.onBackToList} className="shrink-0 mx-3 mt-2 rounded-lg border px-3 py-1.5 text-left text-[12px]" style={{ borderColor: "color-mix(in srgb, var(--sol-violet) 45%, transparent)", background: "color-mix(in srgb, var(--sol-violet) 8%, transparent)", color: "var(--sol-text-secondary)" }} data-thread-revised>
          {revisedLine(revised, thread.name)} <span className="font-medium" style={{ color: "var(--sol-violet)" }}>See the list</span>
        </button>
      )}
      {paused && thread.role && (
        <div className={cn("shrink-0 rounded-lg border px-3 py-2 flex items-center gap-2 text-[12px]", layout === "stack" ? "mb-2" : "mx-3 mt-2")} data-chief-paused style={{ borderColor: "color-mix(in srgb, var(--sol-yellow) 45%, transparent)", background: "color-mix(in srgb, var(--sol-yellow) 8%, transparent)", color: "var(--sol-text-secondary)" }}>
          <Pause className="w-3.5 h-3.5 shrink-0" style={{ color: "var(--sol-yellow)" }} />
          <span className="min-w-0 flex-1">{thread.name} is paused: what you send waits until you resume it.</span>
          {props.onResume && <OrgButton size="sm" onClick={() => props.onResume!(thread.role!._id)}><Play className="w-3 h-3" /> Resume</OrgButton>}
        </div>
      )}
      <div className={cn("min-h-0 flex-1", layout === "stack" ? "rounded-xl border overflow-hidden" : "")} style={layout === "stack" ? { borderColor: BORDER, height: "min(460px, 50dvh)" } : undefined}>
        {preview ? (
          <PreviewFrame about={about} onClearAbout={props.onClearAbout} />
        ) : (
          <AnchorConversation
            conversationId={thread.conversationId}
            hideHeader
            seedOwnership={false}
            onSendOverride={onSendOverride}
            composerNode={<AboutLine about={about} onClear={props.onClearAbout} />}
            autoFocusInput={props.autoFocus}
          />
        )}
      </div>
    </div>
  );
}

/** What the next message is about. The selected change, named on the row's
 *  own words, so the agent answers about the right one; or the whole proposal. */
export function AboutLine({ about, onClear }: { about: OrgProposalChange | null; onClear: () => void }) {
  return (
    <div className="mx-3 mb-1.5 flex items-center gap-2 min-w-0 text-[11.5px]" data-about-line data-about-change={about?._id ?? ""}>
      <span className="shrink-0 uppercase tracking-[0.08em] text-[9.5px] font-semibold" style={{ color: about ? "var(--sol-violet)" : "var(--sol-text-dim)" }}>{about ? "about this change" : "about"}</span>
      {about ? (
        <>
          <StatusPill status={about.status} />
          <span className="min-w-0 flex-1 truncate" style={{ color: "var(--sol-text-secondary)" }} title={changeLine(about.change)}>{changeLine(about.change)}</span>
          <button type="button" onClick={onClear} className="shrink-0 w-5 h-5 inline-flex items-center justify-center rounded hover:bg-sol-bg-highlight" aria-label="Talk about the whole proposal instead" title="Talk about the whole proposal instead" style={{ color: "var(--sol-text-dim)" }} data-about-clear>
            <X className="w-3 h-3" />
          </button>
        </>
      ) : (
        <span className="min-w-0 flex-1 truncate" style={{ color: "var(--sol-text-dim)" }}>the whole proposal. Click a change to ask about that one.</span>
      )}
    </div>
  );
}

/** The DEV preview's stand-in for the live thread: the same frame, no session. */
function PreviewFrame({ about, onClearAbout }: { about: OrgProposalChange | null; onClearAbout: () => void }) {
  return (
    <div className="h-full flex flex-col" data-thread-preview>
      <div className="flex-1 min-h-0 flex items-center justify-center text-[12px] px-6 text-center" style={{ color: "var(--sol-text-dim)" }}>
        The conversation with the author renders here, the same way a session does. This preview has no live session behind it.
      </div>
      <div className="shrink-0 pb-3">
        <AboutLine about={about} onClear={onClearAbout} />
        <div className="mx-3 h-10 rounded-lg border" style={{ borderColor: BORDER }} />
      </div>
    </div>
  );
}
