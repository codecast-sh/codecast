"use client";
// Where a proposal came from (docs/architecture/org-staffing.md S15): one
// pill naming the author. A session reads as its title and short id and opens
// the conversation through the usual session navigation; a role reads as its
// avatar and name and opens its scope page; a person reads as their name.
// The server stores only kind and id, so the pill resolves the rest from the
// store rows it can see (the session row, the org tree's role row), taking
// the server's enrichment first whenever it is there. The pane header, the
// queue card and the decision page all draw this one component.
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { useTrackedStore } from "../../store/inboxStore";
import { useOpenLinkedSession } from "../../hooks/useOpenLinkedSession";
import { useQueryNoThrow } from "../../hooks/useQueryNoThrow";
import { cn } from "../../lib/utils";
import { RoleAvatar } from "./avatars";
import { RoleHoverCard } from "../identity/RoleHoverCard";
import type { OrgProposalAuthor, OrgProposalListRow } from "./orgStaffingTypes";
import { proposalRefInContext } from "./staffingModel";
import { useProposalAuthor } from "../../hooks/useProposalAuthor";

const api = _api as any;

export function ProposalAuthorPill({ author, onOpenSession, className, size = "sm" }: {
  author: OrgProposalAuthor;
  /** How a session author opens; the pane hands its own (the preview is a
   *  no-op there). Absent = the usual linked session navigation. */
  onOpenSession?: (conversationId: string) => void;
  className?: string;
  size?: "sm" | "md";
}) {
  const view = useProposalAuthor(author);
  const openLinked = useOpenLinkedSession();
  const open = onOpenSession ?? ((id: string) => openLinked({ _id: id, title: view.kind === "session" ? view.title : undefined, short_id: view.kind === "session" ? view.shortId ?? undefined : undefined, updated_at: Date.now() }));
  const h = size === "md" ? "h-[24px] text-[12px]" : "h-[20px] text-[11px]";
  const base = cn("inline-flex items-center gap-1.5 max-w-full pl-1 pr-1.5 rounded-md border transition-colors", h, className);
  if (view.kind === "session") {
    return (
      <button
        type="button"
        onClick={() => open(view.sessionId)}
        className={cn(base, "hover:bg-sol-bg-highlight text-left")}
        style={{ borderColor: "color-mix(in srgb, var(--sol-cyan) 35%, transparent)", background: "color-mix(in srgb, var(--sol-cyan) 8%, transparent)", color: "var(--sol-text)" }}
        title={`Written by the session ${view.title}${view.shortId ? ` (${view.shortId})` : ""}. Opens the conversation.`}
        data-proposal-author="session"
      >
        <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: "var(--sol-cyan)" }} aria-hidden />
        <span className="truncate font-medium">{view.title}</span>
        {view.shortId && <span className="shrink-0" style={{ color: "var(--sol-cyan)", fontFamily: "var(--font-mono)" }}>{view.shortId}</span>}
        <ArrowUpRight className="w-3 h-3 shrink-0 opacity-60" />
      </button>
    );
  }
  if (view.kind === "role") {
    const inner = (
      <>
        <RoleAvatar avatar={view.avatar} size={size === "md" ? 18 : 15} />
        <span className="truncate font-medium">{view.name}</span>
        {view.handle && <span className="shrink-0 hidden sm:inline" style={{ color: "var(--sol-violet)", fontFamily: "var(--font-mono)" }}>@{view.handle}</span>}
      </>
    );
    const style = { borderColor: "color-mix(in srgb, var(--sol-violet) 35%, transparent)", background: "color-mix(in srgb, var(--sol-violet) 8%, transparent)", color: "var(--sol-text)" };
    const title = `Written by the role ${view.name}${view.handle ? ` (@${view.handle})` : ""}.${view.href ? " Opens its scope page." : ""}`;
    // A role that exists has a page, and what it looks after is one hover
    // away (org-roles-run-work.md R3); the card replaces the title tooltip.
    const roleShortId = view.href ? /\/(or-\d+)$/.exec(view.href)?.[1] : undefined;
    if (view.href && roleShortId) {
      return (
        <RoleHoverCard role={{ short_id: roleShortId, name: view.name, handle: view.handle ?? "", avatar: view.avatar }}>
          <Link href={view.href} className={cn(base, "hover:bg-sol-bg-highlight")} style={style} data-proposal-author="role">{inner}</Link>
        </RoleHoverCard>
      );
    }
    return view.href ? (
      <Link href={view.href} className={cn(base, "hover:bg-sol-bg-highlight")} style={style} title={title} data-proposal-author="role">{inner}</Link>
    ) : (
      <span className={base} style={style} title={title} data-proposal-author="role">{inner}</span>
    );
  }
  return (
    <span className={base} style={{ borderColor: "color-mix(in srgb, var(--sol-border) 40%, transparent)", color: "var(--sol-text)" }} title={`Written by ${view.name}`} data-proposal-author="user">
      <span className="truncate font-medium">{view.name}</span>
    </span>
  );
}

/**
 * The queue card's and the decision page's provenance (S15). A proposal's
 * decision is a pointer card whose context carries `/org?proposal=op-N`
 * (orgProposals.create); when it does, this feeds that one proposal into the
 * store (the same get feeder the org page uses for a linked proposal) and
 * draws "proposed by <author pill> · op-N". Nothing renders for any other
 * decision, so the card costs it nothing.
 */
export function DecisionProposalOrigin({ contextMd, className, size = "sm" }: { contextMd: string | null | undefined; className?: string; size?: "sm" | "md" }) {
  const shortId = proposalRefInContext(contextMd);
  // The store first: the org page's feeders may already hold the row. Else
  // one light read that names the author and nothing more (orgProposals.origin);
  // the full proposal, with its change rows, is the org page's to fetch. An
  // enrichment through useQueryNoThrow: with no answer the card still links
  // the proposal, and never waits on a name.
  const s = useTrackedStore([
    (st) => shortId ? Object.values(st.orgProposals as Record<string, OrgProposalListRow>).find((p) => p.short_id === shortId)?.author : undefined,
  ]);
  const cached = shortId ? Object.values(s.orgProposals as Record<string, OrgProposalListRow>).find((p) => p.short_id === shortId)?.author : undefined;
  const { data: origin, error } = useQueryNoThrow(api.orgProposals.origin, shortId && !cached ? { proposal: shortId } : "skip");
  if (!shortId) return null;
  const author: OrgProposalAuthor | undefined = cached ?? origin?.author;
  const settled = !!author || origin === null || !!error;
  return (
    <span className={cn("inline-flex items-center gap-1.5 min-w-0 flex-wrap", className)} data-proposal-origin={shortId} data-origin-state={author ? "named" : settled ? "unnamed" : "loading"}>
      {author && <span style={{ color: "var(--sol-text-dim)" }}>proposed by</span>}
      {author ? <ProposalAuthorPill author={author} size={size} /> : !settled ? <span className="italic" style={{ color: "var(--sol-text-dim)" }}>looking up {shortId}…</span> : <span style={{ color: "var(--sol-text-dim)" }}>proposal</span>}
      <Link href={`/org?proposal=${shortId}`} className="inline-flex items-center gap-0.5 hover:underline" style={{ color: "var(--sol-violet)", fontFamily: "var(--font-mono)" }} title="Open the proposal on the org page">{shortId}<ArrowUpRight className="w-3 h-3" /></Link>
    </span>
  );
}
