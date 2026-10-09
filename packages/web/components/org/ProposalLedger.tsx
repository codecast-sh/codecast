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
import { proposalTotals } from "@codecast/shared/contracts/orgChangeWords";
import { isOrgChangeDecidable, ORG_REPLY_WORDS, orgProposalWork, type OrgAskNames } from "@codecast/shared/contracts/orgProposal";
import type { PendingComment, PendingProposalAnswer } from "../../lib/quoteFormat";
import { answerProposalCard, pendingAnswerOf, proposalAnswersOf, type ProposalCardRef } from "../../lib/reviewActions";
import { cn } from "../../lib/utils";
import { useInboxStore } from "../../store/inboxStore";
import { useReviewComposer } from "../reviewContext";
import type { OrgProposalChange, OrgProposalListRow } from "./orgStaffingTypes";
import { TakeoverEdit } from "./TakeoverEdit";
import { useSubjectLive } from "./proposalHooks";
import { proposalProgressWords, proposalSubjects, recordGroupCards, type RecordGroupCard, type SubjectCard, type SubjectLive, type SubjectOptions } from "./proposalSubjects";
import { askNames } from "./staffingAsks";
import { RecordGroupRow } from "./RecordGroupRow";
import { LEDGER_HAIR, LEDGER_INKS, LEDGER_STOP, LedgerClosingRow, LedgerWord, ProposalSubjectCard, type SubjectAnswer } from "./ProposalSubjectCard";
import { useWatchEffect } from "../../hooks/useWatchEffect";

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

/** The proposal's entries as the card draws them: group rows for a records
 *  proposal of two or more changes, subject cards for everything else; the
 *  names the totals and groups are titled with; and the totals. */
export type ProposalEntryModel = {
  work: ReturnType<typeof orgProposalWork>;
  /** Two or more record changes: the body is group rows. */
  records: boolean;
  cards: SubjectCard[];
  groups: RecordGroupCard[];
  names: OrgAskNames | undefined;
  live: SubjectLive | null;
  totals: { count: string; line: string | null };
};

export function useProposalEntries(proposal: Proposal | undefined, changes: readonly OrgProposalChange[]): ProposalEntryModel {
  const { live, opts } = useCardInputs(proposal, changes);
  return useMemo(() => {
    const rows = changes.filter((c) => c.status !== "removed");
    const work = orgProposalWork(rows);
    const records = work === "records" && rows.length > 1;
    const named = (xs: readonly { _id: string; title: string; short_id?: string }[]) => xs.map((p) => ({ id: p._id, title: p.title, short_id: p.short_id }));
    const names = askNames(live?.tree, live ? { projects: named(live.projects), plans: named(live.plans) } : undefined);
    return {
      work, records, names, live,
      cards: records ? [] : proposalSubjects(changes, live, opts),
      groups: records ? recordGroupCards(changes, names) : [],
      totals: proposalTotals(rows, names),
    };
  }, [changes, live, opts]);
}

// ---------------------------------------------------------------- the batch

export type ProposalBatch<K extends string | null = string | null> = { key: K; comments: readonly PendingComment[] | undefined; send?: () => void };

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

/** A pending item of the batch as the card reads it. */
function answerOf(pending: (PendingComment & { proposal: PendingProposalAnswer }) | undefined): SubjectAnswer | null {
  return pending ? { verdict: pending.proposal.verdict, ...(pending.body ? { text: pending.body } : {}), ...(pending.proposal.leave_sessions ? { leave_sessions: true } : {}) } : null;
}

/** The latest revise over a set of rows, 0 when none. */
const revisedAt = (members: readonly Pick<OrgProposalChange, "revision">[]) => Math.max(0, ...members.map((m) => m.revision?.at ?? 0));

/**
 * The pending answer of one entry, and the handler that puts, replaces or
 * withdraws it; with no key (nowhere to send) there is no handler, and the
 * entry draws read only. A revision landing while an answer is staged
 * withdraws the item: the band disappears and the controls come back under
 * "Revised since you last looked", so nothing stale reaches the send.
 */
function useEntryAnswer(key: string | null, comments: readonly PendingComment[] | undefined, ref: ProposalCardRef, members: readonly Pick<OrgProposalChange, "revision">[]): { answer: SubjectAnswer | null; onAnswer?: (answer: SubjectAnswer | null) => void; revised: boolean } {
  const pending = pendingAnswerOf(comments, ref.proposal.id, ref.key);
  const answer = useMemo(() => answerOf(pending), [pending]);
  const stale = !!key && !!pending && revisedAt(members) > pending.createdAt;
  // Withdrawn under the reader: the entry says so until they answer again.
  const [revised, setRevised] = useState(false);
  useWatchEffect(() => { if (stale) { answerProposalCard(key!, ref, null); setRevised(true); } }, [stale]); // eslint-disable-line react-hooks/exhaustive-deps
  useWatchEffect(() => { if (pending && !stale) setRevised(false); }, [pending, stale]);
  return { answer: stale ? null : answer, revised, ...(key ? { onAnswer: (a: SubjectAnswer | null) => answerProposalCard(key, ref, a) } : {}) };
}

/** The pending answer of one card (the subject card's entry). `number` is the ordinal the person sees, for the tray. */
function useCardAnswer(proposal: Proposal, key: string | null, comments: readonly PendingComment[] | undefined, card: SubjectCard, number?: number): { answer: SubjectAnswer | null; onAnswer?: (answer: SubjectAnswer | null) => void; revised: boolean } {
  return useEntryAnswer(key, comments, cardRef(proposal, card, number), [...card.changes, ...card.carried, ...card.riders]);
}

/** What a ref is built from: a card, or anything that holds changes the same way. */
export type CardMembers = Pick<SubjectCard, "key" | "changes" | "carried" | "riders" | "change_ids" | "sentence"> & Partial<Pick<SubjectCard, "title">>;

/**
 * The card as the batch names it: the proposal, the key, and what the answer
 * is about, which is what still waits. `change_ids` is every waiting member
 * in apply order (riders and carried rows included, so the server decides
 * the whole card); `seqs` is what the words name: the waiting changes the
 * card draws, or, for a card that draws none (a limit alone is its own
 * sentence), the ones it holds. `subject` names the row in the tray.
 */
export function cardRef(proposal: ProposalRef, card: CardMembers, number?: number): ProposalCardRef {
  const members = [...card.changes, ...card.carried, ...card.riders];
  const waits = members.filter((c) => isOrgChangeDecidable(c.status));
  // Nothing waits (a card read after it was decided): the card as it stands.
  const of = waits.length ? waits : members;
  const ids = new Set(of.map((c) => c._id));
  const drawn = card.changes.filter((c) => ids.has(c._id));
  const seqs = (drawn.length ? drawn : of).map((c) => c.seq).sort((a, b) => a - b);
  return {
    proposal: { id: proposal._id, short_id: proposal.short_id, title: proposal.title }, key: card.key, change_ids: card.change_ids.filter((id) => ids.has(id)), seqs, sentence: card.sentence,
    ...(number !== undefined ? { ordinal: number } : {}), ...(card.title ? { subject: card.title } : {}),
  };
}

/** A record group as the batch names it: the records that still wait, in
 *  apply order (a group read after it was decided: all of them), its title as
 *  the subject. So the send counts and names only what it will apply. */
export function groupRef(proposal: ProposalRef, group: RecordGroupCard): ProposalCardRef {
  const waits = group.rows.filter((r) => isOrgChangeDecidable(r.status));
  const of = waits.length ? waits : group.rows;
  const ids = new Set(of.map((r) => r.change._id));
  return { proposal: { id: proposal._id, short_id: proposal.short_id, title: proposal.title }, key: group.key, change_ids: group.change_ids.filter((id) => ids.has(id)), seqs: of.map((r) => r.seq), sentence: group.title, subject: group.title };
}

/** The changes have not landed yet. */
export const ProposalLoading = () => (
  <div className="space-y-1.5" aria-hidden data-proposal-loading>
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
function AnsweredCard({ proposal, batch, card, number, focusId, ...rest }: { proposal: Proposal; batch: ProposalBatch; card: SubjectCard; number?: number; focusId: string | null } & Omit<React.ComponentProps<typeof ProposalSubjectCard>, "card" | "answer" | "onAnswer" | "focused">) {
  const { answer, onAnswer, revised } = useCardAnswer(proposal, batch.key, batch.comments, card, number);
  const focused = !!focusId && [...card.changes, ...card.carried, ...card.riders].some((c) => c._id === focusId);
  return <ProposalSubjectCard card={card} answer={answer} onAnswer={proposal.status === "open" ? onAnswer : undefined} focused={focused} revisedNew={revised || undefined} {...rest} />;
}

function AnsweredGroup({ proposal, batch, group, focus, lone, open, onOpen }: { proposal: Proposal; batch: ProposalBatch; group: RecordGroupCard; focus: OrgProposalChange | null; lone: boolean; open: boolean; onOpen: (v: boolean) => void }) {
  const { answer, onAnswer, revised } = useEntryAnswer(batch.key, batch.comments, groupRef(proposal, group), group.rows.map((r) => r.change));
  const focusSeq = focus && group.seqs.includes(focus.seq) ? focus.seq : null;
  return <RecordGroupRow card={group} answer={answer} onAnswer={proposal.status === "open" ? onAnswer : undefined} open={open} onOpen={onOpen} lone={lone} focusSeq={focusSeq} revisedNew={revised || undefined} />;
}

/**
 * The entries of one proposal: one group row per record group (a records
 * proposal), else one subject card per subject, numbered when there are two
 * or more, twelve at a time with "Show all N" past that.
 */
export function ProposalEntries({ proposal, changes, entries, batch, limit = 12, className }: {
  proposal: Proposal;
  changes: readonly OrgProposalChange[];
  entries: ProposalEntryModel;
  batch: ProposalBatch;
  /** Page size for subject cards; "Show all N" past it. */
  limit?: number;
  className?: string;
}) {
  const [all, setAll] = useState(false);
  const [openKeys, setOpenKeys] = useState<ReadonlySet<string>>(() => new Set());
  const focus = useFocusChange(changes);
  const setOpen = (key: string, v: boolean) => setOpenKeys((prev) => { const next = new Set(prev); if (v) next.add(key); else next.delete(key); return next; });
  if (entries.records) {
    const lone = entries.groups.length === 1;
    return (
      <div className={cn("not-prose min-w-0", LEDGER_INKS, className)} data-proposal-groups={entries.groups.length}>
        {entries.groups.map((group) => <AnsweredGroup key={group.key} proposal={proposal} batch={batch} group={group} focus={focus} lone={lone} open={openKeys.has(group.key)} onOpen={(v) => setOpen(group.key, v)} />)}
      </div>
    );
  }
  const cards = entries.cards;
  const shown = !all && cards.length > limit ? cards.slice(0, limit) : cards;
  // A proposal of one card: its Approve is the frame's one filled button, and there is nothing to number.
  const lone = cards.length === 1;
  return (
    <div className={cn("not-prose min-w-0", LEDGER_INKS, className)} data-proposal-subjects={cards.length}>
      <ol className="m-0 list-none p-0">
        {shown.map((card, i) => (
          <li key={card.key} className="m-0 p-0">
            <AnsweredCard proposal={proposal} batch={batch} card={card} number={i + 1} focusId={focus?._id ?? null} {...(lone ? { lead: true, className: "py-[14px]" } : { ordinal: i + 1 })} />
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

// ---------------------------------------------------------------- the foot

/** What the foot counts: every entry that can still be answered. */
type Entry = { key: string; waiting: number; ref: ProposalCardRef };

/**
 * The foot of a proposal's ledger. Left: Map, when the card is not on the org
 * screen (`onMap`). Right, while anything waits and a batch key exists:
 * "Approve all N" while nothing is answered or decided, "Approve the rest"
 * once something is (a quiet word; it stages an approve on every waiting
 * entry with no answer, and pressed again withdraws only those). When
 * nothing waits, what happened in words. Read only: one quiet line, once.
 */
export function ProposalFoot({ proposal, entries, batch, onMap, takeover, className }: {
  proposal: Proposal & Pick<OrgProposalListRow, "author">;
  entries: ProposalEntryModel;
  batch: ProposalBatch;
  onMap?: () => void;
  /** What "Approve the rest" would take over (R1): the phrase, and the "leave them" box over the row, whose tick rides on the approvals it puts as `leave_sessions`. */
  takeover?: { phrase: string } | null;
  className?: string;
}) {
  const answers = proposalAnswersOf(batch.comments, proposal._id);
  // The entries "Approve the rest" put an answer on, so a second press takes back only those.
  const [put, setPut] = useState<string[]>([]);
  const [leaveLocal, setLeaveLocal] = useState(false);
  const withdrawn = proposal.status === "withdrawn";
  const list: Entry[] = entries.records
    ? entries.groups.map((g) => ({ key: g.key, waiting: g.waiting, ref: groupRef(proposal, g) }))
    : entries.cards.map((c, i) => ({ key: c.key, waiting: c.waiting, ref: cardRef(proposal, c, i + 1) }));
  const open = list.filter((e) => e.waiting > 0).length;
  const answered = new Set(answers.map((a) => a.proposal.card));
  const rest = list.filter((e) => e.waiting > 0 && !answered.has(e.key));
  const putStill = put.filter((k) => answers.some((a) => a.proposal.card === k && a.proposal.verdict === "approve"));
  const pressed = putStill.length > 0;
  const leave = pressed ? answers.some((a) => putStill.includes(a.proposal.card) && a.proposal.leave_sessions) : leaveLocal;
  const write = (ref: ProposalCardRef, answer: SubjectAnswer | null) => { if (batch.key) answerProposalCard(batch.key, ref, answer); };
  const approve = (tick: boolean): SubjectAnswer => ({ verdict: "approve", ...(tick ? { leave_sessions: true } : {}) });
  const approveRest = () => {
    if (pressed) {
      for (const key of putStill) { const e = list.find((x) => x.key === key); if (e) write(e.ref, null); }
      setPut([]);
      return;
    }
    for (const e of rest) write(e.ref, approve(leave));
    setPut(rest.map((e) => e.key));
  };
  const onLeave = (v: boolean) => {
    setLeaveLocal(v);
    for (const key of putStill) { const e = list.find((x) => x.key === key); if (e) write(e.ref, approve(v)); }
  };
  const decided = list.some((e) => e.waiting === 0);
  const restLabel = answers.length === 0 && !decided ? `${ORG_REPLY_WORDS.approve.act} all ${rest.length}` : `${ORG_REPLY_WORDS.approve.act} the rest`;
  const answerable = !!batch.key && !withdrawn && proposal.status === "open" && open > 0;
  const records = entries.records ? entries.groups.flatMap((g) => g.rows.map((r) => r.change)) : undefined;
  const outcome = withdrawn ? "Withdrawn" : open === 0 ? proposalProgressWords(entries.cards, records) || "Nothing to decide" : undefined;
  const who = proposal.author?.name ? `${proposal.author.name}'s` : "the author's";
  return (
    <>
      {!answerable && open > 0 && !withdrawn && proposal.status === "open" && (
        <p className={cn("m-0 mt-2 text-[11px] leading-[18px] text-[color:var(--ink-quiet)]")} data-proposal-readonly-line>Open this in {who} thread to answer.</p>
      )}
      <LedgerClosingRow
        className={cn("mt-2", className)}
        above={takeover && answerable && (rest.length > 0 || pressed) && list.length > 1 ? <TakeoverEdit phrase={takeover.phrase} leave={leave} onLeave={onLeave} /> : undefined}
        left={onMap ? <LedgerWord onClick={onMap} aria-label="Show this proposal on the map" title="Open the org map beside this conversation" data-open-map={proposal.short_id}>Map</LedgerWord> : undefined}
        right={answerable && list.length > 1 && (rest.length > 0 || pressed) ? (
          <LedgerWord className={cn("-mr-2", pressed && "text-[color:var(--ink-violet)]")} aria-pressed={pressed} onClick={approveRest} data-approve-rest={rest.length}>
            {pressed && <Check className="-ml-0.5 mr-1 h-3 w-3" aria-hidden />}
            {restLabel}
          </LedgerWord>
        ) : undefined}
        outcome={outcome}
      />
    </>
  );
}
