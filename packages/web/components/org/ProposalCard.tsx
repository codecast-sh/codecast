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
import React, { useMemo, useRef, useState } from "react";
import { stripMarkdown } from "@codecast/shared/contracts/plainText";
import { useOverflows } from "../../hooks/useOverflows";
import { cn } from "../../lib/utils";
import { ProposalAuthorPill } from "./ProposalAuthorPill";
import { letterParts } from "./staffingAsks";
import { openOrgChart } from "./orgChartLink";
import { useOrgHover } from "./proposalContexts";
import { proposalProgressWords } from "./proposalSubjects";
import type { OrgProposalChange, OrgProposalListRow } from "./orgStaffingTypes";
import { LEDGER_INKS, LEDGER_STOP, LedgerWord } from "./ProposalSubjectCard";
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

// ---------------------------------------------------------------- the letter

const LETTER = "max-w-[70ch] text-[13.5px] leading-[1.6] text-[color:var(--sol-text-secondary)]";

/** The letter's lead, clamped to four lines (two on a tile), and "Read the
 *  rest" when more follows or the lead overflows: pressed, the whole letter
 *  reads in place and the frame never toggles. An open frame shows the whole
 *  letter with no word. */
function LetterLead({ proposal, compact, open, summary }: { proposal: OrgProposalListRow; compact?: boolean; open?: boolean; summary?: React.ReactNode }) {
  const parts = useMemo(() => letterParts(proposal.summary_md), [proposal.summary_md]);
  const lead = useMemo(() => stripMarkdown(parts.lead, { keepNewlines: true }), [parts.lead]);
  const ref = useRef<HTMLParagraphElement>(null);
  const [expanded, setExpanded] = useState(false);
  const lines = compact ? 2 : 4;
  // 13.5px at 1.6 is about 21.6px a line; a pixel of slack for rounding.
  const overflows = useOverflows(ref, lines * 22 + 1, [lead]);
  if (!lead) return null;
  const whole = summary ?? <p className="m-0 whitespace-pre-line">{stripMarkdown(proposal.summary_md, { keepNewlines: true })}</p>;
  if (open) return <div className={cn("mb-3.5 mt-0.5", LETTER)} data-proposal-letter>{whole}</div>;
  const more = !compact && (!!parts.rest.trim() || overflows);
  return (
    <div className={cn("mt-0.5", compact ? "mb-2" : "mb-3", LETTER)} data-proposal-letter>
      {expanded ? whole : <p ref={ref} className={cn("m-0 whitespace-pre-line", lines === 2 ? "line-clamp-2" : "line-clamp-4")}>{lead}</p>}
      {(more || expanded) && (
        <span className="block" {...LEDGER_STOP}>
          <LedgerWord className="-ml-2 mt-0.5 h-6 text-[11px]" onClick={() => setExpanded((v) => !v)} aria-expanded={expanded} data-letter-more={expanded ? "open" : "closed"}>{expanded ? "Read less" : "Read the rest"}</LedgerWord>
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- the body

/**
 * The card's body: the letter's lead, the totals line, the entries, the
 * foot. `compact` is a tile sharing a row with other cards: the lead and the
 * totals only. `open` is the expanded frame: the whole letter. `onMap`
 * opens the map beside the conversation; absent, the card opens the org
 * screen itself, unless it already sits on it (the screen feeds the hover
 * channel, so a card that can light the map needs no Map word).
 */
export function ProposalBody({ proposal, changes, open, compact, summary, onMap }: {
  proposal: OrgProposalListRow;
  changes: readonly OrgProposalChange[];
  open?: boolean;
  compact?: boolean;
  /** The whole letter as the frame renders markdown; the stripped text stands in without it. */
  summary?: React.ReactNode;
  onMap?: () => void;
}) {
  const entries = useProposalEntries(proposal, changes);
  const batch = useProposalBatch(proposal);
  const onScreen = useOrgHover() !== null;
  const map = onMap ?? (onScreen ? undefined : () => openOrgChart({ proposal: proposal.short_id }));
  const readonly = !batch.key || proposal.status !== "open";
  // One record group carries the proposal's totals itself.
  const totals = entries.records && entries.groups.length === 1 ? null : entries.totals.line;
  return (
    <div className={cn("not-prose min-w-0", LEDGER_INKS)} data-proposal-card={proposal.short_id} data-proposal-work={entries.work ?? undefined} data-proposal-readonly={readonly || undefined}>
      <LetterLead proposal={proposal} compact={compact} open={open} summary={summary} />
      {changes.length === 0 ? <ProposalLoading /> : (
        <>
          {totals && <p className="m-0 mb-1.5 text-[12.5px] leading-[18px] text-[color:var(--sol-text-muted)] [text-wrap:pretty]" data-proposal-totals>{totals}</p>}
          {!compact && <ProposalEntries proposal={proposal} changes={changes} entries={entries} batch={batch} />}
          {!compact && <ProposalFoot proposal={proposal} entries={entries} batch={batch} onMap={map} />}
        </>
      )}
    </div>
  );
}
