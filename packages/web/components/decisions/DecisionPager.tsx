"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import type { DecisionStep } from "../../hooks/useDecisionStep";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { useTabActive } from "../../hooks/usePagePresence";
import { hasOpenModal } from "../../shortcuts";
import { keyBelongsElsewhere } from "../../shortcuts/keyOwnership";
import { KeyCap } from "../KeyCap";

// ‹ 2 of 5 › on a decision page, and the arrow keys.
export function DecisionPager({ step }: { step: DecisionStep }) {
  const { pos, go } = step;
  const active = useTabActive();
  const prev = pos?.prev ?? null;
  const next = pos?.next ?? null;
  useWatchEffect(() => {
    if (!active || (!prev && !next)) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || e.defaultPrevented || hasOpenModal() || keyBelongsElsewhere(e.target)) return;
      const to = e.key === "ArrowLeft" ? prev : e.key === "ArrowRight" ? next : null;
      if (!to) return;
      e.preventDefault();
      go(to);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, prev, next]);

  if (!pos || step.total < 2) return null;
  const btn = "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-sol-text-dim hover:text-sol-text hover:bg-sol-card disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-sol-text-dim";
  return (
    <span className="inline-flex items-center gap-1 text-meta" data-decision-pager={`${pos.at + 1}/${step.total}`}>
      <button type="button" className={btn} disabled={!prev} onClick={() => go(prev)} aria-label="Previous decision" title="Previous decision">
        <ChevronLeft className="w-3.5 h-3.5" /><KeyCap size="xs">←</KeyCap>
      </button>
      <span className="tabular-nums text-sol-text-dim">{pos.at >= 0 ? `${pos.at + 1} of ${step.total}` : `${step.total} left`}</span>
      <button type="button" className={btn} disabled={!next} onClick={() => go(next)} aria-label="Next decision" title="Next decision">
        <KeyCap size="xs">→</KeyCap><ChevronRight className="w-3.5 h-3.5" />
      </button>
    </span>
  );
}
