"use client";

import { useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { DECISION_SET_PARAM, decisionSetHref, parseDecisionSet, setPosition, useDecisionListOrder } from "../../lib/decisions/decisionSet";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { useTabActive } from "../../hooks/usePagePresence";
import { hasOpenModal } from "../../shortcuts";
import { keyBelongsElsewhere } from "../../shortcuts/keyOwnership";
import { KeyCap } from "../KeyCap";

// ‹ 2 of 5 › on a decision page, and the arrow keys: the set the address
// names, else the Decisions list it was opened from. A decision answered off
// the list keeps its slot, so › lands on the one that slid into it.
export function DecisionPager({ ids }: { ids: readonly (string | undefined)[] }) {
  const router = useRouter();
  const params = useSearchParams();
  const named = parseDecisionSet(params?.get(DECISION_SET_PARAM));
  const listOrder = useDecisionListOrder();
  const set = named.length > 1 ? named : listOrder;
  const last = useRef<{ key: string; at: number } | null>(null);
  const key = ids.filter(Boolean).join("|");

  let pos = setPosition(set, ids);
  if (pos) last.current = { key, at: pos.at };
  else if (last.current?.key === key && set.length > 0) {
    const at = Math.min(last.current.at, set.length);
    pos = { at: -1, prev: at > 0 ? set[at - 1] : null, next: at < set.length ? set[at] : null };
  }

  const go = (ref: string | null) => {
    if (ref) router.replace(named.length > 1 ? decisionSetHref(ref, named) : `/decisions/${ref}`);
  };
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
  }, [active, prev, next, named.join(",")]);

  if (!pos || set.length < 2) return null;
  const btn = "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-sol-text-dim hover:text-sol-text hover:bg-sol-card disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-sol-text-dim";
  return (
    <span className="inline-flex items-center gap-1 text-meta" data-decision-pager={`${pos.at + 1}/${set.length}`}>
      <button type="button" className={btn} disabled={!prev} onClick={() => go(prev)} aria-label="Previous decision" title="Previous decision">
        <ChevronLeft className="w-3.5 h-3.5" /><KeyCap size="xs">←</KeyCap>
      </button>
      <span className="tabular-nums text-sol-text-dim">{pos.at >= 0 ? `${pos.at + 1} of ${set.length}` : `${set.length} left`}</span>
      <button type="button" className={btn} disabled={!next} onClick={() => go(next)} aria-label="Next decision" title="Next decision">
        <KeyCap size="xs">→</KeyCap><ChevronRight className="w-3.5 h-3.5" />
      </button>
    </span>
  );
}
