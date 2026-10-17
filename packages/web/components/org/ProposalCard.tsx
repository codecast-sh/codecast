"use client";
// The body of a proposal card in a conversation (docs/architecture/org-staffing.md
// S24, S39): the head of people writes `op-N` on its own line and the message
// draws the proposal live: the letter's lead, a totals line, then one entry
// per subject (or one row per record group), then the foot with Map and
// Approve the rest. The frame is the shared object card (EntityObjectCard);
// these are the pieces it composes.
//
// Store-fed like the org page: the row and its changes come from the
// orgProposals and orgProposalChanges collections (useEntityResolution mounts
// the feeder), the live records a before is read from through useSubjectLive.
// An answer goes into this conversation's pending batch (the composer bridge
// names it) and the send applies it; nothing is decided on a press.
import React from "react";
import { cn } from "../../lib/utils";
import { MarkdownRenderer } from "../tools/MarkdownRenderer";
import { ProposalAuthorPill } from "./ProposalAuthorPill";
import { proposalProgressWords } from "./proposalSubjects";
import type { OrgProposalChange, OrgProposalListRow } from "./orgStaffingTypes";
import { LEDGER_INKS } from "./ProposalSubjectCard";
import { ProposalEntries, ProposalFoot, ProposalLoading, useProposalBatch, useProposalEntries } from "./ProposalLedger";

// ---------------------------------------------------------------- the meta line

/** A count of failures is the line's one coloured run. */
export function ProgressWords({ words }: { words: string }) {
  const parts = words.split(/(\d+ failed)/);
  return <>{parts.map((part, i) => (i % 2 ? <span key={i} className="text-[color:var(--ink-red)]">{part}</span> : part))}</>;
}

/** Under the title: what waits or what happened, and who proposed it. Cards
 *  are counted for a structure or goals proposal ("2 to decide", "1 of 2 to
 *  decide · 1 approved", "2 approved"); records count the records ("64
 *  records to decide", "62 applied, 2 rejected"). Before the changes land,
 *  the row's own count. */
export function ProposalMeta({ proposal, changes }: { proposal: OrgProposalListRow; changes: readonly OrgProposalChange[] }) {
  const entries = useProposalEntries(proposal, changes);
  const total = proposal.counts?.total ?? 0;
  const words = proposal.status === "withdrawn" ? "withdrawn" : proposalProgressWords(entries.cards, entries.records ? changes : undefined) || (total ? `${total} ${total === 1 ? "change" : "changes"}` : "proposal");
  const [count, decided] = words.split(" · ");
  return (
    <div className={cn("not-prose mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[11px] leading-snug text-[color:var(--ink-quiet)]", LEDGER_INKS)} data-proposal-meta={words}>
      <span className="whitespace-nowrap text-[color:var(--sol-text-muted)]"><ProgressWords words={count} /></span>
      {decided && (
        <>
          <span aria-hidden>·</span>
          <span><ProgressWords words={decided} /></span>
        </>
      )}
      {/* The separator travels with "from": a wrapped author pill never leaves a dot dangling at a line's end. */}
      <span className="inline-flex min-w-0 items-center gap-1">
        {decided && <span aria-hidden className="mr-1">·</span>}
        <span>from</span>
        <ProposalAuthorPill author={proposal.author} size="sm" withHandle={false} />
      </span>
    </div>
  );
}

// ---------------------------------------------------------------- the body

/**
 * The card's body: the author's summary (what this proposal is and why, the
 * context a person decides in), the totals line, the entries, the foot.
 * `compact` is a tile sharing a row with other cards: the summary clamped
 * and the totals only. `onMap`
 * opens the map beside the conversation; absent, the card opens the org
 * screen itself, unless it already sits on it (the screen feeds the hover
 * channel, so a card that can light the map needs no Map word).
 */
export function ProposalBody({ proposal, changes, compact, onMap }: {
  proposal: OrgProposalListRow;
  changes: readonly OrgProposalChange[];
  compact?: boolean;
  onMap?: () => void;
}) {
  const entries = useProposalEntries(proposal, changes);
  const batch = useProposalBatch(proposal);
  const map = onMap;
  const readonly = !batch.key || proposal.status !== "open";
  // One record group carries the proposal's totals itself.
  const totals = entries.records && entries.groups.length === 1 ? null : entries.totals.line;
  return (
    <div className={cn("not-prose min-w-0", LEDGER_INKS)} data-proposal-card={proposal.short_id} data-proposal-work={entries.work ?? undefined} data-proposal-readonly={readonly || undefined}>
      {changes.length === 0 ? <ProposalLoading /> : (
        <>
          {proposal.summary_md?.trim() && (
            <div className={cn("mb-2.5 text-[13px] leading-[20px] text-[color:var(--sol-text-secondary)] [&_p]:my-0 [&_p+p]:mt-1.5", compact && "line-clamp-2")} data-proposal-summary>
              <MarkdownRenderer content={proposal.summary_md} />
            </div>
          )}
          {totals && <p className="m-0 mb-1.5 text-[12.5px] leading-[18px] text-[color:var(--sol-text-muted)] [text-wrap:pretty]" data-proposal-totals>{totals}</p>}
          {!compact && <ProposalEntries proposal={proposal} changes={changes} entries={entries} batch={batch} why={!(entries.cards.length === 1 && proposal.summary_md?.trim())} />}
          {!compact && <ProposalFoot proposal={proposal} entries={entries} batch={batch} onMap={map} />}
        </>
      )}
    </div>
  );
}
