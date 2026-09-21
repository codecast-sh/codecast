"use client";
// First open (docs/architecture/org-staffing.md S14). Two pieces the org page
// mounts over its real canvas:
//
// OrgEmptyCanvas: the workspace has no roles yet, so the canvas is the
// person's own node plus this card: one paragraph and the two buttons that
// start a proposal ("Hire a Chief of Staff", "Propose an org now"). Designed,
// not blank; the buttons are the same actions the staffing pane offers.
//
// OrgGuide: three steps, one sentence and one highlight each, drawn as a
// spotlight cut out of a dimmed sheet. The cut-out is a real hole (four dim
// rectangles around it), so the highlighted control keeps taking clicks: the
// last step's buttons ARE the two buttons above. Dismissing writes the
// org_nux_seen pref through the store; "How this page works" in the toolbar
// reopens it by hand.
import { useEventListener } from "../../hooks/useEventListener";
import { useLayoutEffect, useState } from "react";
import { Sparkles, UserRoundPlus, X } from "lucide-react";
import { OrgButton } from "./OrgButton";
import type { OrgPerson } from "./orgTypes";
import type { OrgGuideStep } from "../../lib/orgGuideSteps";

// Capture: the wizard answers the key before the page under it does.
const KEY_CAPTURE = { capture: true } as const;

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
          Right now every session reports to {name}. A chief of staff reads how the work flows and proposes the seats that would take some of it, as dashed ghosts on this canvas; you accept, edit or skip each one, and it applies nothing on its own.
        </p>
        {reviewEnded && !reviewing && (
          <p className="mt-2 text-[12px]" style={{ color: "var(--sol-orange)" }} data-review-ended>
            The review session stopped without posting a proposal.{onOpenReview && <> <button type="button" onClick={onOpenReview} className="underline underline-offset-2">See why</button></>}
          </p>
        )}
        {reviewing ? (
          <div className="mt-3 flex items-center gap-2 text-[12.5px]" style={{ color: "var(--sol-text-secondary)" }} data-reviewing>
            <Sparkles className="w-4 h-4 animate-pulse shrink-0" style={{ color: "var(--sol-violet)" }} />
            <span className="min-w-0 flex-1">Reviewing the company. The proposal appears here when it lands.</span>
            {onOpenReview && <button type="button" onClick={onOpenReview} className="shrink-0 underline underline-offset-2" style={{ color: "var(--sol-violet)" }}>Open the session</button>}
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

// ---------------------------------------------------------------- the guide

type Rect = { x: number; y: number; w: number; h: number };
const PAD = 8;

/** The highlighted control's box, followed while the step is open: the
 *  chart fits itself after mount, pans to the focused node and the header
 *  wraps on resize, so one measurement would drift. Polls at animation rate
 *  for the first second, then a few times a second (a chart pan settles
 *  over hundreds of milliseconds), plus on resize and scroll. The state only
 *  changes when the box moved, so the polling re-renders nothing. */
function useTargetRect(selector: string | null): Rect | null {
  const [rect, setRect] = useState<Rect | null>(null);
  useLayoutEffect(() => {
    if (!selector) { setRect(null); return; }
    let raf = 0;
    let ticks = 0;
    const measure = () => {
      const el = document.querySelector(selector);
      const r = el?.getBoundingClientRect();
      const next = r && r.width > 0 && r.height > 0 ? { x: r.left - PAD, y: r.top - PAD, w: r.width + PAD * 2, h: r.height + PAD * 2 } : null;
      setRect((prev) => (prev && next && prev.x === next.x && prev.y === next.y && prev.w === next.w && prev.h === next.h) || prev === next ? prev : next);
    };
    const tick = () => { measure(); if (++ticks < 60) raf = requestAnimationFrame(tick); };
    raf = requestAnimationFrame(tick);
    const slow = window.setInterval(measure, 300);
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => { cancelAnimationFrame(raf); window.clearInterval(slow); window.removeEventListener("resize", measure); window.removeEventListener("scroll", measure, true); };
  }, [selector]);
  return rect;
}

export function OrgGuide({ steps, step, onStep, onDone, onAction }: {
  steps: OrgGuideStep[];
  step: number;
  onStep: (i: number) => void;
  /** Done or dismissed: the page writes the pref and closes the guide. */
  onDone: () => void;
  /** The last step's own act (open the waiting proposal); the guide closes too. */
  onAction?: (id: NonNullable<OrgGuideStep["action"]>["id"]) => void;
}) {
  const cur = steps[step] ?? steps[0];
  const rect = useTargetRect(cur?.target ?? null);
  const last = step >= steps.length - 1;
  useEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === "Escape") { e.stopPropagation(); onDone(); }
    else if (e.key === "ArrowRight" || e.key === "Enter") { if (last) onDone(); else onStep(step + 1); }
    else if (e.key === "ArrowLeft" && step > 0) onStep(step - 1);
  }, undefined, KEY_CAPTURE);

  const vw = typeof window !== "undefined" ? window.innerWidth : 1200;
  const vh = typeof window !== "undefined" ? window.innerHeight : 800;
  const dim = "color-mix(in srgb, var(--sol-bg) 72%, transparent)";
  // The card sits under the highlight when there is room, else above it;
  // with nothing to highlight it sits in the middle.
  const cardW = Math.min(360, vw - 24);
  let cardX = (vw - cardW) / 2;
  let cardY = vh / 2 - 60;
  if (rect) {
    cardX = Math.max(12, Math.min(rect.x + rect.w / 2 - cardW / 2, vw - cardW - 12));
    cardY = rect.y + rect.h + 14 + 150 < vh ? rect.y + rect.h + 14 : Math.max(12, rect.y - 14 - 150);
  }
  return (
    <div className="fixed inset-0 z-[60]" data-org-guide-open={cur.id} aria-modal="true" role="dialog" aria-label="How this page works">
      {/* the dim sheet, in four parts, leaving the highlight as a real hole */}
      {rect ? (
        <>
          <div className="absolute" onMouseDown={onDone} style={{ left: 0, top: 0, width: vw, height: Math.max(0, rect.y), background: dim }} />
          <div className="absolute" onMouseDown={onDone} style={{ left: 0, top: rect.y, width: Math.max(0, rect.x), height: rect.h, background: dim }} />
          <div className="absolute" onMouseDown={onDone} style={{ left: rect.x + rect.w, top: rect.y, width: Math.max(0, vw - rect.x - rect.w), height: rect.h, background: dim }} />
          <div className="absolute" onMouseDown={onDone} style={{ left: 0, top: rect.y + rect.h, width: vw, height: Math.max(0, vh - rect.y - rect.h), background: dim }} />
          <div className="absolute pointer-events-none rounded-xl org-guide-ring" style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h, boxShadow: "0 0 0 2px var(--sol-violet), 0 0 0 8px color-mix(in srgb, var(--sol-violet) 22%, transparent)" }} data-org-guide-ring />
        </>
      ) : (
        <div className="absolute inset-0" onMouseDown={onDone} style={{ background: dim }} />
      )}

      {/* the card: one sentence, the step dots, the two buttons */}
      <div className="absolute rounded-2xl border p-4 org-pop-in" style={{ left: cardX, top: cardY, width: cardW, background: "var(--sol-card)", borderColor: "color-mix(in srgb, var(--sol-violet) 40%, transparent)", boxShadow: "0 24px 60px -24px rgba(0,0,0,0.6)" }} data-org-guide-card>
        <div className="flex items-center gap-1.5">
          {steps.map((s, i) => (
            <button key={s.id} type="button" onClick={() => onStep(i)} aria-label={`Step ${i + 1}`} aria-current={i === step} className="h-[6px] rounded-full transition-all" style={{ width: i === step ? 22 : 8, background: i === step ? "var(--sol-violet)" : "color-mix(in srgb, var(--sol-border) 60%, transparent)" }} />
          ))}
          <span className="ml-auto text-[10.5px] tabular-nums" style={{ color: "var(--sol-text-dim)" }}>{step + 1} of {steps.length}</span>
          <button type="button" onClick={onDone} aria-label="Dismiss" className="w-6 h-6 -mr-1.5 inline-flex items-center justify-center rounded-md hover:bg-sol-bg-highlight" style={{ color: "var(--sol-text-dim)" }}><X className="w-3.5 h-3.5" /></button>
        </div>
        <p className="mt-2.5 text-[14px] leading-relaxed" style={{ color: "var(--sol-text)", fontFamily: "var(--font-serif)" }} data-org-guide-sentence>{cur.sentence}</p>
        <div className="mt-3 flex items-center justify-between gap-2">
          {/* Every step has Next and Done; Escape is Done. */}
          {!last && <button type="button" onClick={onDone} className="h-7 px-2 rounded-md text-[12px] hover:bg-sol-bg-highlight" style={{ color: "var(--sol-text-muted)" }} data-org-guide-done>Done</button>}
          {last && <span />}
          <div className="flex items-center gap-1.5">
            {step > 0 && <OrgButton size="sm" onClick={() => onStep(step - 1)}>Back</OrgButton>}
            {!last && <OrgButton primary size="sm" onClick={() => onStep(step + 1)}>Next</OrgButton>}
            {cur.action && onAction && <OrgButton size="sm" onClick={() => { onDone(); onAction(cur.action!.id); }} data-org-guide-action={cur.action.id}>{cur.action.label}</OrgButton>}
            {last && <OrgButton primary size="sm" onClick={onDone} data-org-guide-done>Done</OrgButton>}
          </div>
        </div>
      </div>
    </div>
  );
}
