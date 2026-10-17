"use client";
// The org chart's one companion (docs/architecture/org-staffing.md S44): a
// drawer on the right of the chart, the Map's drawer from the line workspace
// (LineDrawer) so the two maps open things the same way. The chart stays in
// view on the left; the address holds what the drawer shows.
//
// - Nothing named: the Head of People. With none in the workspace, the offer
//   to hire one (a confirmed press: it starts an agent and its first review).
//   With one, its standing session's real conversation, the open proposals
//   pinned above it.
// - `?proposal=op-N`: that proposal, first and whole: its workspace, its card
//   with every control, pinned over the conversation its answers go to (the
//   author's thread, else the Head of People's), whose send applies them.
// - `?session=<id>`: a role's standing session or any session on the chart.
import { useMemo, type ReactNode } from "react";
import { ArrowLeft, ArrowUpRight } from "lucide-react";
import Link from "next/link";
import { isHeadOfPeopleRole } from "@codecast/shared/contracts/orgLead";
import { useInboxStore } from "../../store/inboxStore";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { useSyncOrgProposal, useSyncOrgProposals } from "../../hooks/useSyncOrgProposals";
import { useSwitchWorkspace } from "../../hooks/useSwitchWorkspace";
import { cn } from "../../lib/utils";
import { RevealInPlaceCtx, type RevealInPlace } from "../../lib/revealHost";
import { AnchorConversation, CenteredNote, HireHeadOfPeopleCard } from "../anchor/AnchorConversation";
import { EdgeResizeHandle } from "../../hooks/useEdgeResize";
import { LineDrawer } from "../line/workspace/stages/LineDrawer";
import "../line/workspace/workspace.css";
import { ProposalBody, ProposalMeta } from "./ProposalCard";
import { useProposalChanges } from "./proposalHooks";
import { RoleFace } from "./RoleFace";
import { Age, SuggestionSet } from "./SuggestionSet";
import { PinnedLead } from "./PinnedLead";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import type { OrgProposalListRow } from "./orgStaffingTypes";
import type { OrgTree } from "./orgTypes";

/** What the drawer shows, as the address names it. */
export type OrgPanelTarget = { kind: "home" } | { kind: "proposal"; ref: string; /** One of its changes, by seq. */ focus?: string } | { kind: "session"; id: string };

/** A proposal link (`/org?proposal=op-N[&focus=n]`) as the drawer's target, else null. */
function proposalTargetOf(href: string): Extract<OrgPanelTarget, { kind: "proposal" }> | null {
  if (!href.startsWith("/org?")) return null;
  const params = new URLSearchParams(href.slice("/org?".length));
  const ref = params.get("proposal");
  return ref ? { kind: "proposal", ref, ...(params.get("focus") ? { focus: params.get("focus")! } : {}) } : null;
}

/** A proposal row's workspace, as the reader's own teams name it. */
function proposalWorkspace(row: Pick<OrgProposalListRow, "team_id">, teams: ReadonlyArray<{ _id: unknown; name?: string }>): { teamId: string | null; name: string } {
  if (!row.team_id) return { teamId: null, name: "Personal" };
  return { teamId: row.team_id, name: teams.find((t) => String(t._id) === row.team_id)?.name ?? "Another workspace" };
}

const activeTeamOf = (tree: OrgTree | null) => (tree?.workspace.kind === "team" ? tree.workspace.id : null);

/** Find a proposal row by short id, whatever workspace fed it. */
function useProposalRow(ref: string | null): OrgProposalListRow | null {
  return useInboxStore((s) => (ref ? Object.values((s.orgProposals ?? {}) as Record<string, OrgProposalListRow>).find((p) => p.short_id === ref || p._id === ref) ?? null : null));
}

// The conversation the drawer embeds starts cold when the standing session is
// bucket-hidden: the minimal row lets the thread paint while its query answers.
function useSeedConversation(id: string | null) {
  useWatchEffect(() => {
    const st = useInboxStore.getState();
    if (id && !st.conversations[id] && !st.sessions[id]) st.syncRecord("conversations", id, { _id: id });
  }, [id]);
}

/** A thread in the drawer: the real conversation, folded to the agent talking to the person. */
function Thread({ id, placeholder, lead }: { id: string; placeholder?: string; lead?: ReactNode }) {
  useSeedConversation(id);
  return (
    <AnchorConversation
      key={id}
      conversationId={id}
      hideHeader
      hideDiff
      seedOwnership={false}
      foldBootstrap
      foldWorkingTurns
      initialDensity="condensed"
      stickyPrompt={false}
      composerPlaceholder={placeholder}
      leadNode={lead}
      leadPinned={!!lead}
    />
  );
}

function HeadIcon({ href, label }: { href: string; label: string }) {
  return (
    <Link href={href} className="lw-iconbtn" title={label} aria-label={label} data-org-panel-full>
      <ArrowUpRight className="w-4 h-4" aria-hidden />
    </Link>
  );
}

function Back({ onPress, label }: { onPress: () => void; label: string }) {
  return (
    <button type="button" className="lw-iconbtn" onClick={onPress} title={label} aria-label={label} data-org-panel-back>
      <ArrowLeft className="w-4 h-4" aria-hidden />
    </button>
  );
}

// ---------------------------------------------------------------- the proposal

/** The proposal itself: title, what waits or what happened, and its card with every control. A click on an entry focuses its change on the chart. */
function ProposalLead({ row, onFocusChange }: { row: OrgProposalListRow; onFocusChange: (changeId: string) => void }) {
  const changes = useProposalChanges(row._id);
  const now = useCoarseNow(60_000);
  return (
    <PinnedLead data-org-panel-proposal={row.short_id} data-proposal-status={row.status}>
      <div
        onClickCapture={(e) => {
          const t = e.target as HTMLElement;
          if (t.closest("button, a, input, textarea, select, [contenteditable=true]")) return;
          const id = t.closest<HTMLElement>("[data-change-ids]")?.dataset.changeIds?.split(" ")[0];
          if (id) onFocusChange(id);
        }}
      >
        <div className="flex items-baseline gap-3">
          <h2 className="m-0 min-w-0 flex-1 text-[16px] font-semibold leading-snug" style={{ color: "var(--sol-text)" }}>{row.title}</h2>
          <Age at={row.created_at} now={now} settled={row.status !== "open"} />
        </div>
        <ProposalMeta proposal={row} changes={changes} />
        <div className="mt-3"><ProposalBody proposal={row} changes={changes} /></div>
      </div>
    </PinnedLead>
  );
}

/** Where the proposal lives, named plainly, with the way there when it is not the workspace on screen. */
function WorkspaceLine({ row, tree }: { row: OrgProposalListRow; tree: OrgTree | null }) {
  const teams = useInboxStore((s) => s.teams) as Array<{ _id: unknown; name?: string }>;
  const switchWorkspace = useSwitchWorkspace();
  const where = proposalWorkspace(row, teams ?? []);
  const here = where.teamId === activeTeamOf(tree);
  return (
    <span className="flex min-w-0 items-center gap-2 text-[12.5px]" data-org-panel-workspace={where.name} data-org-panel-workspace-here={here || undefined}>
      <span className="font-mono text-[11.5px]" style={{ color: "var(--sol-violet)" }}>{row.short_id}</span>
      <span aria-hidden style={{ color: "var(--sol-text-dim)" }}>in</span>
      <span className={cn("truncate font-medium", !here && "rounded px-1.5 py-0.5")} style={here ? { color: "var(--sol-text)" } : { color: "var(--sol-orange)", background: "color-mix(in srgb, var(--sol-orange) 12%, transparent)" }}>{where.name}</span>
      {!here && (
        <button type="button" className="shrink-0 rounded-md border px-2 py-0.5 text-[12px] font-medium hover:bg-sol-bg-highlight" style={{ borderColor: "color-mix(in srgb, var(--sol-border) 45%, transparent)", color: "var(--sol-text)" }} onClick={() => void switchWorkspace(where.teamId)} data-org-panel-switch>
          Switch
        </button>
      )}
    </span>
  );
}

function ProposalView({ refId, tree, headConversation, onFocusChange }: { refId: string; tree: OrgTree | null; headConversation: string | null; onFocusChange: (changeId: string) => void }) {
  const { missing } = useSyncOrgProposal(refId);
  const row = useProposalRow(refId);
  if (!row) return <CenteredNote>{missing ? `${refId} is not a proposal you can read.` : "Loading the proposal…"}</CenteredNote>;
  // Answers go to the conversation that posted it; a person's proposal has none, and the Head of People's takes them.
  const thread = row.thread?.conversation_id ?? ((row.team_id ?? null) === activeTeamOf(tree) ? headConversation : null);
  const lead = <ProposalLead row={row} onFocusChange={onFocusChange} />;
  return thread ? <Thread id={thread} lead={lead} placeholder="Reply, or send your answers as they are" /> : <div className="h-full overflow-y-auto">{lead}</div>;
}

/** The Head of People's suggestions over its thread, as one set (SuggestionSet). */
function HomeLead({ tree, head, onOpen }: { tree: OrgTree; head: OrgTree["roles"][number]; onOpen: (ref: string) => void }) {
  useSyncOrgProposals();
  return <SuggestionSet workspace={tree.workspace} headRoleId={head._id} name={head.name} onOpen={onOpen} />;
}

// ---------------------------------------------------------------- the drawer

export function OrgPanel({ tree, target, onTarget, onClose, onFocusChange, onResizeDown, style }: {
  tree: OrgTree | null;
  target: OrgPanelTarget;
  onTarget: (t: OrgPanelTarget) => void;
  onClose: () => void;
  onFocusChange: (changeId: string) => void;
  onResizeDown?: (e: React.PointerEvent<HTMLElement>) => void;
  style?: React.CSSProperties;
}) {
  const head = tree?.roles.find((r) => isHeadOfPeopleRole(r)) ?? null;
  const headConversation = head?.standing?.conversation_id ?? null;
  const proposalRow = useProposalRow(target.kind === "proposal" ? target.ref : null);
  const sessionTitle = useInboxStore((s) => (target.kind === "session" ? ((s.conversations[target.id] ?? s.sessions[target.id]) as { title?: string } | undefined)?.title ?? null : null));
  const sessionRole = target.kind === "session" ? tree?.roles.find((r) => r.standing?.conversation_id === target.id) ?? null : null;
  const home = () => onTarget({ kind: "home" });

  let label: string;
  let nav: ReactNode;
  let body: ReactNode;
  if (target.kind === "proposal") {
    label = proposalRow?.title ?? target.ref;
    nav = (
      <>
        <Back onPress={home} label={head ? `Back to ${head.name}` : "Back"} />
        {proposalRow ? <WorkspaceLine row={proposalRow} tree={tree} /> : <span className="font-mono text-[11.5px]" style={{ color: "var(--sol-violet)" }}>{target.ref}</span>}
      </>
    );
    body = <ProposalView key={target.ref} refId={target.ref} tree={tree} headConversation={headConversation} onFocusChange={onFocusChange} />;
  } else if (target.kind === "session") {
    label = sessionRole?.name ?? sessionTitle ?? "Session";
    nav = (
      <>
        <Back onPress={home} label={head ? `Back to ${head.name}` : "Back"} />
        {sessionRole && <RoleFace role={sessionRole} size={22} />}
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold" style={{ color: "var(--sol-text)" }}>{label}</span>
        <HeadIcon href={`/conversation/${target.id}`} label="Open the full conversation" />
      </>
    );
    body = <Thread id={target.id} placeholder={sessionRole ? `Ask ${sessionRole.name}` : undefined} />;
  } else if (!tree) {
    label = "Org";
    nav = null;
    body = <CenteredNote>Loading the org…</CenteredNote>;
  } else if (!head) {
    label = "Hire the Head of People";
    nav = <span className="text-[13px] font-semibold" style={{ color: "var(--sol-text)" }}>{tree.workspace.name}</span>;
    body = <div className="h-full overflow-y-auto py-6" data-org-panel-hire><HireHeadOfPeopleCard compact /></div>;
  } else {
    label = head.name;
    nav = (
      <>
        <RoleFace role={head} size={22} />
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold" style={{ color: "var(--sol-text)" }}>{head.name}</span>
        {headConversation && <HeadIcon href={`/conversation/${headConversation}`} label="Open the full conversation" />}
      </>
    );
    body = headConversation
      ? <Thread id={headConversation} placeholder={`Ask ${head.name}`} lead={<HomeLead tree={tree} head={head} onOpen={(ref) => onTarget({ kind: "proposal", ref })} />} />
      : <CenteredNote>{head.name} has not started yet. Its conversation appears here when it does.</CenteredNote>;
  }
  // A proposal referenced in the drawer's own thread opens here, in the drawer, never as a band redrawing the page inside it.
  const inPlace = useMemo<RevealInPlace>(() => ({
    claims: (href) => !!proposalTargetOf(href),
    isOpen: (href) => target.kind === "proposal" && proposalTargetOf(href)?.ref === target.ref,
    toggle: (href) => {
      const t = proposalTargetOf(href);
      if (t) onTarget(target.kind === "proposal" && t.ref === target.ref ? { kind: "home" } : t);
    },
  }), [target, onTarget]);
  return (
    <div className="lw-widget contents" style={style} data-org-panel={target.kind}>
      <LineDrawer label={label} onClose={onClose} nav={nav} edge={onResizeDown && <EdgeResizeHandle onResizeDown={onResizeDown} />}><RevealInPlaceCtx.Provider value={inPlace}>{body}</RevealInPlaceCtx.Provider></LineDrawer>
    </div>
  );
}
