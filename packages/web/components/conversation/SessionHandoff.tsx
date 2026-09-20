import Link from "next/link";
import { forwardRef, type ComponentPropsWithoutRef } from "react";
import { useShallow } from "zustand/react/shallow";
import { ArrowRight, ArrowRightLeft, ArrowUpRight, ChevronRight } from "lucide-react";
import { entityShortLabel } from "@codecast/shared/entities";
import { useInboxStore } from "../../store/inboxStore";
import { abbrevModel } from "../../lib/entityDisplay";
import { formatAgentType } from "../AgentTypeIcon";
import type { SessionHandoffPrompt } from "../../lib/sessionHandoff";
import type { HandoffLinkDetails } from "./types";
import { MessageMarkdown } from "./markdown";
import { formatFullTimestamp, formatRelativeTime } from "./format";

type HandoffNavigation = {
  convLink: (id: string) => string;
  navigateToSession: (id: string) => void;
};

type HandoffSessionLinkProps = HandoffNavigation & Omit<ComponentPropsWithoutRef<typeof Link>, "href"> & {
  details: HandoffLinkDetails;
  compact?: boolean;
};

export const HandoffSessionLink = forwardRef<HTMLAnchorElement, HandoffSessionLinkProps>(function HandoffSessionLink({ details, compact, children, convLink, navigateToSession, onClick, ...linkProps }, ref) {
  const { title, shortTitle } = useInboxStore(useShallow(s => ({
    title: s.conversations[details.conversation_id]?.title || s.sessions[details.conversation_id]?.title || details.title || "Untitled session",
    shortTitle: s.conversations[details.conversation_id]?.short_title || s.sessions[details.conversation_id]?.short_title,
  })));
  const unresolved = details.conversation_id === details.short_id;
  const label = compact ? entityShortLabel({ shortTitle, title, rawId: "", typeLabel: "Session" }) : title;
  return (
    <Link
      {...linkProps}
      ref={ref}
      href={`${convLink(details.conversation_id)}${unresolved ? "?handoff=1" : ""}`}
      onClick={e => {
        onClick?.(e);
        if (e.defaultPrevented) return;
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
        if (unresolved) return;
        e.preventDefault();
        navigateToSession(details.conversation_id);
      }}
      title={title}
    >
      {children}
      <span className="min-w-0 truncate">{label}</span>
    </Link>
  );
});

export function HandoffLinkChip({ details, direction, ...navigation }: HandoffNavigation & {
  details: HandoffLinkDetails;
  direction: "from" | "to";
}) {
  return (
    <span data-handoff-chip={direction} className="cq-sq6 min-w-0 max-w-[240px]">
      <HandoffSessionLink details={details} compact {...navigation} className="inline-flex max-w-full items-center gap-1 rounded-full border border-sol-cyan/30 bg-sol-cyan/10 px-2 py-0.5 text-[10px] text-sol-cyan transition-colors hover:bg-sol-cyan/20">
        <ArrowRightLeft className="h-3 w-3 shrink-0" />
        <span className="cq-sq2 shrink-0">{direction === "from" ? "From" : "Continued in"}</span>
      </HandoffSessionLink>
    </span>
  );
}

export function SessionHandoffCard({ handoff, source, timestamp, ...navigation }: HandoffNavigation & {
  handoff: SessionHandoffPrompt;
  source?: HandoffLinkDetails | null;
  timestamp: number;
}) {
  const linkedSource = source?.short_id === handoff.sourceId ? source : null;
  const details = linkedSource ?? { conversation_id: handoff.sourceId, short_id: handoff.sourceId, title: handoff.sourceTitle };
  return (
    <article data-session-handoff="incoming" className="my-3 overflow-hidden rounded-xl border border-sol-cyan/25 bg-sol-bg-alt/40">
      <div className="border-b border-sol-cyan/15 bg-sol-cyan/[0.06] px-4 py-3 sm:px-5">
        <div className="mb-2 flex items-center gap-2 text-sol-cyan">
          <ArrowRightLeft className="h-3.5 w-3.5 shrink-0" />
          <span className="text-[10px] font-semibold uppercase tracking-[0.14em]">Session handoff</span>
          <time className="ml-auto text-[10px] font-normal tracking-normal text-sol-text-dim" dateTime={new Date(timestamp).toISOString()} title={formatFullTimestamp(timestamp)}>{formatRelativeTime(timestamp)}</time>
        </div>
        <HandoffSessionLink details={details} {...navigation} className="group flex min-w-0 items-center gap-2 text-sm font-semibold text-sol-text transition-colors hover:text-sol-cyan">
          <span className="shrink-0 font-normal text-sol-text-dim">From</span>
        </HandoffSessionLink>
        <div className="mt-1 text-[11px] text-sol-text-dim" title={handoff.sourceAgent}>
          {linkedSource?.agent_type ? formatAgentType(linkedSource.agent_type) : handoff.sourceAgent}
          {linkedSource?.agent_type && linkedSource.model && ` · ${abbrevModel(linkedSource.model) || linkedSource.model}`}
        </div>
      </div>
      {handoff.direction && (
        <div className="border-b border-sol-border/50 px-4 py-3 sm:px-5">
          <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-sol-cyan">Direction</div>
          <div className="prose prose-invert prose-sm max-w-none break-words text-sol-text [&_p]:my-1"><MessageMarkdown content={handoff.direction} /></div>
        </div>
      )}
      <div className="prose prose-invert prose-sm max-w-none break-words px-4 py-4 text-sol-text sm:px-5 [&_h2]:mb-2 [&_h2]:mt-5 [&_h2]:text-[11px] [&_h2]:font-semibold [&_h2]:uppercase [&_h2]:tracking-[0.1em] [&_h2]:text-sol-text-dim [&_h2:first-child]:mt-0 [&_p]:my-2 [&_ul]:my-2 [&_ol]:my-2 [&_li]:my-1">
        <MessageMarkdown content={handoff.brief} />
      </div>
      <details className="group border-t border-sol-border/50">
        <summary className="flex cursor-pointer list-none items-center gap-1.5 px-4 py-2.5 text-[11px] text-sol-text-dim transition-colors hover:text-sol-cyan sm:px-5 [&::-webkit-details-marker]:hidden">
          <ChevronRight className="h-3 w-3 group-open:rotate-90" />
          Transcript & context
        </summary>
        <div className="prose prose-invert prose-sm max-w-none break-words px-4 pb-4 text-sol-text sm:px-5"><MessageMarkdown content={handoff.readMore} /></div>
      </details>
    </article>
  );
}

export function SessionHandoffNotice({ details, ...navigation }: HandoffNavigation & { details: HandoffLinkDetails }) {
  return (
    <div data-session-handoff="outgoing" className="my-4 flex min-w-0 items-center gap-2 text-xs text-sol-text-dim">
      <ArrowRight className="h-3.5 w-3.5 shrink-0 text-sol-cyan" />
      <span className="shrink-0">Handed off to</span>
      <HandoffSessionLink details={details} compact {...navigation} className="min-w-0 truncate font-medium text-sol-cyan hover:underline" />
      <ArrowUpRight className="h-3 w-3 shrink-0 text-sol-cyan/60" />
      <span className="h-px min-w-3 flex-1 bg-sol-border/50" />
    </div>
  );
}
