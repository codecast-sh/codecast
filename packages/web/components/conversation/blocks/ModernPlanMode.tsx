import { useState } from "react";
import { Map as MapIcon } from "lucide-react";
import { Button } from "../../ui/button";
import { MessageReview } from "../../MessageReview";
import { renderAssistantBody } from "../../../lib/renderAssistantBody";
import { failureLine } from "../../../lib/modernRow";
import { ModernAnsweredRow, ModernAskCard } from "../ModernAsk";
import { ModernClamp } from "./ModernQuietBlock";
import type { ToolResult } from "../types";

/**
 * Plan mode in the Modern style (PlanModeBlock branches here). Entering or
 * leaving it is a row; a plan waiting on the person is the loud card, the plan
 * on its tinted panel (quotable through MessageReview, so its notes become the
 * request for changes) and the three answers as Buttons. Answered, it folds to
 * one row that says which.
 */
export function ModernPlanMode({ enter, plan, result, waiting, sent, reviewKey, conversationId, pendingCount, onStart, onRequestChanges }: {
  enter: boolean;
  plan: string;
  result?: ToolResult;
  /** Waiting for the person's approval in this view. */
  waiting: boolean;
  sent: boolean;
  /** The plan's own review batch, when it can be quoted. */
  reviewKey?: string;
  conversationId?: string;
  pendingCount: number;
  onStart: (keepContext: boolean) => void;
  onRequestChanges: () => void;
}) {
  const [choice, setChoice] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const title = plan.match(/^#+\s+(.+)$/m)?.[1] ?? plan.split("\n").find((l) => l.trim())?.trim();
  const body = plan ? (
    <div data-cc-prose className="text-sol-text prose prose-invert prose-sm max-w-none">
      {waiting && reviewKey && conversationId ? (
        <MessageReview conversationId={conversationId} messageId={reviewKey} content={plan} renderBlock={renderAssistantBody} />
      ) : renderAssistantBody(plan)}
    </div>
  ) : null;

  if (waiting) {
    const quotable = !!reviewKey && !!conversationId && !!plan;
    const start = (keep: boolean) => { setChoice(keep ? "Start, keep context" : "Start, clear context"); onStart(keep); };
    return (
      <ModernAskCard kicker="Plan" question={title ? `Start on “${title}”?` : "Start on this plan?"} data-cc-plan-approval>
        {body && (
          <div className="rounded-card border border-sol-border bg-[var(--cc-m-tint)] px-4 py-3">
            <ModernClamp max={480} watch={plan}>{body}</ModernClamp>
          </div>
        )}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button type="button" size="md" variant="primary" onClick={() => start(false)}>Start, clear context</Button>
          <Button type="button" size="md" variant="outline" onClick={() => start(true)}>Start, keep context</Button>
          <Button
            type="button"
            size="md"
            variant="outline"
            onClick={() => { setChoice("Requested changes"); onRequestChanges(); }}
            disabled={quotable && pendingCount === 0}
            title={quotable && pendingCount === 0 ? "Quote a part of the plan first" : undefined}
          >
            Request changes{pendingCount > 0 ? ` · ${pendingCount}` : ""}
          </Button>
        </div>
      </ModernAskCard>
    );
  }

  if (sent && !result) return <ModernAnsweredRow verb="Plan" question={title ?? "Plan"} answer={choice ?? "Sent"} />;

  const outcome = result ? (result.is_error ? failureLine(result.content) || "rejected" : failureLine(result.content)) : null;
  const openable = !enter && !!body;
  const words = (
    <>
      <MapIcon data-cc-row-icon aria-hidden className="w-4 h-4 shrink-0" strokeWidth={1.75} />
      <span data-cc-row-verb>{enter ? "Entered plan mode" : "Plan"}</span>
      {!enter && title && <span data-cc-row-text>{title}</span>}
      {outcome && <span data-cc-row-meta className="max-w-[45%] overflow-hidden text-ellipsis">{outcome}</span>}
    </>
  );
  return (
    <div data-cc-row="plan-mode" data-cc-row-tone={result?.is_error ? "error" : undefined}>
      {openable ? (
        <button type="button" data-cc-row-head aria-expanded={open} onClick={() => setOpen((v) => !v)} className="w-full text-left">{words}</button>
      ) : (
        <div data-cc-row-head>{words}</div>
      )}
      {open && body && (
        <div data-cc-row-detail className="px-4 py-3">
          <ModernClamp watch={plan}>{body}</ModernClamp>
        </div>
      )}
    </div>
  );
}
