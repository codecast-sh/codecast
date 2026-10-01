"use client";
// First open (docs/architecture/org-staffing.md S14): the workspace has no
// roles yet, so the canvas is the person's own node plus this card: one
// paragraph and the two buttons that start a proposal ("Hire a Chief of
// Staff", "Propose an org now"). Designed, not blank; the buttons are the
// same actions the staffing pane offers. The guided walk over the page is the
// org tour (tours/registry.ts, "org-page"), started by "How this page works"
// and on its own after the first visit.
import { Sparkles, UserRoundPlus } from "lucide-react";
import { OrgButton } from "./OrgButton";
import type { OrgPerson } from "./orgTypes";

// ---------------------------------------------------------------- the empty canvas

export function OrgEmptyCanvas({ me, reviewing, reviewEnded, onOpenReview, onHireChief, onProposeNow, bottom = 44 }: {
  me: OrgPerson | null;
  /** "Propose an org now" is running; the buttons give way to that line. */
  reviewing: boolean;
  /** The review stopped with nothing posted: said above the buttons. */
  reviewEnded?: boolean;
  onOpenReview?: () => void;
  onHireChief: () => void;
  onProposeNow: () => void;
  /** Distance from the canvas bottom, so the card clears the hint line. */
  bottom?: number;
}) {
  const name = me?.name?.split(" ")[0] || "you";
  return (
    <div className="absolute inset-x-0 flex justify-center px-4 pointer-events-none" style={{ bottom }} data-org-empty>
      <div className="pointer-events-auto w-full max-w-[500px] rounded-2xl border p-4 org-pop-in" style={{ background: "color-mix(in srgb, var(--sol-card) 92%, transparent)", borderColor: "color-mix(in srgb, var(--sol-violet) 30%, transparent)", boxShadow: "0 24px 60px -30px rgba(0,0,0,0.55)", backdropFilter: "blur(6px)" }}>
        <p className="text-[13px] leading-relaxed" style={{ color: "var(--sol-text-secondary)" }}>
          Right now every session reports to {name}. A chief of staff reads how the work flows and proposes the roles that would take some of it, drawn as dashed cards on this chart. You accept, edit or skip each one; nothing changes until you do.
        </p>
        {reviewEnded && !reviewing && (
          <p className="mt-2 text-[12px]" style={{ color: "var(--sol-orange)" }} data-review-ended>
            The review stopped without making a proposal.{onOpenReview && <> <button type="button" onClick={onOpenReview} className="underline underline-offset-2">See why</button></>}
          </p>
        )}
        {reviewing ? (
          <div className="mt-3 flex items-center gap-2 text-[12.5px]" style={{ color: "var(--sol-text-secondary)" }} data-reviewing>
            <Sparkles className="w-4 h-4 animate-pulse shrink-0" style={{ color: "var(--sol-violet)" }} />
            <span className="min-w-0 flex-1">Reviewing the company. The proposal appears here when it lands.</span>
            {onOpenReview && <button type="button" onClick={onOpenReview} className="shrink-0 underline underline-offset-2" style={{ color: "var(--sol-violet)" }}>Open the review</button>}
          </div>
        ) : (
          <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-2" data-org-guide="start">
            <OrgButton primary onClick={onHireChief} className="justify-center h-9">
              <UserRoundPlus className="w-3.5 h-3.5" /> Hire a Chief of Staff
            </OrgButton>
            <OrgButton onClick={onProposeNow} className="justify-center h-9">
              <Sparkles className="w-3.5 h-3.5" /> Propose an org now
            </OrgButton>
          </div>
        )}
      </div>
    </div>
  );
}
