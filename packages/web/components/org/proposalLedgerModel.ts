// A proposal's ledger as a model (docs/architecture/org-staffing.md S39): the
// entries of one proposal, the batch refs an answer is filed under, an
// entry's pending answer, and "Accept the rest". Pure of the DOM, so the web
// ledger (ProposalLedger.tsx) and the phone's card draw from the same rules.
// An answer fires nothing: it waits in the conversation's batch
// (`reviewComments[key]`) and the send applies it (lib/reviewActions).
import { useMemo, useState } from "react";
import { proposalTotals } from "@codecast/shared/contracts/orgChangeWords";
import { isOrgChangeDecidable, orgProposalWork, type OrgAskNames, type OrgReplyVerdict } from "@codecast/shared/contracts/orgProposal";
import type { PendingComment, PendingProposalAnswer } from "../../lib/quoteFormat";
import { answerProposalCard, pendingAnswerOf, type ProposalCardRef } from "../../lib/reviewActions";
import { useInboxStore } from "../../store/inboxStore";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { autonomyOn } from "@codecast/shared/contracts/roleAutonomy";
import type { OrgProposalChange, OrgProposalListRow } from "./orgStaffingTypes";
import { useSubjectLive } from "./proposalHooks";
import { proposalSubjects, recordGroupCards, type RecordGroupCard, type SubjectCard, type SubjectLive, type SubjectOptions } from "./proposalSubjects";
import { askNames } from "./staffingAsks";

/** A person's answer to one entry, as it waits in the batch. */
export type SubjectAnswer = { verdict: OrgReplyVerdict; text?: string; leave_sessions?: boolean };

/** The prompt in an entry's reply field, by the verdict it carries. */
export const FIELD_ASKS: Record<OrgReplyVerdict, string> = {
  reject: "Why not? Say what you want instead.",
  approve: "Say something about this change",
  note: "What should change?",
};

/** What a staged answer will do, as the band under an entry says it: the verdict, then when it acts. */
export function stagedWords(answer: SubjectAnswer): [string, string] {
  if (answer.verdict === "reject") return ["Rejected.", "Sent when you send."];
  if (answer.verdict === "note") return ["Adjust.", "Your words go back when you send."];
  if (answer.leave_sessions) return ["Accepted,", "and the sessions stay where they are. Applies when you send."];
  return ["Accepted.", "Applies when you send."];
}

/** The surface's confirm before approving new roles: show the review, and run `go` on its confirm. */
export type HireReview = (roles: ReturnType<typeof newRolesOf>, go: () => void) => void;

export type Proposal = Pick<OrgProposalListRow, "_id" | "short_id" | "title" | "status" | "team_id" | "scope_user_id" | "reply"> & Partial<Pick<OrgProposalListRow, "author" | "applied_by_author">>;
/** What a ref of the batch names a proposal by. */
export type ProposalRef = Pick<Proposal, "_id" | "short_id" | "title">;


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

/** A proposal's entries from its changes and the records they are read against. */
function entriesOf(changes: readonly OrgProposalChange[], live: SubjectLive | null, opts: SubjectOptions): ProposalEntryModel {
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
}

export function useProposalEntries(proposal: Proposal | undefined, changes: readonly OrgProposalChange[]): ProposalEntryModel {
  const { live, opts } = useCardInputs(proposal, changes);
  return useMemo(() => entriesOf(changes, live, opts), [changes, live, opts]);
}

/** Several proposals of one workspace read against the same records: each with its entries. */
export function useProposalSetEntries<P extends Proposal>(items: readonly { proposal: P; changes: readonly OrgProposalChange[] }[]): { proposal: P; changes: readonly OrgProposalChange[]; entries: ProposalEntryModel }[] {
  const all = useMemo(() => items.flatMap((i) => i.changes), [items]);
  const { live, opts } = useCardInputs(items[0]?.proposal, all);
  return useMemo(() => items.map((i) => ({ ...i, entries: entriesOf(i.changes, live, opts) })), [items, live, opts]);
}

export type ProposalBatch<K extends string | null = string | null> = { key: K; comments: readonly PendingComment[] | undefined; send?: () => void };

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
export function useEntryAnswer(key: string | null, comments: readonly PendingComment[] | undefined, ref: ProposalCardRef, members: readonly Pick<OrgProposalChange, "revision">[]): { answer: SubjectAnswer | null; onAnswer?: (answer: SubjectAnswer | null) => void; revised: boolean } {
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
export function useCardAnswer(proposal: Proposal, key: string | null, comments: readonly PendingComment[] | undefined, card: SubjectCard, number?: number): { answer: SubjectAnswer | null; onAnswer?: (answer: SubjectAnswer | null) => void; revised: boolean } {
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

/** The new roles a set of changes would create, still waiting, as the online review reads them. A hired role starts on unless the change says otherwise. */
export function newRolesOf(changes: readonly OrgProposalChange[]) {
  return changes.flatMap((c) => (c.change.kind === "role" && isOrgChangeDecidable(c.status)
    ? [{ handle: c.change.handle.replace(/^@/, ""), name: c.change.name, startsOnItsOwn: c.change.trust ? autonomyOn(c.change.trust) : true, sessionsPerDay: c.change.caps?.hands_per_day ?? 6 }]
    : []));
}

/** What "Accept all" counts: every entry that can still be answered, with the changes a hire review reads. */
export type BatchEntry = { waiting: number; ref: ProposalCardRef; changes: readonly OrgProposalChange[] };
const entryId = (proposalId: string, key: string) => `${proposalId}|${key}`;

/**
 * "Accept all" over entries of one proposal or many: the press stages an
 * accept on every waiting entry with no answer, and pressed again withdraws
 * only those. Approving a new role goes through `review` (the surface's
 * consequential confirm) first.
 * `retick` rewrites the staged accepts with or without the "leave them" tick.
 */
export function useAcceptRest(list: readonly BatchEntry[], batch: ProposalBatch, review: HireReview) {
  const [put, setPut] = useState<string[]>([]);
  const proposals = new Set(list.map((e) => e.ref.proposal.id));
  const answers = (batch.comments ?? []).filter((c): c is PendingComment & { proposal: PendingProposalAnswer } => !!c.proposal && proposals.has(c.proposal.id));
  const idOf = (a: { proposal: PendingProposalAnswer }) => entryId(a.proposal.id, a.proposal.card);
  const answered = new Set(answers.map(idOf));
  const rest = list.filter((e) => e.waiting > 0 && !answered.has(entryId(e.ref.proposal.id, e.ref.key)));
  const putStill = put.filter((id) => answers.some((a) => idOf(a) === id && a.proposal.verdict === "approve"));
  const write = (ref: ProposalCardRef, answer: SubjectAnswer | null) => { if (batch.key) answerProposalCard(batch.key, ref, answer); };
  const approve = (tick: boolean): SubjectAnswer => ({ verdict: "approve", ...(tick ? { leave_sessions: true } : {}) });
  const staged = () => putStill.flatMap((id) => list.filter((e) => entryId(e.ref.proposal.id, e.ref.key) === id));
  const press = (leave = false) => {
    if (putStill.length) { for (const e of staged()) write(e.ref, null); setPut([]); return; }
    const go = () => { for (const e of rest) write(e.ref, approve(leave)); setPut(rest.map((e) => entryId(e.ref.proposal.id, e.ref.key))); };
    const roles = newRolesOf(rest.flatMap((e) => e.changes));
    if (roles.length) review(roles, go); else go();
  };
  const retick = (v: boolean) => { for (const e of staged()) write(e.ref, approve(v)); };
  return {
    rest, answers,
    pressed: putStill.length > 0,
    leave: answers.some((a) => putStill.includes(idOf(a)) && !!a.proposal.leave_sessions),
    press, retick,
  };
}
