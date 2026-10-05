"use client";
// A proposal's ledger as the store holds it (docs/architecture/org-staffing.md
// S39): the cards of one proposal with their answers in the composer's
// pending batch, and the closing row under them. An answer fires nothing: it
// waits in the batch the quote UI uses (`reviewComments[batchKey]`), and the
// composer's send applies the approvals and tells the agent in words. The
// conversation's card and the single change card (`op-55#3`) draw from here;
// a host with no composer in reach hands the list a `batchKey` (the
// proposal's thread, else `proposal:<id>`) and its own `onSend`.
//
// Not named after its main export: `ProposalSubjects.tsx` and the model's
// `proposalSubjects.ts` are one path on a disk that ignores case, and a
// resolver then picks between them by extension.
import React, { useMemo, useState } from "react";
import Link from "next/link";
import { Check } from "lucide-react";
import { isOrgChangeDecidable, ORG_REPLY_WORDS } from "@codecast/shared/contracts/orgProposal";
import { entityRoute, proposalChangeRefId } from "../../lib/entityLinks";
import type { PendingComment, PendingProposalAnswer } from "../../lib/quoteFormat";
import { answerProposalCard, pendingAnswerOf, proposalAnswersOf, type ProposalCardRef } from "../../lib/reviewActions";
import { cn } from "../../lib/utils";
import { useInboxStore } from "../../store/inboxStore";
import { useReviewComposer } from "../reviewContext";
import { openOrgChart } from "./orgChartLink";
import { OrgButton } from "./OrgButton";
import type { OrgProposalChange, OrgProposalListRow } from "./orgStaffingTypes";
import { TakeoverEdit } from "./TakeoverEdit";
import { useSubjectLive } from "./proposalHooks";
import { placeWords, proposalProgressWords, proposalSubjects, subjectCounts, subjectOfSeq, type SubjectCard, type SubjectLive, type SubjectOptions } from "./proposalSubjects";
import { LEDGER_HAIR, LEDGER_INKS, LEDGER_LINK, LEDGER_STOP, LedgerClosingRow, LedgerReplyField, LedgerWord, LedgerYou, ProposalSubjectCard, type SubjectAnswer } from "./ProposalSubjectCard";

type Proposal = Pick<OrgProposalListRow, "_id" | "short_id" | "title" | "status" | "team_id" | "scope_user_id" | "reply">;
/** What a ref of the batch names a proposal by. */
type ProposalRef = Pick<Proposal, "_id" | "short_id" | "title">;

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

// ---------------------------------------------------------------- the batch

export type ProposalBatch<K extends string | null = string | null> = { key: K; comments: readonly PendingComment[] | undefined; send?: () => void };

/**
 * Where this proposal's answers collect, and how they go: the key a host
 * passes (its `onSend` sends them), else the conversation whose composer
 * is attached and can send (the bridge's `conversationId`; its `send`
 * presses that composer). With neither there is nowhere for an answer to
 * go, so the key is null and the ledger is read only: team chat drawing a
 * proposal, a guest or a non-owner reading a shared session, a view with no
 * input.
 */
export function useProposalBatch(proposal: Proposal, batchKey: string, onSend?: () => void): ProposalBatch<string>;
export function useProposalBatch(proposal: Proposal, batchKey?: string, onSend?: () => void): ProposalBatch;
export function useProposalBatch(_proposal: Proposal, batchKey?: string, onSend?: () => void): ProposalBatch {
  const composer = useReviewComposer();
  const key = batchKey ?? (composer?.canSend && composer.conversationId ? composer.conversationId : null);
  const comments = useInboxStore((s) => (key ? s.reviewComments[key] : undefined));
  // The composer's send goes only with its own batch.
  const send = onSend ?? (key && composer?.conversationId === key ? composer?.send : undefined);
  return { key, comments, send };
}

/** A pending item of the batch as the card reads it. */
export function answerOf(pending: (PendingComment & { proposal: PendingProposalAnswer }) | undefined): SubjectAnswer | null {
  return pending ? { verdict: pending.proposal.verdict, ...(pending.body ? { text: pending.body } : {}), ...(pending.proposal.leave_sessions ? { leave_sessions: true } : {}) } : null;
}

/** The pending answer of one card, and the handler that puts, replaces or
 *  withdraws it; with no key (nowhere to send) there is no handler, and the
 *  card draws read only. `number` is the ordinal the person sees, for the tray. */
export function useCardAnswer(proposal: Proposal, key: string, comments: readonly PendingComment[] | undefined, card: SubjectCard, number?: number): { answer: SubjectAnswer | null; onAnswer: (answer: SubjectAnswer | null) => void };
export function useCardAnswer(proposal: Proposal, key: string | null, comments: readonly PendingComment[] | undefined, card: SubjectCard, number?: number): { answer: SubjectAnswer | null; onAnswer?: (answer: SubjectAnswer | null) => void };
export function useCardAnswer(proposal: Proposal, key: string | null, comments: readonly PendingComment[] | undefined, card: SubjectCard, number?: number): { answer: SubjectAnswer | null; onAnswer?: (answer: SubjectAnswer | null) => void } {
  const pending = pendingAnswerOf(comments, proposal._id, card.key);
  const answer = useMemo(() => answerOf(pending), [pending]);
  return { answer, ...(key ? { onAnswer: (a: SubjectAnswer | null) => answerProposalCard(key, cardRef(proposal, card, number), a) } : {}) };
}

/** What a ref is built from: a card, or anything that holds changes the
 *  same way (the panel's ask, with its title as the sentence). */
export type CardMembers = Pick<SubjectCard, "key" | "changes" | "carried" | "riders" | "change_ids" | "sentence">;

/**
 * The card as the batch names it: the proposal, the key, and what the answer
 * is about, which is what still waits. `change_ids` is every waiting member
 * in apply order (riders and carried rows included, so the server decides
 * the whole card); `seqs` is what the words name: the waiting changes the
 * card draws, or, for a card that draws none (a limit alone is its own
 * sentence), the ones it holds.
 */
export function cardRef(proposal: ProposalRef, card: CardMembers, number?: number): ProposalCardRef {
  const members = [...card.changes, ...card.carried, ...card.riders];
  const waits = members.filter((c) => isOrgChangeDecidable(c.status));
  // Nothing waits (a card read after it was decided): the card as it stands.
  const of = waits.length ? waits : members;
  const ids = new Set(of.map((c) => c._id));
  const drawn = card.changes.filter((c) => ids.has(c._id));
  const seqs = (drawn.length ? drawn : of).map((c) => c.seq).sort((a, b) => a - b);
  return { proposal: { id: proposal._id, short_id: proposal.short_id, title: proposal.title }, key: card.key, change_ids: card.change_ids.filter((id) => ids.has(id)), seqs, sentence: card.sentence, ...(number !== undefined ? { ordinal: number } : {}) };
}

/** The whole proposal as a card of the batch: a note on all of it (key ""). */
const wholeRef = (proposal: ProposalRef): ProposalCardRef => ({ proposal: { id: proposal._id, short_id: proposal.short_id, title: proposal.title }, key: "", change_ids: [], seqs: [], sentence: proposal.title });

/** The changes have not landed yet. */
export const ProposalLoading = () => (
  <div className="space-y-1.5" aria-hidden data-proposal-loading>
    <div className="h-2 w-2/3 animate-pulse rounded bg-[color-mix(in_srgb,var(--sol-border)_55%,transparent)]" />
    <div className="h-2 w-1/3 animate-pulse rounded bg-[color-mix(in_srgb,var(--sol-border)_55%,transparent)]" />
  </div>
);

// ---------------------------------------------------------------- the list

/** A card with its answer read from and written to the batch; read only
 *  when there is no batch to write to, or the proposal was withdrawn.
 *  `number` is its place in the list for the tray; `ordinal` draws the
 *  number column. */
function AnsweredCard({ proposal, batch, card, number, ...rest }: { proposal: Proposal; batch: ProposalBatch; card: SubjectCard; number?: number } & Omit<React.ComponentProps<typeof ProposalSubjectCard>, "card" | "answer" | "onAnswer">) {
  const { answer, onAnswer } = useCardAnswer(proposal, batch.key, batch.comments, card, number);
  return <ProposalSubjectCard card={card} answer={answer} onAnswer={proposal.status === "withdrawn" ? undefined : onAnswer} {...rest} />;
}

/** The cards of one proposal, numbered down the list, each with its own
 *  Approve, Reject and Reply writing into the batch. */
export function ProposalSubjectList({ proposal, cards, limit, variant = "full", layout, batchKey, className }: {
  proposal: Proposal;
  cards: readonly SubjectCard[];
  /** Page size; "Show all N" past it. */
  limit?: number;
  variant?: "full" | "row";
  layout?: "wide" | "narrow";
  /** Where the answers collect when no composer is in reach. */
  batchKey?: string;
  className?: string;
}) {
  const [all, setAll] = useState(false);
  const batch = useProposalBatch(proposal, batchKey);
  const shown = limit != null && !all && cards.length > limit ? cards.slice(0, limit) : cards;
  // A proposal of one card: its Approve is the frame's one filled button, and there is nothing to number.
  const lone = cards.length === 1;
  return (
    <div className={cn("not-prose min-w-0", LEDGER_INKS, className)} data-proposal-subjects={cards.length}>
      <ol className="m-0 list-none p-0">
        {shown.map((card, i) => (
          <li key={card.key} className="m-0 p-0">
            <AnsweredCard proposal={proposal} batch={batch} card={card} number={i + 1} variant={variant} layout={layout} {...(lone ? { lead: true, className: variant === "full" ? "border-t py-[14px]" : "border-t" } : { ordinal: i + 1 })} />
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
  /** Where the answers collect when no composer is in reach. */
  batchKey?: string;
  className?: string;
};

/**
 * The store wired ledger of one proposal. With `only`, the one card that
 * holds that change, standing alone: its place in the proposal, the entry,
 * and a filled Approve until it is pressed. The answer shows in the
 * composer's tray; there is no closing row.
 */
export function ProposalSubjects({ proposal, changes, only, limit, variant, layout, href, batchKey, className }: ProposalSubjectsProps) {
  const { live, opts } = useCardInputs(proposal, changes);
  const cards = useMemo(() => proposalSubjects(changes, live, opts), [changes, live, opts]);
  const batch = useProposalBatch(proposal, batchKey);
  const card = only != null ? subjectOfSeq(cards, only) : null;
  // A change its author withdrew is in no card; it still reads as the sentence it was.
  const withdrawn = only != null && !card ? changes.find((c) => c.seq === only && c.status === "removed") : undefined;
  const withdrawnSentence = useMemo(
    () => (withdrawn ? proposalSubjects(changes.map((c) => (c._id === withdrawn._id ? { ...c, status: "skipped" as const } : c)), live, { ...opts, seqs: new Set([withdrawn.seq]) })[0]?.sentence ?? null : null),
    [withdrawn, changes, live, opts],
  );
  if (changes.length === 0) return <ProposalLoading />;
  if (only == null) return <ProposalSubjectList proposal={proposal} cards={cards} limit={limit} variant={variant} layout={layout} batchKey={batchKey} className={className} />;

  const title = (
    <Link href={href ?? entityRoute("proposal", proposalChangeRefId(proposal.short_id, only)) ?? "#"} className={cn(LEDGER_LINK, "text-[color:var(--sol-text-muted)]")} {...LEDGER_STOP} data-subject-proposal>
      {proposal.title}
    </Link>
  );
  if (card) {
    const at = cards.findIndex((c) => c.key === card.key);
    return <AnsweredCard proposal={proposal} batch={batch} card={card} number={at >= 0 ? at + 1 : undefined} variant={variant} layout={layout} lead place={<>{placeWords(cards, card)} in {title}</>} className={className} />;
  }
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
 * The foot of a proposal's ledger. Left: Chart. Right: "Approve the rest"
 * (an approve answer on every card that waits and has none; pressed again it
 * withdraws the ones it put), "Reply" (a note on the whole proposal, its
 * field above the row) and, once the batch holds any answer for this
 * proposal, the frame's one filled button, "Send N answers", which presses
 * the composer's send (or the host's `onSend`). When nothing waits, what
 * happened in words.
 */
export function ProposalClosingRow({ proposal, cards, batchKey, onSend, takeover, sticky, className }: {
  proposal: Proposal;
  cards: readonly SubjectCard[];
  /** Where the answers collect when no composer is in reach. */
  batchKey?: string;
  /** Sends the batch where no composer does. */
  onSend?: () => void;
  /** What "Approve the rest" would take over (R1): the phrase, and the
   *  "leave them" box over the row, whose tick rides on the approvals it
   *  puts as `leave_sessions`. */
  takeover?: { phrase: string } | null;
  sticky?: boolean;
  className?: string;
}) {
  const batch = useProposalBatch(proposal, batchKey, onSend);
  const answers = proposalAnswersOf(batch.comments, proposal._id);
  const whole = pendingAnswerOf(batch.comments, proposal._id, "");
  const [fieldOpen, setFieldOpen] = useState(false);
  // The cards "Approve the rest" put an answer on, so a second press takes back only those.
  const [put, setPut] = useState<string[]>([]);
  const withdrawn = proposal.status === "withdrawn";
  const counts = subjectCounts(cards);
  const open = counts.waiting + counts.failed;
  const answered = new Set(answers.map((a) => a.proposal.card));
  const rest = cards.filter((c) => c.waiting > 0 && !answered.has(c.key));
  const putStill = put.filter((k) => answers.some((a) => a.proposal.card === k && a.proposal.verdict === "approve"));
  const pressed = putStill.length > 0;
  // "Leave the sessions where they are": read from the approvals the row put
  // once there are any, kept here only until there are (the card's rule).
  const [leaveLocal, setLeaveLocal] = useState(false);
  const leave = pressed ? answers.some((a) => putStill.includes(a.proposal.card) && a.proposal.leave_sessions) : leaveLocal;
  // Every write goes to the batch; with no batch (read only) there are no controls to write from.
  const write = (card: ProposalCardRef, answer: Parameters<typeof answerProposalCard>[2]) => { if (batch.key) answerProposalCard(batch.key, card, answer); };
  const approve = (tick: boolean) => ({ verdict: "approve" as const, ...(tick ? { leave_sessions: true } : {}) });
  const approveRest = () => {
    if (pressed) {
      for (const key of putStill) { const card = cards.find((c) => c.key === key); if (card) write(cardRef(proposal, card), null); }
      setPut([]);
      return;
    }
    for (const card of rest) write(cardRef(proposal, card, cards.indexOf(card) + 1), approve(leave));
    setPut(rest.map((c) => c.key));
  };
  // The tick changed: the approvals the row put carry the new one.
  const onLeave = (v: boolean) => {
    setLeaveLocal(v);
    for (const key of putStill) { const card = cards.find((c) => c.key === key); if (card) write(cardRef(proposal, card, cards.indexOf(card) + 1), approve(v)); }
  };
  // "Approve all 9" while nothing is answered or decided; "Approve the rest" once something is.
  const restLabel = answers.length === 0 && counts.waiting === counts.total ? `${ORG_REPLY_WORDS.approve.act} all ${rest.length}` : `${ORG_REPLY_WORDS.approve.act} the rest`;
  const note = (text: string) => write(wholeRef(proposal), { verdict: "note", text });
  // Leaving the field keeps the words; a note with none goes with it.
  const closeField = () => { setFieldOpen(false); if (whole && !whole.body.trim()) write(wholeRef(proposal), null); };
  // The pending words lead while they exist; after the send, the note the
  // server stored on the proposal (`proposal.reply`, the whole-proposal note).
  const stored = proposal.reply?.text?.trim() ? proposal.reply : null;
  const words = whole?.body?.trim() ? { text: whole.body, verdict: whole.proposal.verdict } : stored ? { text: stored.text!, verdict: stored.verdict } : null;
  const answerable = !!batch.key && !withdrawn && proposal.status === "open" && open > 0;
  const tick = takeover && answerable ? <TakeoverEdit className="mb-2.5" phrase={takeover.phrase} leave={leave} onLeave={onLeave} /> : null;
  const field = fieldOpen && answerable
    ? <LedgerReplyField value={whole?.body ?? ""} ask="Say something about the whole proposal" onChange={note} onClose={closeField} data-proposal-reply-field />
    : words
      ? <LedgerYou text={words.text} onEdit={answerable ? () => setFieldOpen(true) : undefined} data-proposal-you={words.verdict} />
      : null;
  return (
    <LedgerClosingRow
      sticky={sticky}
      className={className}
      above={tick || field ? <>{tick}{field}</> : undefined}
      left={<LedgerWord onClick={() => openOrgChart({ proposal: proposal.short_id })} aria-label="Show this proposal on the chart" title="Open the chart beside this conversation" data-open-chart={proposal.short_id}>Chart</LedgerWord>}
      right={answerable ? (
        <>
          {/* A proposal of one card: its own Approve is the whole decision. */}
          {counts.total > 1 && (rest.length > 0 || pressed) && (
            <OrgButton size="sm" quiet aria-pressed={pressed} onClick={approveRest} data-approve-rest={rest.length}>
              {pressed && <Check className="-ml-0.5 h-3 w-3" aria-hidden />}
              {restLabel}
            </OrgButton>
          )}
          <LedgerWord aria-expanded={fieldOpen} onClick={() => setFieldOpen((v) => !v)} data-proposal-reply>{ORG_REPLY_WORDS.note.act}</LedgerWord>
          {answers.length > 0 && batch.send && (
            <OrgButton primary size="sm" className="ml-1" onClick={batch.send} data-send-answers={answers.length}>Send {answers.length} {answers.length === 1 ? "answer" : "answers"}</OrgButton>
          )}
        </>
      ) : undefined}
      outcome={withdrawn ? "Withdrawn" : open === 0 ? proposalProgressWords(cards) || "Nothing to decide" : undefined}
    />
  );
}
