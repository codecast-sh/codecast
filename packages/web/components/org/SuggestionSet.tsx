"use client";
// The Head of People's open suggestions in the org drawer, as one set
// (docs/architecture/org-staffing.md S45; the split is suggestionSetModel.ts): what
// it suggests in one line, then every piece still waiting, oldest first, each
// with its age, and "Accept all" over the whole set. A piece opens in place to
// its full card, whose answers are the same controls as everywhere else.
// Answers go to the drawer's thread's batch; its send applies them, one
// reply per proposal into each author's thread.
//
// Proposals a newer one replaced, and proposals another author posted, are
// named under the set: the first to withdraw, the second to open.
import React, { useMemo, useState } from "react";
import { Check, ChevronRight } from "lucide-react";
import { proposalTotals } from "@codecast/shared/contracts/orgChangeWords";
import { ORG_REPLY_WORDS } from "@codecast/shared/contracts/orgProposal";
import { useInboxStore } from "../../store/inboxStore";
import { useSyncOrgProposal } from "../../hooks/useSyncOrgProposals";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { pendingAnswerOf } from "../../lib/reviewActions";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { AnsweredCard, AnsweredGroup, cardRef, groupRef, useAcceptRest, useProposalBatch, useProposalSetEntries, type BatchEntry, type ProposalBatch } from "./ProposalLedger";
import { PinnedLead } from "./PinnedLead";
import { LEDGER_HAIR, LEDGER_INKS } from "./ProposalSubjectCard";
import type { SubjectCard } from "./proposalSubjects";
import type { RecordGroupCard } from "./proposalSubjects";
import { ageWords, pieceAge, STALE_PIECE_MS, splitSuggestions, waitingChanges } from "./suggestionSetModel";
import type { OrgProposalChange, OrgProposalListRow } from "./orgStaffingTypes";
import type { OrgWorkspaceRef } from "./staffingModel";

/** Mounts one proposal's feeder: its changes reach the store. */
function Feed({ refId }: { refId: string }) {
  useSyncOrgProposal(refId);
  return null;
}

const changesSig = (all: Record<string, OrgProposalChange>, ids: ReadonlySet<string>): string => {
  let sig = "";
  for (const c of Object.values(all)) if (ids.has(c.proposal_id)) sig += `${c._id}:${c.status}:${c.revision?.at ?? 0}:${c.reply?.at ?? 0}|`;
  return sig;
};

/** The changes of several proposals, re-read only when one of them moves. */
function useSetChanges(rows: readonly OrgProposalListRow[]): { proposal: OrgProposalListRow; changes: OrgProposalChange[] }[] {
  const ids = useMemo(() => new Set(rows.map((r) => r._id)), [rows]);
  const sig = useInboxStore((s) => changesSig(s.orgProposalChanges, ids));
  return useMemo(() => {
    const all = Object.values(useInboxStore.getState().orgProposalChanges as Record<string, OrgProposalChange>);
    return rows.map((proposal) => ({ proposal, changes: all.filter((c) => c.proposal_id === proposal._id).sort((a, b) => a.seq - b.seq) }));
  }, [sig, rows]); // eslint-disable-line react-hooks/exhaustive-deps
}

type Piece =
  | { kind: "card"; key: string; proposal: OrgProposalListRow; card: SubjectCard; at: number; entry: BatchEntry }
  | { kind: "group"; key: string; proposal: OrgProposalListRow; group: RecordGroupCard; at: number; entry: BatchEntry };

/** How long a suggestion has waited; orange once it is stale. `settled`: it waits no more, so it is never stale. */
export function Age({ at, now, settled }: { at: number; now: number; settled?: boolean }) {
  const stale = !settled && now - at > STALE_PIECE_MS;
  return (
    <span className="shrink-0 text-[11.5px] tabular-nums" style={{ color: stale ? "var(--sol-orange)" : "var(--sol-text-dim)" }} title={new Date(at).toLocaleString()} data-piece-age={stale ? "stale" : "fresh"}>
      {ageWords(at, now)}
    </span>
  );
}

/** The staged answer on a folded piece: what the send will do with it. */
function StagedWord({ verdict }: { verdict: "approve" | "reject" | "note" }) {
  const ink = verdict === "approve" ? "var(--ink-green)" : verdict === "reject" ? "var(--ink-red)" : "var(--ink-violet)";
  return <span className="inline-flex shrink-0 items-center gap-1 text-[11.5px] font-medium" style={{ color: ink }} data-piece-staged={verdict}>{verdict === "approve" && <Check className="h-3 w-3" aria-hidden />}{ORG_REPLY_WORDS[verdict].done}</span>;
}

/** One sentence, its subject in bold. */
function Sentence({ card }: { card: SubjectCard }) {
  const s = card.sentence, span = card.subjectSpan;
  if (!span) return <>{s}</>;
  return <>{s.slice(0, span[0])}<b className="font-semibold" style={{ color: "var(--sol-text)" }}>{s.slice(span[0], span[1])}</b>{s.slice(span[1])}</>;
}

function CardPiece({ piece, n, batch, now, open, onOpen }: { piece: Extract<Piece, { kind: "card" }>; n: number; batch: ProposalBatch; now: number; open: boolean; onOpen: (v: boolean) => void }) {
  const staged = pendingAnswerOf(batch.comments, piece.proposal._id, piece.card.key)?.proposal.verdict;
  return (
    <li className="m-0 border-t p-0 first:border-t-0" style={{ borderColor: LEDGER_HAIR }} data-suggestion-piece={piece.key} data-piece-open={open || undefined}>
      {open ? (
        <>
          <button type="button" onClick={() => onOpen(false)} aria-expanded className="flex w-full items-center gap-2.5 pt-2 text-left" data-piece-fold>
            <span className="min-w-0 flex-1 truncate text-[11.5px]" style={{ color: "var(--sol-text-dim)" }}>{piece.proposal.title}</span>
            {staged && <StagedWord verdict={staged} />}
            <Age at={piece.at} now={now} />
            <ChevronRight className="h-3.5 w-3.5 shrink-0 rotate-90" style={{ color: "var(--sol-text-dim)" }} aria-hidden />
          </button>
          <AnsweredCard proposal={piece.proposal} batch={batch} card={piece.card} number={n} focusId={null} ordinal={n} className="border-t-0" />
        </>
      ) : (
        <button type="button" onClick={() => onOpen(true)} aria-expanded={false} className="flex w-full items-baseline gap-2.5 py-2 text-left">
          <span className="w-4 shrink-0 text-right text-[11.5px] tabular-nums" style={{ color: "var(--sol-text-dim)" }}>{n}</span>
          <span className="min-w-0 flex-1 text-[13px] leading-[19px] [text-wrap:pretty]" style={{ color: "var(--sol-text-muted)" }}><Sentence card={piece.card} /></span>
          {staged && <StagedWord verdict={staged} />}
          <Age at={piece.at} now={now} />
          <ChevronRight className="h-3.5 w-3.5 shrink-0 self-center" style={{ color: "var(--sol-text-dim)" }} aria-hidden />
        </button>
      )}
    </li>
  );
}

function GroupPiece({ piece, batch, now, open, onOpen }: { piece: Extract<Piece, { kind: "group" }>; batch: ProposalBatch; now: number; open: boolean; onOpen: (v: boolean) => void }) {
  return (
    <li className="m-0 border-t p-0 first:border-t-0" style={{ borderColor: LEDGER_HAIR }} data-suggestion-piece={piece.key}>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1"><AnsweredGroup proposal={piece.proposal} batch={batch} group={piece.group} focus={null} lone={false} open={open} onOpen={onOpen} /></div>
        <span className="pt-2.5"><Age at={piece.at} now={now} /></span>
      </div>
    </li>
  );
}

/** The set, its pieces and "Accept all". */
function SetBody({ rows, name }: { rows: OrgProposalListRow[]; name: string }) {
  const items = useSetChanges(rows);
  const sets = useProposalSetEntries(items);
  const batch = useProposalBatch(rows[0]);
  const now = useCoarseNow(60_000);
  const [open, setOpen] = useState<string | null>(null);
  const pieces = useMemo<Piece[]>(() => sets.flatMap(({ proposal, entries }) => entries.records
    ? entries.groups.filter((g) => g.waiting > 0).map((group): Piece => ({ kind: "group", key: `${proposal._id}|${group.key}`, proposal, group, at: pieceAge(proposal.created_at, group.rows.map((r) => r.change)), entry: { waiting: group.waiting, ref: groupRef(proposal, group), changes: [] } }))
    : entries.cards.filter((c) => c.waiting > 0).map((card): Piece => ({ kind: "card", key: `${proposal._id}|${card.key}`, proposal, card, at: pieceAge(proposal.created_at, [...card.changes, ...card.carried, ...card.riders]), entry: { waiting: card.waiting, ref: cardRef(proposal, card), changes: card.changes } })),
  ).sort((a, b) => a.at - b.at), [sets]);
  const acceptAll = useAcceptRest(pieces.map((p) => p.entry), batch);
  const loading = items.some((i) => i.changes.length === 0);
  if (pieces.length === 0) return loading ? <div className="px-4 py-3 text-[12.5px]" style={{ color: "var(--sol-text-dim)" }}>Loading {name}'s suggestions…</div> : null;
  const waiting = sets.flatMap((s) => waitingChanges(s.changes));
  const summary = pieces.length > 1 ? proposalTotals(waiting, sets[0]?.entries.names).line?.replace(/^\d+ changes: /, "").replace(/\.$/, "") : null;
  const answerable = !!batch.key;
  const label = acceptAll.answers.length === 0 ? `${ORG_REPLY_WORDS.approve.act} all ${pieces.length}` : `${ORG_REPLY_WORDS.approve.act} the rest`;
  return (
    <div className={cn("not-prose", LEDGER_INKS)} data-suggestion-set={pieces.length}>
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-[13.5px] font-semibold" style={{ color: "var(--sol-text)" }}>Suggests {pieces.length === 1 ? "one change" : `${pieces.length} changes`}</div>
          {summary && <div className="mt-0.5 text-[12px] leading-[17px]" style={{ color: "var(--sol-text-muted)" }} data-suggestion-summary>{summary}</div>}
        </div>
        {answerable && pieces.length > 1 && (acceptAll.rest.length > 0 || acceptAll.pressed) && (
          <Button variant={acceptAll.pressed ? "outline" : "green"} size="xs" aria-pressed={acceptAll.pressed} onClick={() => acceptAll.press()} data-suggestion-accept-all={acceptAll.rest.length}>
            {acceptAll.pressed && <Check aria-hidden />}{acceptAll.pressed ? `${acceptAll.answers.length} staged` : label}
          </Button>
        )}
      </div>
      <ol className="m-0 mt-2 list-none p-0">
        {pieces.map((p, i) => p.kind === "card"
          ? <CardPiece key={p.key} piece={p} n={i + 1} batch={batch} now={now} open={open === p.key} onOpen={(v) => setOpen(v ? p.key : null)} />
          : <GroupPiece key={p.key} piece={p} batch={batch} now={now} open={open === p.key} onOpen={(v) => setOpen(v ? p.key : null)} />)}
      </ol>
      {acceptAll.element}
    </div>
  );
}

/** A replaced proposal: the person withdraws it, one press (turning a thing off). */
function Replaced({ row }: { row: OrgProposalListRow }) {
  const withdraw = useInboxStore((s) => s.withdrawOrgProposal);
  return (
    <div className="flex items-center gap-2 py-1 text-[12px]" style={{ color: "var(--sol-text-dim)" }} data-suggestion-replaced={row.short_id}>
      <span className="min-w-0 flex-1 truncate"><span className="line-through">{row.title}</span> · replaced by {row.superseded_by?.short_id}</span>
      <Button variant="ghost" size="xs" onClick={() => withdraw(row._id)}>Withdraw</Button>
    </div>
  );
}

/** Proposals another author posted: one row each, opening it in the drawer. */
function Others({ rows, onOpen, now }: { rows: OrgProposalListRow[]; onOpen: (ref: string) => void; now: number }) {
  return (
    <div className="mt-2 border-t pt-2" style={{ borderColor: LEDGER_HAIR }} data-suggestion-others={rows.length}>
      <div className="pb-0.5 text-[11px] font-medium uppercase tracking-wide" style={{ color: "var(--sol-text-dim)" }}>Asked by others</div>
      {rows.map((p) => (
        <button key={p._id} type="button" onClick={() => onOpen(p.short_id)} className="-mx-2 flex w-[calc(100%+16px)] items-baseline gap-2.5 rounded-md px-2 py-1.5 text-left hover:bg-sol-bg-highlight" data-org-open-proposal={p.short_id}>
          <span className="min-w-0 flex-1 truncate text-[13px]" style={{ color: "var(--sol-text)" }}>{p.title}</span>
          <span className="shrink-0 truncate text-[11.5px]" style={{ color: "var(--sol-text-dim)" }}>{p.author?.name ?? p.author?.handle ?? ""}</span>
          <Age at={p.created_at} now={now} />
        </button>
      ))}
    </div>
  );
}

/** The drawer's lead over the Head of People's thread: its set, then what else waits. */
export function SuggestionSet({ workspace, headRoleId, name, onOpen }: { workspace: OrgWorkspaceRef | null; headRoleId: string | null; name: string; onOpen: (ref: string) => void }) {
  const rows = useInboxStore((s) => s.orgProposals) as Record<string, OrgProposalListRow> | undefined;
  const split = useMemo(() => splitSuggestions(Object.values(rows ?? {}), workspace, headRoleId), [rows, workspace, headRoleId]);
  const now = useCoarseNow(60_000);
  if (split.set.length + split.replaced.length + split.others.length === 0) return null;
  return (
    <PinnedLead data-org-open-proposals={split.set.length + split.others.length}>
      {split.set.map((r) => <Feed key={r._id} refId={r.short_id} />)}
      {split.set.length > 0 && <SetBody rows={split.set} name={name} />}
      {split.replaced.map((r) => <Replaced key={r._id} row={r} />)}
      {split.others.length > 0 && <Others rows={split.others} onOpen={onOpen} now={now} />}
    </PinnedLead>
  );
}
