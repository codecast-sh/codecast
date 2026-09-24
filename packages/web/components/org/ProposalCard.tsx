"use client";
// The body of a proposal card in a conversation (docs/architecture/org-staffing.md
// S24): the chief of staff writes `op-N` on its own line and the message draws
// the proposal live — its changes as a small tree in the chart's own faces and
// ghost chrome, their status, and Accept, Skip and Ask. The frame is the
// shared object card (EntityObjectCard); these are the pieces it composes.
//
// Store-fed like the org page: the row and its changes come from the
// orgProposals and orgProposalChanges collections (useEntityResolution mounts
// the feeder), the tree from the orgTree singleton. A verdict is the same
// store action the page runs (acceptAllOrgProposal, decideOrgProposalChange,
// with the seen stamp), so it paints at once and a refusal puts it back.
import React, { useCallback, useMemo } from "react";
import Link from "next/link";
import { AlertTriangle, Check, MessageSquareText, Sparkles, X } from "lucide-react";
import { describeOrgChange, editedOrgChange, isOrgQuietChange, latestOrgRevisionAt, isOrgChangeDecidable, withAboutProposal, type OrgVerdictSeen } from "@codecast/shared/contracts/orgProposal";
import { useInboxStore } from "../../store/inboxStore";
import { useSyncOrgTree } from "../../hooks/useSyncOrgTree";
import { useReviewComposer } from "../reviewContext";
import { focusComposer } from "../../lib/composerControl";
import { cn } from "../../lib/utils";
import { Avatar } from "../tasks/TaskCommentStream";
import { RoleFace } from "./RoleFace";
import { OrgButton } from "./OrgButton";
import { ProposalAuthorPill } from "./ProposalAuthorPill";
import { CHIP_STATUS, GhostTag, QuietLines, StatusPill } from "./ghostChrome";
import { GHOST } from "./orgMeta";
import { proposalWorkspace, sameWorkspace, CHANGE_STATUS_META } from "./staffingModel";
import { proposalOutcome, proposalTreeRows, type ProposalTreeFace, type ProposalTreeRow } from "./proposalTree";
import type { OrgProposalChange, OrgProposalListRow } from "./orgStaffingTypes";
import type { OrgTree } from "./orgTypes";

// ---------------------------------------------------------------- store reads

const changesSig = (all: Record<string, OrgProposalChange>, proposalId: string): string => {
  let sig = "";
  for (const c of Object.values(all)) if (c.proposal_id === proposalId) sig += `${c._id}:${c.status}:${c.revision?.at ?? 0}:${c.applied_note ?? ""}|`;
  return sig;
};

/** A proposal's changes from the store, re-read only when one of them moves
 *  (a signature, never the collection: CLAUDE.md store rules). */
export function useProposalChanges(proposalId: string | undefined): OrgProposalChange[] {
  const sig = useInboxStore((s) => (proposalId ? changesSig(s.orgProposalChanges, proposalId) : ""));
  return useMemo(() => {
    if (!proposalId) return [];
    return Object.values(useInboxStore.getState().orgProposalChanges).filter((c) => c.proposal_id === proposalId).sort((a, b) => a.seq - b.seq);
  }, [sig, proposalId]); // eslint-disable-line react-hooks/exhaustive-deps
}

/** The org tree the proposal's changes are drawn against: the active
 *  workspace's, when the proposal belongs to it. A proposal from another
 *  workspace draws faceless rows rather than the wrong people. */
export function useProposalTree(proposal: Pick<OrgProposalListRow, "team_id" | "scope_user_id"> | undefined): OrgTree | null {
  const { tree } = useSyncOrgTree();
  if (!tree || !proposal) return null;
  return sameWorkspace(proposalWorkspace(proposal), tree.workspace) ? tree : null;
}

/** What the card showed when a verdict was pressed (S18): the latest revise
 *  and the rows still waiting, so the server refuses a verdict on a change
 *  revised under the reader. */
export function proposalSeen(changes: readonly OrgProposalChange[]): OrgVerdictSeen {
  return { revised_at: latestOrgRevisionAt(changes), seqs: changes.filter((c) => isOrgChangeDecidable(c.status)).map((c) => c.seq) };
}

// ---------------------------------------------------------------- the meta line

/** Under the title: what waits or what happened, and who proposed it. */
export function ProposalMeta({ proposal, changes }: { proposal: OrgProposalListRow; changes: readonly OrgProposalChange[] }) {
  const waiting = changes.filter((c) => isOrgChangeDecidable(c.status)).length;
  const failed = changes.filter((c) => c.status === "failed").length;
  const outcome = proposalOutcome(changes);
  const total = changes.length || proposal.counts?.total || 0;
  let word: string;
  let color: string;
  if (proposal.status === "withdrawn") { word = "withdrawn"; color = "var(--sol-text-dim)"; }
  else if (failed > 0) { word = `${failed} failed`; color = CHANGE_STATUS_META.failed.color; }
  else if (waiting > 0) { word = `${waiting} of ${total} to decide`; color = GHOST.color; }
  else if (outcome) { word = outcome; color = changes.some((c) => c.status === "applied" || c.status === "accepted") ? "var(--sol-green)" : "var(--sol-text-dim)"; }
  else { word = total ? `${total} ${total === 1 ? "change" : "changes"}` : "proposal"; color = "var(--sol-text-dim)"; }
  return (
    <div className="not-prose mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[11px] leading-snug text-sol-text-dim" data-proposal-meta={word}>
      <span className="whitespace-nowrap font-medium" style={{ color }}>{word}</span>
      <span className="inline-flex min-w-0 items-center gap-1">
        <span>from</span>
        <ProposalAuthorPill author={proposal.author} size="sm" />
      </span>
    </div>
  );
}

// ---------------------------------------------------------------- the tree

function Face({ face, size = 20, dim }: { face: ProposalTreeFace; size?: number; dim?: boolean }) {
  const style = dim ? { opacity: GHOST.opacity } : undefined;
  if (face.kind === "person") {
    return (
      <span className="inline-flex shrink-0 rounded-full p-[1.5px]" style={{ background: face.me ? "linear-gradient(135deg, var(--sol-cyan), var(--sol-blue))" : "color-mix(in srgb, var(--sol-border) 45%, transparent)", ...style }} data-face="person">
        <span className="inline-flex rounded-full p-[1px]" style={{ background: "var(--sol-card)" }}><Avatar name={face.name} image={face.image} size="sm" /></span>
      </span>
    );
  }
  if (face.kind === "role") return <span className="inline-flex shrink-0" style={style} data-face="role"><RoleFace role={{ handle: face.handle, name: face.name, avatar: face.avatar }} size={size} /></span>;
  if (face.kind === "session") {
    return (
      <span className="inline-flex shrink-0 items-center justify-center rounded-md" style={{ width: size, height: size, background: GHOST.fill, color: GHOST.color, ...style }} data-face="session">
        <Sparkles className="h-3 w-3" />
      </span>
    );
  }
  return (
    <span className="inline-flex shrink-0 items-center justify-center rounded-full" style={{ width: size, height: size, border: CHIP_STATUS.failed.border, color: CHIP_STATUS.failed.color, ...style }} data-face="unknown">
      <AlertTriangle className="h-3 w-3" />
    </span>
  );
}

const tagStatus = (status: ProposalTreeRow["status"]) => (status === "failed" ? "failed" : status === "accepted" || status === "applied" ? status : status === "skipped" ? "skipped" : "proposed");

/** One node as the tree draws it: the face, the name in the ghost's frame
 *  while proposed, the row's tag, and the delta chip when the change is not
 *  an edge. A retire is hatched and struck; a skipped row is struck and dim. */
function NodeLine({ row }: { row: ProposalTreeRow }) {
  const status = tagStatus(row.status);
  const proposed = row.status === "proposed" || row.status === "failed";
  const retire = row.kind === "retire";
  const struck = retire || row.status === "skipped";
  const m = row.unresolved ? CHIP_STATUS.failed : CHIP_STATUS[row.status];
  const name = row.node.kind === "role" ? row.node.name : row.node.name;
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1">
      <span
        className="inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-md py-[2px] pl-[3px] pr-2"
        style={{ border: proposed && !retire ? m.border : "1.5px solid transparent", background: retire ? GHOST.hatch : proposed ? GHOST.fill : "transparent" }}
        title={row.line}
        data-tree-node={row.node.kind}
        data-tree-node-id={row.node.id}
      >
        <Face face={row.node} dim={proposed && !retire} />
        <span className={cn("truncate text-[12px] font-medium leading-tight", struck && "line-through")} style={{ color: struck ? "var(--sol-text-dim)" : "var(--sol-text)", opacity: proposed && !retire ? 0.85 : 1 }}>{name}</span>
        {row.node.kind === "role" && <span className="truncate text-[10px] text-sol-text-dim">@{row.node.handle}</span>}
        {row.node.kind === "session" && <span className="truncate font-mono text-[10px] text-sol-text-dim">{row.node.short_id}</span>}
      </span>
      <GhostTag label={row.unresolved ? "unknown" : row.tag} status={row.unresolved ? "failed" : status} tone={retire && status === "proposed" ? "color-mix(in srgb, var(--sol-red) 70%, var(--sol-text))" : undefined} />
      {row.status !== "proposed" && row.status !== "applied" && row.status !== "accepted" && <StatusPill status={row.status} />}
      {(row.status === "applied" || row.status === "accepted") && (
        <span className="inline-flex items-center gap-0.5 text-[10px] font-medium" style={{ color: CHANGE_STATUS_META[row.status].color }} data-tree-status={row.status}>
          <Check className="h-3 w-3" /> {row.status}
        </span>
      )}
      {row.chip && <span className="truncate text-[11px]" style={{ color: proposed ? GHOST.color : "var(--sol-text-muted)" }} data-tree-chip>{row.chip}</span>}
    </span>
  );
}

/** A parent line and, under an L-shaped dashed connector, the rows that land
 *  beneath it. Rows with the same parent share the line; a row with none (a
 *  retire, a chip on its subject) stands alone. */
function ParentLine({ face }: { face: ProposalTreeFace }) {
  return (
    <span className="flex min-w-0 items-center gap-1.5" data-tree-parent={face.id}>
      <Face face={face} size={18} />
      <span className="truncate text-[11.5px] leading-tight text-sol-text-muted">{face.name}</span>
      {face.kind === "role" && <span className="truncate text-[10px] text-sol-text-dim">@{face.handle}</span>}
    </span>
  );
}

export function ProposalTreeView({ rows, className }: { rows: ProposalTreeRow[]; className?: string }) {
  // Group consecutive rows under one parent so the parent is drawn once.
  const groups: { parent: ProposalTreeFace | null; rows: ProposalTreeRow[] }[] = [];
  for (const row of rows) {
    const last = groups.at(-1);
    if (last && ((last.parent === null && row.parent === null) || (last.parent && row.parent && last.parent.kind === row.parent.kind && last.parent.id === row.parent.id))) last.rows.push(row);
    else groups.push({ parent: row.parent, rows: [row] });
  }
  if (groups.length === 0) return null;
  return (
    // not-prose: the card sits inside a message body, whose prose styles give
    // every img a 2em margin and would push a face out of its clipped box.
    <div className={cn("not-prose space-y-1.5", className)} data-proposal-tree={rows.length}>
      {groups.map((g, i) => (
        <div key={i} className="min-w-0" data-tree-group>
          {g.parent && <ParentLine face={g.parent} />}
          <div className={cn("min-w-0 space-y-1", g.parent && "pl-[9px]")}>
            {g.rows.map((row) => (
              <div key={row.change_id} className="flex min-w-0 items-start gap-1" data-tree-row={row.change_id} data-tree-kind={row.kind} data-tree-status={row.status}>
                {g.parent && <span aria-hidden className="mt-[3px] h-[13px] w-[9px] shrink-0 rounded-bl-[4px] border-b border-l border-dashed" style={{ borderColor: row.status === "proposed" || row.status === "failed" ? `color-mix(in srgb, ${GHOST.color} 70%, transparent)` : "color-mix(in srgb, var(--sol-border) 80%, transparent)" }} />}
                <div className="min-w-0 flex-1">
                  <NodeLine row={row} />
                  {row.from && (
                    <span className="mt-0.5 flex items-center gap-1 pl-1 text-[10.5px]" style={{ color: "var(--sol-text-dim)", opacity: 0.8 }} data-tree-from={row.from.id}>
                      <span>was under</span>
                      <Face face={row.from} size={14} dim />
                      <span className="truncate">{row.from.name}</span>
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- the verdicts

/** Accept, Skip and Ask. Accept and Skip are the page's own store actions on
 *  every change still waiting; Ask puts the proposal in this thread's
 *  composer as the next message (the org page's about-header), or, where no
 *  composer is in reach (a doc, team chat), opens the proposal on the org
 *  page beside its own thread. Once nothing waits the row says what happened. */
export function ProposalActions({ proposal, changes, href, className }: { proposal: OrgProposalListRow; changes: readonly OrgProposalChange[]; href: string; className?: string }) {
  const waiting = changes.filter((c) => isOrgChangeDecidable(c.status));
  const failed = waiting.some((c) => c.status === "failed");
  const composer = useReviewComposer();
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();
  const accept = useCallback(() => {
    useInboxStore.getState().acceptAllOrgProposal(proposal._id, { seen: proposalSeen(changes) });
  }, [proposal._id, changes]);
  const skip = useCallback(() => {
    const seen = proposalSeen(changes);
    const st = useInboxStore.getState();
    for (const c of changes) if (isOrgChangeDecidable(c.status)) st.decideOrgProposalChange(c._id, "skip", undefined, seen);
  }, [changes]);
  const ask = useCallback(() => {
    composer?.populate?.(withAboutProposal("", proposal.short_id, proposal.title));
    focusComposer();
  }, [composer, proposal.short_id, proposal.title]);
  const askNode = composer?.populate
    ? <OrgButton size="sm" onClick={ask} aria-label="Ask about this proposal" data-ask-about><MessageSquareText className="h-3 w-3" /> Ask</OrgButton>
    : <Link href={href} className="inline-flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-[12px] font-medium no-underline hover:bg-sol-bg-highlight/70" style={{ borderColor: "color-mix(in srgb, var(--sol-border) 40%, transparent)", color: "var(--sol-text-muted)" }} aria-label="Ask about this proposal" data-ask-about><MessageSquareText className="h-3 w-3" /> Ask</Link>;
  const outcome = proposalOutcome(changes);
  return (
    <div className={cn("not-prose flex flex-wrap items-center gap-1.5", className)} onClick={stop} onKeyDown={stop} onPointerDown={stop} data-proposal-actions={waiting.length}>
      {waiting.length > 0 ? (
        <>
          <OrgButton primary size="sm" onClick={accept} aria-label={failed ? "Retry" : "Accept"} data-accept><Check className="h-3 w-3" /> {failed ? "Retry" : "Accept"}</OrgButton>
          <OrgButton size="sm" onClick={skip} aria-label="Skip" data-skip><X className="h-3 w-3" /> Skip</OrgButton>
          {waiting.length > 1 && <span className="mr-1 text-[10.5px] text-sol-text-dim">all {waiting.length}</span>}
          {askNode}
        </>
      ) : (
        <span className="inline-flex items-center gap-1 text-[11.5px] font-medium" style={{ color: proposal.status === "withdrawn" ? "var(--sol-text-dim)" : changes.some((c) => c.status === "applied" || c.status === "accepted") ? "var(--sol-green)" : "var(--sol-text-dim)" }} data-proposal-outcome>
          {proposal.status === "withdrawn" ? "Withdrawn" : outcome ? <><Check className="h-3 w-3" /> {outcome}</> : "Nothing to decide"}
        </span>
      )}
      {waiting.length === 0 && askNode}
    </div>
  );
}

// ---------------------------------------------------------------- the bodies

/** The collapsed card: the tree, then the verdicts. The rows are the same
 *  merge the chart draws (proposalTreeRows over ghostsFor). */
export function ProposalSnippet({ proposal, changes, tree, href, compact }: { proposal: OrgProposalListRow; changes: readonly OrgProposalChange[]; tree: OrgTree | null; href: string; compact: boolean }) {
  const rows = useMemo(() => proposalTreeRows(tree, changes), [tree, changes]);
  const shown = compact ? rows.slice(0, 3) : rows;
  const failedNote = changes.find((c) => c.status === "failed" && c.applied_note)?.applied_note;
  const quietOnly = rows.length === 0 && changes.some((c) => c.status !== "removed");
  return (
    <div className="space-y-2">
      {rows.length > 0 ? (
        <>
          <ProposalTreeView rows={shown} />
          {shown.length < rows.length && <div className="text-[10.5px] text-sol-text-dim">and {rows.length - shown.length} more</div>}
        </>
      ) : quietOnly ? (
        <QuietLines tree={tree} changes={changes} />
      ) : (
        <div className="space-y-1.5" aria-hidden data-proposal-loading>
          <div className="h-2 w-2/3 animate-pulse rounded bg-[color-mix(in_srgb,var(--sol-border)_55%,transparent)]" />
          <div className="h-2 w-1/3 animate-pulse rounded bg-[color-mix(in_srgb,var(--sol-border)_55%,transparent)]" />
        </div>
      )}
      {failedNote && <p className="text-[11px] leading-snug" style={{ color: CHANGE_STATUS_META.failed.color }} data-failed-note>{failedNote}</p>}
      {changes.length > 0 && <ProposalActions proposal={proposal} changes={changes} href={href} />}
    </div>
  );
}

/** The expanded card: the letter, every change with its rationale, the verdicts. */
export function ProposalDetail({ proposal, changes, tree, href, summary }: { proposal: OrgProposalListRow; changes: readonly OrgProposalChange[]; tree: OrgTree | null; href: string; summary: React.ReactNode }) {
  const rows = useMemo(() => proposalTreeRows(tree, changes), [tree, changes]);
  return (
    <div className="space-y-2.5">
      {summary}
      {rows.length > 0 ? <ProposalTreeView rows={rows} /> : <QuietLines tree={tree} changes={changes} />}
      {changes.length > 0 && (
        <div className="space-y-1.5 border-t border-[color-mix(in_srgb,var(--sol-border)_55%,transparent)] pt-2" data-proposal-rationale>
          {changes.filter((c) => c.status !== "removed" && !isOrgQuietChange(c.change)).map((c) => (
            <div key={c._id} className="text-[12px] leading-relaxed" data-change-row={c._id}>
              <p className="text-[11px] font-medium leading-snug text-sol-text" data-change-line>{describeOrgChange(editedOrgChange(c.change, c.edits))}</p>
              <p className="text-sol-text-muted">{c.rationale}</p>
              {c.applied_note && <p className="text-[11px]" style={{ color: c.status === "failed" ? CHANGE_STATUS_META.failed.color : "var(--sol-green)" }}>{c.applied_note}</p>}
            </div>
          ))}
        </div>
      )}
      {changes.length > 0 && <ProposalActions proposal={proposal} changes={changes} href={href} />}
    </div>
  );
}
