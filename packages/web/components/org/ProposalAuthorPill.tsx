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
import { useOrgRoles } from "../../hooks/useOrgRoles";
import { useQueryNoThrow } from "../../hooks/useQueryNoThrow";
import { useSyncOrgProposal } from "../../hooks/useSyncOrgProposals";
import { cn } from "../../lib/utils";
import { RoleAvatar } from "./avatars";
import type { OrgProposalAuthor, OrgProposalListRow } from "./orgStaffingTypes";
import { proposalRefInContext, resolveProposalAuthor, type ProposalAuthorView } from "./staffingModel";

const api = _api as any;

/** The author named from what this window knows. Subscribes to the one
 *  session row's title and short id, never the collection (CLAUDE.md store
 *  rules), and to the roles signature useOrgRoles keeps. */
export function useProposalAuthor(author: OrgProposalAuthor): ProposalAuthorView {
  const sessionId = author.kind === "session" ? author.id : null;
  // The row's short id is read loosely: InboxSession does not type it, the
  // server stamps it (the org page reads it the same way).
  const shortIdOf = (row: unknown) => (row as { short_id?: string } | undefined)?.short_id;
  const s = useTrackedStore([
    (st) => sessionId ? st.sessions[sessionId]?.title : undefined,
    (st) => sessionId ? shortIdOf(st.sessions[sessionId]) : undefined,
  ]);
  const { roles } = useOrgRoles();
  const roleRow = author.kind === "role" ? roles.find((r) => r._id === author.id) : undefined;
  // A role the tree does not carry (another workspace's, or no tree fed on
  // this page): the brief names it. Skipped whenever the tree or the server
  // already did.
  const needBrief = author.kind === "role" && !roleRow && !author.name;
  const { data: brief } = useQueryNoThrow(api.org.brief, needBrief ? { role_id: author.id } : "skip");
  const role = roleRow
    ? { name: roleRow.name, handle: roleRow.handle, short_id: roleRow.short_id, avatar: (roleRow as { avatar?: string }).avatar }
    : brief?.role
      ? { name: brief.role.name as string, handle: brief.role.handle as string, short_id: brief.role.short_id as string, avatar: brief.role.avatar as string | undefined }
      : null;
  const session = sessionId ? s.sessions[sessionId] : undefined;
  return resolveProposalAuthor(author, { session: session ? { title: session.title, short_id: shortIdOf(session) } : null, role });
}

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
  useSyncOrgProposal(shortId);
  const s = useTrackedStore([
    (st) => shortId ? Object.values(st.orgProposals as Record<string, OrgProposalListRow>).find((p) => p.short_id === shortId)?.author : undefined,
  ]);
  if (!shortId) return null;
  const row = Object.values(s.orgProposals as Record<string, OrgProposalListRow>).find((p) => p.short_id === shortId);
  return (
    <span className={cn("inline-flex items-center gap-1.5 min-w-0 flex-wrap", className)} data-proposal-origin={shortId}>
      <span style={{ color: "var(--sol-text-dim)" }}>proposed by</span>
      {row ? <ProposalAuthorPill author={row.author} size={size} /> : <span className="italic" style={{ color: "var(--sol-text-dim)" }}>looking up {shortId}…</span>}
      <Link href={`/org?proposal=${shortId}`} className="inline-flex items-center gap-0.5 hover:underline" style={{ color: "var(--sol-violet)", fontFamily: "var(--font-mono)" }} title="Open the proposal on the org page">{shortId}<ArrowUpRight className="w-3 h-3" /></Link>
    </span>
  );
}
