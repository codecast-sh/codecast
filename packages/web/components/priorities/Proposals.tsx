// The merges the pass proposed, beside what waits on the person (Waiting.tsx):
// one card each, saying in plain words what Accept does, with the pass's
// reason, Accept and Reject. Accept merges as the pass would have; Reject
// keeps the two apart for every later pass (convex priorityWrite
// doAnswerProposal). A pressed card leaves at once; a refusal brings it back
// with the server's reason. No proposal, nothing shows.
import { useState } from "react";
import { toast } from "sonner";
import type { PriorityMergeProposal, PriorityProposalSide } from "@codecast/shared/contracts/priorities";
import { serverErrorText } from "../../lib/errorCause";
import { COARSE_TALL, type ListLayout } from "../../lib/priorityList";
import { isRefusedDispatchError } from "../../store/mutativeMiddleware";
import { useInboxStore } from "../../store/inboxStore";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";

const named = (s: PriorityProposalSide) => `${s.rank != null ? `#${s.rank} ` : ""}${s.title}`;

/** "Merge #4 Deploy redesign into #2 Deploys that are simple and reliable?" */
export const proposalQuestion = (p: PriorityMergeProposal) => `Merge ${named(p.priority)} into ${named(p.into)}?`;

/** Each priority a pending proposal names, by short id, with the line its row shows. */
export function proposalMarks(proposals: PriorityMergeProposal[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const p of proposals) {
    if (!out.has(p.priority.short_id)) out.set(p.priority.short_id, `Proposed: merge into ${named(p.into)}`);
    if (!out.has(p.into.short_id)) out.set(p.into.short_id, `Proposed: ${named(p.priority)} merges into this`);
  }
  return out;
}

/** A row's sign that a merge proposal names it: its words in the title, the dot beside. */
export function MergeMark({ text }: { text: string }) {
  return (
    <span data-merge-pending title={`${text}: answer it above the list`} className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-mark text-sol-text-dim">
      <i aria-hidden className="block size-[5px] rounded-full bg-sol-yellow" />merge proposed
    </span>
  );
}

function ProposalCard({ proposal, layout, onAnswer }: { proposal: PriorityMergeProposal; layout: ListLayout; onAnswer: (accept: boolean) => void }) {
  const wide = layout === "wide";
  return (
    <div data-proposal={proposal._id} className={cn("flex gap-x-3 gap-y-1.5 rounded-control px-1.5 py-1", wide ? "items-center" : "flex-col")}>
      <div className="min-w-0 flex-1">
        <div data-proposal-question className="text-ui font-medium text-sol-text">{proposalQuestion(proposal)}</div>
        {proposal.reason && <div data-proposal-reason className="text-meta text-sol-text-muted">{proposal.reason}</div>}
      </div>
      <div className="flex shrink-0 gap-1.5">
        <Button size="xs" variant="primary" data-proposal-accept onClick={() => onAnswer(true)} className={cn(COARSE_TALL, !wide && "h-11 flex-1")}>Accept</Button>
        <Button size="xs" variant="outline" data-proposal-reject onClick={() => onAnswer(false)} className={cn(COARSE_TALL, !wide && "h-11 flex-1")}>Reject</Button>
      </div>
    </div>
  );
}

export function MergeProposals({ proposals, layout }: { proposals: PriorityMergeProposal[]; layout: ListLayout }) {
  // Pressed and not yet refused: hidden until the list's next answer drops them for good.
  const [answered, setAnswered] = useState<ReadonlySet<string>>(new Set());
  const shown = proposals.filter((p) => !answered.has(p._id));
  if (!shown.length) return null;
  const answer = (id: string, accept: boolean) => {
    setAnswered((s) => new Set(s).add(id));
    useInboxStore.getState().answerPriorityProposal(id, accept).catch((e: unknown) => {
      setAnswered((s) => {
        const next = new Set(s);
        next.delete(id);
        return next;
      });
      if (isRefusedDispatchError(e)) toast.error(serverErrorText(e));
    });
  };
  return (
    <section data-proposals className="mb-3 rounded-lg border border-sol-yellow/45 bg-sol-yellow/[0.06] px-1.5 pb-1 pt-1.5">
      <div className="px-1.5 text-mark font-semibold uppercase tracking-wide text-sol-text-muted">Proposed merges · {shown.length}</div>
      {shown.map((p) => <ProposalCard key={p._id} proposal={p} layout={layout} onAnswer={(accept) => answer(p._id, accept)} />)}
    </section>
  );
}
