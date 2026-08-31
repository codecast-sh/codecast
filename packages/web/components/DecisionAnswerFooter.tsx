"use client";

import { useState } from "react";
import { Check, ChevronDown, ChevronRight, CornerUpLeft } from "lucide-react";
import { pickAnsweredDecision, type DecisionAnswerMessage } from "@codecast/shared/contracts";
import { api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore, isConvexId } from "../store/inboxStore";
import { useQueryNoThrow } from "../hooks/useQueryNoThrow";
import { useJumpToDecisionAsk } from "../hooks/useJumpToDecisionAsk";
import { MarkdownRenderer } from "./tools/MarkdownRenderer";
import { PublishedPageEmbed } from "./PublishedPageEmbed";

// The strip under a decision answer bubble: which question this answered, a
// way back to the `cast decide` call, and (unfolded) the options with the
// chosen one marked plus the agent's reasoning. A tagged answer carries the
// id and the question on the wire, so its closed strip renders from the
// transcript alone and unfolding reads the decision row from the store (the
// queue keeps resolved rows a day) or fetches it once by id. A legacy answer
// ("Decision: <label>" from before the tag shipped) carries neither, so the
// row is resolved by conversation + label — eagerly, because the closed
// strip's question line depends on it. Both lookups are enrichment: a
// missing row degrades to the text on the wire rather than an error.
export function DecisionAnswerFooter({ decision, conversationId, timestamp }: { decision: DecisionAnswerMessage; conversationId?: string; timestamp?: number }) {
  const [open, setOpen] = useState(false);
  const storeRow = useInboxStore((s) => {
    if (decision.id) return s.sessionDecisions[decision.id];
    // Legacy: the conversation's answered row whose recorded answer matches,
    // resolution nearest the message when the same label answered twice.
    const rows = Object.values(s.sessionDecisions).filter(
      (r) => r.conversation_id === conversationId && r.status === "answered",
    );
    return pickAnsweredDecision(rows, decision.answer, timestamp) ?? undefined;
  });
  const { data: fetchedById } = useQueryNoThrow(
    api.sessionDecisions.get,
    open && !storeRow && isConvexId(decision.id) ? { decision_id: decision.id as any } : "skip",
  );
  const legacyLookup = !decision.id && !storeRow && !!conversationId && isConvexId(conversationId);
  const { data: fetchedByAnswer } = useQueryNoThrow(
    api.sessionDecisions.findByAnswer,
    legacyLookup ? { conversation_id: conversationId as any, answer: decision.answer, near: timestamp } : "skip",
  );
  // Until convex codegen picks up findByAnswer, its result is untyped; it
  // returns answerBubbleShape, the same shape the store row carries.
  const row = storeRow ?? fetchedById ?? (fetchedByAnswer as typeof storeRow) ?? null;
  const question = row?.question ?? decision.question ?? "";
  const jump = useJumpToDecisionAsk(conversationId, decision.id || row?._id, question);
  const loading = !row && ((open && isConvexId(decision.id) && fetchedById === undefined) || (legacyLookup && fetchedByAnswer === undefined));
  const chosen = row
    ? row.answer_index ?? row.options.findIndex((o) => o.label === decision.answer)
    : -1;

  return (
    <div className="ml-8 mt-2 rounded-md border border-sol-border/70 bg-sol-bg-alt/40 text-[12px] max-w-[42rem]">
      <div className="flex items-center gap-2 px-2.5 py-1.5 min-w-0">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="flex items-center gap-2 min-w-0 flex-1 text-left text-sol-text-muted hover:text-sol-text transition-colors"
        >
          {open ? <ChevronDown className="w-3 h-3 shrink-0" /> : <ChevronRight className="w-3 h-3 shrink-0" />}
          <span className="uppercase tracking-wide text-[10px] text-sol-text-dim shrink-0">decision</span>
          {question ? (
            <span className={open ? "" : "truncate"}>{question}</span>
          ) : (
            <span className="text-sol-text-dim">the agent's question</span>
          )}
        </button>
        <button
          type="button"
          onClick={() => void jump()}
          title="Go to the ask in the conversation"
          className="flex items-center gap-1 shrink-0 text-[11px] text-sol-text-dim hover:text-sol-text hover:underline transition-colors"
        >
          <CornerUpLeft className="w-3 h-3" />
          the ask
        </button>
      </div>
      {open && (
        <div className="px-2.5 pb-2.5 pt-2 space-y-2.5 border-t border-sol-border/60">
          {row ? (
            <ol className="space-y-1">
              {row.options.map((opt, i) => {
                const picked = i === chosen;
                return (
                  <li key={i} className={`flex items-start gap-2 ${picked ? "text-sol-text" : "text-sol-text-dim"}`}>
                    <span className="w-3.5 h-3.5 mt-0.5 shrink-0 flex items-center justify-center">
                      {picked ? <Check className="w-3.5 h-3.5 text-sol-green" /> : <span className="text-[10px]">{i + 1}</span>}
                    </span>
                    <span className="min-w-0">
                      <span className={picked ? "font-medium" : ""}>{opt.label}</span>
                      {opt.description && <span className="text-sol-text-dim"> — {opt.description}</span>}
                    </span>
                  </li>
                );
              })}
              {chosen < 0 && (
                <li className="flex items-start gap-2 text-sol-text">
                  <Check className="w-3.5 h-3.5 mt-0.5 shrink-0 text-sol-green" />
                  <span className="font-medium">{decision.answer}</span>
                </li>
              )}
            </ol>
          ) : (
            <div className="text-sol-text-dim">{loading ? "Loading the question…" : "The full question is no longer available."}</div>
          )}
          {row?.context_md && (
            <div className="text-sol-text-muted [&_p]:my-1">
              <MarkdownRenderer content={row.context_md} />
            </div>
          )}
          {row?.report_slug && <PublishedPageEmbed slug={row.report_slug} />}
        </div>
      )}
    </div>
  );
}
