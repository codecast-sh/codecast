"use client";
// The body of a proposal card in a conversation (docs/architecture/org-staffing.md
// S24, S39): the head of people writes `op-N` on its own line and the message
// draws the proposal live as a ledger: the letter, then one entry per subject
// (a plain sentence, the fields it moves with what was there before, the
// reason, Approve, Reject and Reply), then a closing row with Chart, Approve
// the rest, Reply and, once anything is answered, Send. The frame is the
// shared object card (EntityObjectCard); these are the pieces it composes.
//
// Store-fed like the org page: the row and its changes come from the
// orgProposals and orgProposalChanges collections (useEntityResolution mounts
// the feeder), the live records a before is read from through useSubjectLive.
// An answer goes into this conversation's pending batch (the composer bridge
// names it) and the send applies it; nothing is decided on a press.
import React, { useMemo } from "react";
import { Check } from "lucide-react";
import { stripMarkdown } from "@codecast/shared/contracts/plainText";
import { cn } from "../../lib/utils";
import { ProposalAuthorPill } from "./ProposalAuthorPill";
import { GhostTag, StatusPill } from "./ghostChrome";
import { CHIP_STATUS, GHOST } from "./orgMeta";
import { CHANGE_STATUS_META } from "./staffingModel";
import { letterParts } from "./staffingAsks";
import { proposalProgressWords } from "./proposalSubjects";
import type { ProposalTreeRow } from "./proposalTree";
import type { OrgProposalChange, OrgProposalListRow } from "./orgStaffingTypes";
import type { OrgTree } from "./orgTypes";
import { Face, LEDGER_INKS } from "./ProposalSubjectCard";
import { ProposalClosingRow, ProposalLoading, ProposalSubjectList, useProposalCards } from "./ProposalLedger";

// The faces are drawn where the ledger entry lives, so a card never imports
// this file back; they are exported from here as they always were.
export { Face };

// ---------------------------------------------------------------- the meta line

/** A count of failures is the line's one coloured run. */
export function ProgressWords({ words }: { words: string }) {
  const parts = words.split(/(\d+ failed)/);
  return <>{parts.map((part, i) => (i % 2 ? <span key={i} className="text-[color:var(--ink-red)]">{part}</span> : part))}</>;
}

/** Under the title: what waits or what happened, counted in the cards a
 *  person sees, and who proposed it. "9 to decide"; mid way "5 of 9 to decide
 *  · 2 approved, 1 rejected, 1 failed"; "7 approved, 2 rejected" once nothing
 *  waits. */
export function ProposalMeta({ proposal, changes }: { proposal: OrgProposalListRow; changes: readonly OrgProposalChange[] }) {
  const cards = useProposalCards(proposal, changes);
  const total = proposal.counts?.total ?? 0;
  // Before the changes land there is nothing to count but what the row says.
  const words = proposal.status === "withdrawn" ? "withdrawn" : proposalProgressWords(cards) || (total ? `${total} ${total === 1 ? "change" : "changes"}` : "proposal");
  const [count, decided] = words.split(" · ");
  return (
    <div className={cn("not-prose mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[11px] leading-snug text-[color:var(--ink-quiet)]", LEDGER_INKS)} data-proposal-meta={words}>
      <span className="whitespace-nowrap text-[color:var(--sol-text-muted)]"><ProgressWords words={count} /></span>
      {decided && (
        <>
          <span aria-hidden>·</span>
          <span><ProgressWords words={decided} /></span>
          <span aria-hidden>·</span>
        </>
      )}
      <span className="inline-flex min-w-0 items-center gap-1">
        <span>from</span>
        <ProposalAuthorPill author={proposal.author} size="sm" />
      </span>
    </div>
  );
}

// ---------------------------------------------------------------- the tree's node line

const tagStatus = (status: ProposalTreeRow["status"]) => (status === "failed" ? "failed" : status === "accepted" || status === "applied" ? status : status === "skipped" ? "skipped" : "proposed");

/** One node as the tree draws it: the face, the name in the ghost's frame
 *  while proposed, the row's tag, and the delta chip when the change is not
 *  an edge. A retire is hatched and struck; a record being closed is struck;
 *  a skipped row is struck and dim. */
export function NodeLine({ row }: { row: ProposalTreeRow }) {
  const status = tagStatus(row.status);
  const proposed = row.status === "proposed" || row.status === "failed";
  const retire = row.kind === "retire";
  const struck = retire || !!row.closes || row.status === "skipped";
  // A goal's unresolved owner is drawn on the owner, not on the goal.
  const nodeUnresolved = row.unresolved && !row.owner;
  // A goal row is a line of text under its parent, not a ghost card: the
  // flag carries the proposed colour, so a tree of goals is not a wall of dashes.
  const goal = row.node.kind === "goal";
  const m = nodeUnresolved ? CHIP_STATUS.failed : CHIP_STATUS[row.status];
  const name = row.node.name;
  return (
    <span className="flex min-w-0 items-center gap-1.5 [&>*:not(:first-child)]:shrink-0">
      <span
        className="inline-flex min-w-0 shrink items-center gap-1.5 rounded-md py-[2px] pl-[3px] pr-2"
        style={{ border: proposed && !retire && !goal ? m.border : "1.5px solid transparent", background: retire ? GHOST.hatch : proposed && !goal ? GHOST.fill : "transparent" }}
        title={row.line}
        data-tree-node={row.node.kind}
        data-tree-node-id={row.node.id}
      >
        <Face face={row.node} dim={proposed && !retire} />
        <span className={cn("truncate text-[12px] font-medium leading-tight", struck && "line-through")} style={{ color: struck ? "var(--sol-text-dim)" : "var(--sol-text)", opacity: proposed && !retire && !goal ? 0.85 : 1 }}>{name}</span>
        {row.node.kind === "role" && <span className="truncate text-[10px] text-sol-text-dim">@{row.node.handle}</span>}
        {row.node.kind === "session" && <span className="truncate font-mono text-[10px] text-sol-text-dim">{row.node.short_id}</span>}
        {row.node.kind === "goal" && row.node.short_id && <span className="truncate font-mono text-[10px] text-sol-text-dim">{row.node.short_id}</span>}
      </span>
      <GhostTag quiet={goal} label={nodeUnresolved ? "unknown" : row.tag} status={nodeUnresolved ? "failed" : status} tone={status !== "proposed" ? undefined : retire ? "color-mix(in srgb, var(--sol-red) 70%, var(--sol-text))" : row.closes ? (row.closes === "done" ? "var(--sol-green)" : "color-mix(in srgb, var(--sol-red) 70%, var(--sol-text))") : undefined} />
      {row.status !== "proposed" && row.status !== "applied" && row.status !== "accepted" && <StatusPill status={row.status} />}
      {(row.status === "applied" || row.status === "accepted") && (
        <span className="inline-flex items-center gap-0.5 text-[10px] font-medium" style={{ color: CHANGE_STATUS_META[row.status].color }} data-tree-status={row.status}>
          <Check className="h-3 w-3" /> {row.status}
        </span>
      )}
      {row.owner && (
        <span className="inline-flex min-w-0 !shrink items-center gap-1 text-[10.5px] text-sol-text-dim" data-tree-owner={row.owner.id}>
          <Face face={row.owner} size={14} />
          <span className="truncate" style={row.unresolved ? { color: CHIP_STATUS.failed.color } : undefined}>{row.owner.name}</span>
        </span>
      )}
      {row.chip && <span className="min-w-0 !shrink truncate text-[11px]" style={{ color: proposed ? GHOST.color : "var(--sol-text-muted)" }} data-tree-chip>{row.chip}</span>}
    </span>
  );
}

// ---------------------------------------------------------------- the bodies

/** The letter, the entries on hairlines, the closing row. */
function LedgerBody({ proposal, changes, letter, limit, compact }: { proposal: OrgProposalListRow; changes: readonly OrgProposalChange[]; letter: React.ReactNode; limit?: number; compact?: boolean }) {
  const cards = useProposalCards(proposal, changes);
  return (
    <div className={cn("not-prose min-w-0", LEDGER_INKS)} data-proposal-ledger={cards.length}>
      {letter}
      {changes.length === 0 ? <ProposalLoading /> : (
        <>
          <ProposalSubjectList proposal={proposal} cards={cards} limit={limit} variant={compact ? "row" : "full"} />
          <ProposalClosingRow proposal={proposal} cards={cards} />
        </>
      )}
    </div>
  );
}

/** The collapsed card: the letter's lead, the first twelve entries, the
 *  closing row. Sharing a row with other cards it is a tile: three one line
 *  entries. */
export function ProposalSnippet({ proposal, changes, compact }: { proposal: OrgProposalListRow; changes: readonly OrgProposalChange[]; tree?: OrgTree | null; href?: string; compact: boolean }) {
  const lead = useMemo(() => stripMarkdown(letterParts(proposal.summary_md).lead, { keepNewlines: true }), [proposal.summary_md]);
  const letter = lead ? <p className={cn("m-0 mt-0.5 max-w-[70ch] whitespace-pre-line text-[color:var(--sol-text-secondary)]", compact ? "mb-2 line-clamp-2 text-[12px] leading-[1.5]" : "mb-3.5 line-clamp-4 text-[13px] leading-[1.6]")} data-proposal-letter>{lead}</p> : null;
  return <LedgerBody proposal={proposal} changes={changes} letter={letter} limit={compact ? 3 : 12} compact={compact} />;
}

/** The expanded card: the whole letter and every entry. It differs from the
 *  collapsed one in nothing else. */
export function ProposalDetail({ proposal, changes, summary }: { proposal: OrgProposalListRow; changes: readonly OrgProposalChange[]; tree?: OrgTree | null; href?: string; summary: React.ReactNode }) {
  const letter = summary ? <div className="mb-3.5 mt-0.5 max-w-[70ch] leading-[1.6] text-[color:var(--sol-text-secondary)]" data-proposal-letter>{summary}</div> : null;
  return <LedgerBody proposal={proposal} changes={changes} letter={letter} />;
}
