"use client";
// A proposal's ledger as the store holds it (docs/architecture/org-staffing.md
// S39): the cards of one proposal with their verdicts wired to the page's own
// store actions, and the closing row under them. The conversation's card and
// the single change card (`op-55#3`) draw from here; a host that keeps its own
// verdicts (the org page, the company document) hands `ProposalSubjectCard`
// its callbacks instead.
//
// Not named after its main export: `ProposalSubjects.tsx` and the model's
// `proposalSubjects.ts` are one path on a disk that ignores case, and a
// resolver then picks between them by extension.
import React, { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import { isOrgChangeDecidable, withAboutProposal } from "@codecast/shared/contracts/orgProposal";
import { focusComposer } from "../../lib/composerControl";
import { entityRoute, proposalChangeRefId } from "../../lib/entityLinks";
import { cn } from "../../lib/utils";
import { useInboxStore } from "../../store/inboxStore";
import { undoAsOne } from "../../store/undo/labels";
import { useReviewComposer } from "../reviewContext";
import { openOrgChart } from "./orgChartLink";
import type { OrgProposalChange, OrgProposalListRow } from "./orgStaffingTypes";
import { decideTogether } from "./proposalDecide";
import { proposalSeen, useSubjectLive } from "./proposalHooks";
import { placeWords, proposalProgressWords, proposalSubjects, subjectCounts, subjectOfSeq, type SubjectCard, type SubjectLive, type SubjectOptions } from "./proposalSubjects";
import { LEDGER_HAIR, LEDGER_INKS, LEDGER_LINK, LEDGER_STOP, LEDGER_WORD, LedgerClosingRow, LedgerWord, ProposalSubjectCard, type SubjectVerdict } from "./ProposalSubjectCard";

type Proposal = Pick<OrgProposalListRow, "_id" | "short_id" | "title" | "status" | "team_id" | "scope_user_id">;

/** What a proposal's cards are built from: the live records a before is read
 *  from, and the session the reader is looking from (an offer of it reads
 *  "this session", S5). */
function useCardInputs(proposal: Proposal | undefined, changes: readonly OrgProposalChange[]): { live: SubjectLive | null; opts: SubjectOptions } {
  const live = useSubjectLive(proposal, changes);
  const viewer = useInboxStore((s) => s.currentSessionId ?? null);
  const viewerShort = useInboxStore((s) => (s.currentSessionId ? (s.sessions as Record<string, { short_id?: string } | undefined>)[s.currentSessionId]?.short_id ?? null : null));
  const opts = useMemo<SubjectOptions>(() => ({ viewerSession: viewer ? { id: viewer, short_id: viewerShort } : null }), [viewer, viewerShort]);
  return { live, opts };
}

/** One proposal's cards from the store: what the ledger draws, and what the
 *  frame's meta line and closing row count. */
export function useProposalCards(proposal: Proposal | undefined, changes: readonly OrgProposalChange[]): SubjectCard[] {
  const { live, opts } = useCardInputs(proposal, changes);
  return useMemo(() => proposalSubjects(changes, live, opts), [changes, live, opts]);
}

/**
 * What the closing row's two verdicts read as: "Accept all 9" and "Skip all"
 * while nothing is decided, "Accept the other 5" and "Skip the rest" mid way
 * (the count is the cards still to decide, as the meta line counts them; a
 * failed one is retried along), "Retry" when only failures wait. Null when
 * nothing waits, and for a proposal of one card, whose own Accept is the
 * whole decision.
 */
export function closingWords(cards: readonly SubjectCard[]): { accept: string; skip: string } | null {
  const c = subjectCounts(cards);
  if (c.waiting + c.failed === 0 || c.total === 1) return null;
  if (c.waiting === 0) return c.failed === 1 ? { accept: "Retry", skip: "Skip" } : { accept: `Retry the ${c.failed}`, skip: "Skip the rest" };
  return c.waiting === c.total ? { accept: `Accept all ${c.waiting}`, skip: "Skip all" } : { accept: `Accept the other ${c.waiting}`, skip: "Skip the rest" };
}

/** The changes have not landed yet. */
export const ProposalLoading = () => (
  <div className="space-y-1.5" aria-hidden data-proposal-loading>
    <div className="h-2 w-2/3 animate-pulse rounded bg-[color-mix(in_srgb,var(--sol-border)_55%,transparent)]" />
    <div className="h-2 w-1/3 animate-pulse rounded bg-[color-mix(in_srgb,var(--sol-border)_55%,transparent)]" />
  </div>
);

// ---------------------------------------------------------------- the list

/** The cards of one proposal, numbered down the list, each with its own
 *  Accept and Skip. A verdict is the store's single change action for every
 *  member still waiting, in apply order, with what the reader saw (S18). */
export function ProposalSubjectList({ proposal, changes, cards, limit, variant = "full", layout, className }: {
  proposal: Proposal;
  /** The whole proposal's rows: a verdict's seen stamp needs them all. */
  changes: readonly OrgProposalChange[];
  cards: readonly SubjectCard[];
  /** Page size; "Show all N" past it. */
  limit?: number;
  variant?: "full" | "row";
  layout?: "wide" | "narrow";
  className?: string;
}) {
  const [all, setAll] = useState(false);
  const decide = useProposalVerdict(proposal, changes);
  const shown = limit != null && !all && cards.length > limit ? cards.slice(0, limit) : cards;
  // A proposal of one card: its Accept is the frame's one filled button, and there is nothing to number.
  const lone = cards.length === 1;
  return (
    <div className={cn("not-prose min-w-0", LEDGER_INKS, className)} data-proposal-subjects={cards.length}>
      <ol className="m-0 list-none p-0">
        {shown.map((card, i) => (
          <li key={card.key} className="m-0 p-0">
            <ProposalSubjectCard card={card} variant={variant} layout={layout} onDecide={decide} {...(lone ? { lead: true, className: variant === "full" ? "border-t py-[14px]" : "border-t" } : { ordinal: i + 1 })} />
          </li>
        ))}
      </ol>
      {shown.length < cards.length && (
        <div className="border-t py-1.5" style={{ borderColor: LEDGER_HAIR }} {...LEDGER_STOP}>
          <LedgerWord className="-ml-2" onClick={() => setAll(true)} data-subjects-show-all>Show all {cards.length}</LedgerWord>
        </div>
      )}
    </div>
  );
}

/** A card's verdict against the store. Undefined for a proposal its author withdrew: nothing in it can be decided. */
function useProposalVerdict(proposal: Proposal, changes: readonly OrgProposalChange[]): SubjectVerdict | undefined {
  const decide = useCallback<SubjectVerdict>((ids, verdict, opts) => {
    const seen = proposalSeen(changes);
    decideTogether(changes, ids, verdict, (id, v, edits) => useInboxStore.getState().decideOrgProposalChange(id, v, edits, seen), opts);
  }, [changes]);
  return proposal.status === "withdrawn" ? undefined : decide;
}

export type ProposalSubjectsProps = {
  proposal: Proposal;
  /** The whole proposal's rows. */
  changes: readonly OrgProposalChange[];
  /** A change's number: draw just the card that holds it, standing alone (`op-55#3`). */
  only?: number;
  /** Page size; "Show all N" past it. */
  limit?: number;
  variant?: "full" | "row";
  layout?: "wide" | "narrow";
  /** Where the proposal opens, for the single card's place line. Default: the org page with the change in focus. */
  href?: string;
  className?: string;
};

/**
 * The store wired ledger of one proposal. With `only`, the one card that
 * holds that change, standing alone: its place in the proposal, the entry,
 * and a filled Accept.
 */
export function ProposalSubjects({ proposal, changes, only, limit, variant, layout, href, className }: ProposalSubjectsProps) {
  const { live, opts } = useCardInputs(proposal, changes);
  const cards = useMemo(() => proposalSubjects(changes, live, opts), [changes, live, opts]);
  const decide = useProposalVerdict(proposal, changes);
  const card = only != null ? subjectOfSeq(cards, only) : null;
  // A change its author withdrew is in no card; it still reads as the sentence it was.
  const withdrawn = only != null && !card ? changes.find((c) => c.seq === only && c.status === "removed") : undefined;
  const withdrawnSentence = useMemo(
    () => (withdrawn ? proposalSubjects(changes.map((c) => (c._id === withdrawn._id ? { ...c, status: "skipped" as const } : c)), live, { ...opts, seqs: new Set([withdrawn.seq]) })[0]?.sentence ?? null : null),
    [withdrawn, changes, live, opts],
  );
  if (changes.length === 0) return <ProposalLoading />;
  if (only == null) return <ProposalSubjectList proposal={proposal} changes={changes} cards={cards} limit={limit} variant={variant} layout={layout} className={className} />;

  const title = (
    <Link href={href ?? entityRoute("proposal", proposalChangeRefId(proposal.short_id, only)) ?? "#"} className={cn(LEDGER_LINK, "text-[color:var(--sol-text-muted)]")} {...LEDGER_STOP} data-subject-proposal>
      {proposal.title}
    </Link>
  );
  if (card) return <ProposalSubjectCard card={card} variant={variant} layout={layout} lead onDecide={decide} place={<>{placeWords(cards, card)} in {title}</>} className={className} />;
  return (
    <div className={cn("not-prose min-w-0 text-[12px] leading-[1.6] text-[color:var(--ink-quiet)]", LEDGER_INKS, className)} data-subject-missing={withdrawn ? "withdrawn" : "gone"}>
      {withdrawn ? (
        <>
          {withdrawnSentence && <p className="m-0 text-[13.5px] leading-[20px] line-through decoration-1">{withdrawnSentence}</p>}
          <p className="m-0 mt-1">Withdrawn by its author{withdrawn.revision?.note ? `: ${withdrawn.revision.note}` : "."} It was part of {title}.</p>
        </>
      ) : (
        <p className="m-0">This change is no longer part of {title}.</p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- the closing row

/**
 * The foot of a proposal's ledger: Chart and Ask as words at the left; at the
 * right the frame's one filled button and Skip all, then what happened once
 * nothing waits. Accept is the page's accept all with the seen stamp; Skip is
 * one decide per waiting change under one history row. Ask puts the proposal
 * in this thread's composer, or, where none is in reach (a doc, team chat),
 * opens it on the org page beside its own thread.
 */
export function ProposalClosingRow({ proposal, changes, cards, href, sticky, className }: {
  proposal: Proposal;
  changes: readonly OrgProposalChange[];
  cards: readonly SubjectCard[];
  /** The proposal on the org page. */
  href: string;
  sticky?: boolean;
  className?: string;
}) {
  const composer = useReviewComposer();
  const accept = useCallback(() => {
    useInboxStore.getState().acceptAllOrgProposal(proposal._id, { seen: proposalSeen(changes) });
  }, [proposal._id, changes]);
  // One press, one row in the history, named like Accept's.
  const skip = useCallback(() => {
    const seen = proposalSeen(changes);
    const st = useInboxStore.getState();
    undoAsOne("Skipped an org proposal", () => {
      for (const c of changes) if (isOrgChangeDecidable(c.status)) st.decideOrgProposalChange(c._id, "skip", undefined, seen);
    });
  }, [changes]);
  const ask = useCallback(() => {
    composer?.populate?.(withAboutProposal("", proposal.short_id, proposal.title));
    focusComposer();
  }, [composer, proposal.short_id, proposal.title]);
  const withdrawn = proposal.status === "withdrawn";
  const words = withdrawn ? null : closingWords(cards);
  const counts = subjectCounts(cards);
  const open = counts.waiting + counts.failed;
  return (
    <LedgerClosingRow
      sticky={sticky}
      className={className}
      left={
        <>
          <LedgerWord onClick={() => openOrgChart({ proposal: proposal.short_id })} aria-label="Show this proposal on the chart" title="Open the chart beside this conversation" data-open-chart={proposal.short_id}>Chart</LedgerWord>
          {composer?.populate
            ? <LedgerWord onClick={ask} aria-label="Ask about this proposal" data-ask-about>Ask</LedgerWord>
            : <Link href={href} className={LEDGER_WORD} aria-label="Ask about this proposal" data-ask-about>Ask</Link>}
        </>
      }
      accept={words ? { label: words.accept, onClick: accept } : undefined}
      skip={words ? { label: words.skip, onClick: skip } : undefined}
      outcome={withdrawn ? "Withdrawn" : open === 0 ? proposalProgressWords(cards) || "Nothing to decide" : undefined}
    />
  );
}
