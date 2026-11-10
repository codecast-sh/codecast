"use client";
// A proposal's ledger as the store holds it (docs/architecture/org-staffing.md
// S39): the entries of one proposal (subject cards, or group rows for a
// records proposal) with their answers in the composer's pending batch, and
// the foot under them. An answer fires nothing: it waits in the batch the
// quote UI uses (`reviewComments[conversationId]`), and the composer's send
// applies the approvals and tells the agent in words. The conversation's
// card draws from here.
//
// Not named after its main export: `ProposalSubjects.tsx` and the model's
// `proposalSubjects.ts` are one path on a disk that ignores case, and a
// resolver then picks between them by extension.
import React, { useMemo, useState } from "react";
import { Check } from "lucide-react";
import { ORG_REPLY_WORDS } from "@codecast/shared/contracts/orgProposal";
import { cn } from "../../lib/utils";
import { useInboxStore } from "../../store/inboxStore";
import { useReviewComposer } from "../reviewContext";
import type { OrgProposalChange, OrgProposalListRow } from "./orgStaffingTypes";
import { TakeoverEdit } from "./TakeoverEdit";
import { proposalProgressWords, type RecordGroupCard, type SubjectCard } from "./proposalSubjects";
import { RecordGroupRow } from "./RecordGroupRow";
import { LEDGER_HAIR, LEDGER_INKS, LEDGER_STOP, LedgerClosingRow, LedgerWord, ProposalSubjectCard } from "./ProposalSubjectCard";
import { SwitchReview } from "../consequential/ConsequentialSwitch";
import { newRolesLedger } from "../consequential/roleOnline";
import { cardRef, groupRef, newRolesOf, useAcceptRest as useAcceptRestModel, useCardAnswer, useEntryAnswer, type BatchEntry, type Proposal, type ProposalBatch, type ProposalEntryModel, type SubjectAnswer } from "./proposalLedgerModel";

export { cardRef, groupRef, useProposalEntries, useProposalSetEntries, type BatchEntry, type CardMembers, type ProposalBatch, type ProposalEntryModel } from "./proposalLedgerModel";

// ---------------------------------------------------------------- the batch

/**
 * Where this proposal's answers collect: the conversation whose composer is
 * attached and can send (the bridge's `conversationId`). With none there is
 * nowhere for an answer to go, so the key is null and the ledger is read
 * only: team chat drawing a proposal, a guest or a non-owner reading a
 * shared session, a view with no input.
 */
export function useProposalBatch(_proposal: Proposal): ProposalBatch {
  const composer = useReviewComposer();
  const key = composer?.canSend && composer.conversationId ? composer.conversationId : null;
  const comments = useInboxStore((s) => (key ? s.reviewComments[key] : undefined));
  // The composer's send goes only with its own batch.
  const send = key && composer?.conversationId === key ? composer?.send : undefined;
  return { key, comments, send };
}

/** The changes have not landed yet. With `rows`, it holds about the height
 *  the entries will take, so the transcript does not jump when they land. */
export const ProposalLoading = ({ rows = 0 }: { rows?: number }) => (
  <div className="space-y-1.5" style={rows ? { minHeight: 56 + Math.min(rows, 12) * 40 } : undefined} aria-hidden data-proposal-loading>
    <div className="h-2 w-2/3 animate-pulse rounded bg-[color-mix(in_srgb,var(--sol-border)_55%,transparent)]" />
    <div className="h-2 w-1/3 animate-pulse rounded bg-[color-mix(in_srgb,var(--sol-border)_55%,transparent)]" />
  </div>
);

// ---------------------------------------------------------------- focus

/** The store's focus (orgFocusChangeId) as a change of this proposal, else null. */
function useFocusChange(changes: readonly OrgProposalChange[]): OrgProposalChange | null {
  const id = useInboxStore((s) => s.orgFocusChangeId);
  return useMemo(() => (id ? changes.find((c) => c._id === id) ?? null : null), [id, changes]);
}

// ---------------------------------------------------------------- the entries

/** A card with its answer read from and written to the batch; read only when
 *  there is no batch to write to, or the proposal is not open. */
export function AnsweredCard({ proposal, batch, card, number, focusId, ...rest }: { proposal: Proposal; batch: ProposalBatch; card: SubjectCard; number?: number; focusId: string | null } & Omit<React.ComponentProps<typeof ProposalSubjectCard>, "card" | "answer" | "onAnswer" | "focused">) {
  const { answer, onAnswer, revised } = useCardAnswer(proposal, batch.key, batch.comments, card, number);
  const focused = !!focusId && [...card.changes, ...card.carried, ...card.riders].some((c) => c._id === focusId);
  const hireReview = useHireReview();
  const roles = newRolesOf(card.changes);
  // Approving a new role starts its standing session: the press opens the
  // review first, and its confirm puts the approval.
  const answerOrReview = onAnswer && roles.length ? (a: SubjectAnswer | null) => (a?.verdict === "approve" && answer?.verdict !== "approve" ? hireReview.open(roles, () => onAnswer(a)) : onAnswer(a)) : onAnswer;
  return (
    <>
      <ProposalSubjectCard card={card} answer={answer} onAnswer={proposal.status === "open" ? answerOrReview : undefined} focused={focused} revisedNew={revised || undefined} author={proposal.author?.name} authorApplied={!!proposal.applied_by_author} {...rest} />
      {hireReview.element}
    </>
  );
}

/** The shared confirm before approving new roles: `open` shows the review, and its confirm runs `go`. */
function useHireReview(): { open: (roles: ReturnType<typeof newRolesOf>, go: () => void) => void; element: React.ReactNode } {
  const host = useInboxStore((s) => (s.currentUser as { name?: string } | null)?.name ?? "The approver");
  const [pending, setPending] = useState<{ roles: ReturnType<typeof newRolesOf>; go: () => void } | null>(null);
  return {
    open: (roles, go) => setPending({ roles, go }),
    // React events from the portaled dialog bubble through the card; the stop keeps a press there from toggling the card.
    element: pending && <span className="contents" {...LEDGER_STOP}><SwitchReview ledger={newRolesLedger(pending.roles, host)} onClose={() => setPending(null)} onConfirm={() => { pending.go(); setPending(null); }} /></span>,
  };
}

export function AnsweredGroup({ proposal, batch, group, focus, lone, open, onOpen }: { proposal: Proposal; batch: ProposalBatch; group: RecordGroupCard; focus: OrgProposalChange | null; lone: boolean; open: boolean; onOpen: (v: boolean) => void }) {
  const { answer, onAnswer, revised } = useEntryAnswer(batch.key, batch.comments, groupRef(proposal, group), group.rows.map((r) => r.change));
  const focusSeq = focus && group.seqs.includes(focus.seq) ? focus.seq : null;
  return <RecordGroupRow card={group} answer={answer} onAnswer={proposal.status === "open" ? onAnswer : undefined} open={open} onOpen={onOpen} lone={lone} focusSeq={focusSeq} revisedNew={revised || undefined} />;
}

/**
 * The entries of one proposal: one group row per record group (a records
 * proposal), else one subject card per subject, numbered when there are two
 * or more, twelve at a time with "Show all N" past that.
 */
/** A records proposal this small shows every record at once; past it, the groups fold to their totals. */
const OPEN_RECORDS = 6;

export function ProposalEntries({ proposal, changes, entries, batch, limit = 12, why, className }: {
  proposal: Proposal;
  changes: readonly OrgProposalChange[];
  entries: ProposalEntryModel;
  batch: ProposalBatch;
  /** Page size for subject cards; "Show all N" past it. */
  limit?: number;
  /** Draw each change's reason. Off where the proposal's summary already says it (one change under its summary). */
  why?: boolean;
  className?: string;
}) {
  const [all, setAll] = useState(false);
  // A proposal small enough to read at a glance starts open, so what is approved is on the card. A press settles it either way.
  const [toggled, setToggled] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  const focus = useFocusChange(changes);
  const setOpen = (key: string, v: boolean) => setToggled((prev) => new Map(prev).set(key, v));
  if (entries.records) {
    const lone = entries.groups.length === 1;
    const small = entries.groups.reduce((n, g) => n + g.rows.length, 0) <= OPEN_RECORDS;
    return (
      <div className={cn("not-prose min-w-0 [&>:first-child]:border-t-0", LEDGER_INKS, className)} data-proposal-groups={entries.groups.length}>
        {entries.groups.map((group) => <AnsweredGroup key={group.key} proposal={proposal} batch={batch} group={group} focus={focus} lone={lone} open={toggled.get(group.key) ?? small} onOpen={(v) => setOpen(group.key, v)} />)}
      </div>
    );
  }
  const cards = entries.cards;
  const shown = !all && cards.length > limit ? cards.slice(0, limit) : cards;
  // A proposal of one card: its Approve is the frame's one filled button, and there is nothing to number.
  const lone = cards.length === 1;
  return (
    <div className={cn("not-prose min-w-0", LEDGER_INKS, className)} data-proposal-subjects={cards.length}>
      <ol className="m-0 list-none p-0 [&>li:first-child>*]:border-t-0">
        {shown.map((card, i) => (
          <li key={card.key} className="m-0 p-0">
            <AnsweredCard proposal={proposal} batch={batch} card={card} number={i + 1} focusId={focus?._id ?? null} why={why} {...(lone ? { className: "py-[14px]" } : { ordinal: i + 1 })} />
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

/** A proposal its author applied as it posted it reads as the author's act
 *  ("10 filed"), never as a person's acceptance. */
export function authorAppliedWords(proposal: Pick<Proposal, "applied_by_author">, work: ProposalEntryModel["work"], words: string): string {
  return proposal.applied_by_author ? words.replace(/\b(accepted|applied)\b/, work === "sessions" ? "filed" : "applied") : words;
}

// ---------------------------------------------------------------- the foot

/** "Accept all" with the web's hire review: the model's press, and the dialog it opens. */
export function useAcceptRest(list: readonly BatchEntry[], batch: ProposalBatch) {
  const hireReview = useHireReview();
  return { ...useAcceptRestModel(list, batch, hireReview.open), element: hireReview.element };
}

/**
 * The foot of a proposal's ledger. Left: Map, when the card is not on the org
 * screen (`onMap`). Right, while anything waits and a batch key exists:
 * "Accept all N" while nothing is answered or decided, "Accept the rest"
 * once something is (useAcceptRest). When nothing waits, what happened in
 * words. Read only: one quiet line, once.
 */
export function ProposalFoot({ proposal, entries, batch, onMap, takeover, className }: {
  proposal: Proposal & Pick<OrgProposalListRow, "author">;
  entries: ProposalEntryModel;
  batch: ProposalBatch;
  onMap?: () => void;
  /** What "Accept the rest" would take over (R1): the phrase, and the "leave them" box over the row, whose tick rides on the approvals it puts as `leave_sessions`. */
  takeover?: { phrase: string } | null;
  className?: string;
}) {
  const [leaveLocal, setLeaveLocal] = useState(false);
  const withdrawn = proposal.status === "withdrawn";
  const list: BatchEntry[] = entries.records
    ? entries.groups.map((g) => ({ waiting: g.waiting, ref: groupRef(proposal, g), changes: [] }))
    : entries.cards.map((c, i) => ({ waiting: c.waiting, ref: cardRef(proposal, c, i + 1), changes: c.changes }));
  const open = list.filter((e) => e.waiting > 0).length;
  const acceptRest = useAcceptRest(list, batch);
  const { rest, pressed, answers } = acceptRest;
  const leave = pressed ? acceptRest.leave : leaveLocal;
  const approveRest = () => acceptRest.press(leave);
  const onLeave = (v: boolean) => { setLeaveLocal(v); acceptRest.retick(v); };
  const decided = list.some((e) => e.waiting === 0);
  const restLabel = answers.length === 0 && !decided ? `${ORG_REPLY_WORDS.approve.act} all ${rest.length}` : `${ORG_REPLY_WORDS.approve.act} the rest`;
  const answerable = !!batch.key && !withdrawn && proposal.status === "open" && open > 0;
  const records = entries.records ? entries.groups.flatMap((g) => g.rows.map((r) => r.change)) : undefined;
  const outcome = withdrawn ? "Withdrawn" : open === 0 ? authorAppliedWords(proposal, entries.work, proposalProgressWords(entries.cards, records)) || "Nothing to decide" : undefined;
  const who = proposal.author?.name ? `${proposal.author.name}'s` : "the author's";
  const above = takeover && answerable && (rest.length > 0 || pressed) && list.length > 1 ? <TakeoverEdit phrase={takeover.phrase} leave={leave} onLeave={onLeave} /> : undefined;
  const left = onMap ? <LedgerWord onClick={onMap} aria-label="Show this proposal on the map" title="Open the org map beside this conversation" data-open-map={proposal.short_id}>Map</LedgerWord> : undefined;
  const right = answerable && list.length > 1 && (rest.length > 0 || pressed) ? (
    <LedgerWord className={cn("-mr-2", pressed && "text-[color:var(--ink-violet)]")} aria-pressed={pressed} onClick={approveRest} data-approve-rest={rest.length}>
      {pressed && <Check className="-ml-0.5 mr-1 h-3 w-3" aria-hidden />}
      {restLabel}
    </LedgerWord>
  ) : undefined;
  return (
    <>
      {!answerable && open > 0 && !withdrawn && proposal.status === "open" && (
        <p className={cn("m-0 mt-2 text-meta leading-[18px] text-[color:var(--ink-quiet)]")} data-proposal-readonly-line>Open this in {who} thread to answer.</p>
      )}
      {/* A closing row with nothing in it draws no rule. */}
      {(above || left || right || outcome) && <LedgerClosingRow className={cn("mt-2", className)} above={above} left={left} right={right} outcome={outcome} />}
      {acceptRest.element}
    </>
  );
}
