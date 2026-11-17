"use client";

import { useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { DECISION_SET_PARAM, decisionSetHref, parseDecisionSet, setPosition, useDecisionListOrder } from "../lib/decisions/decisionSet";

export type DecisionStep = { pos: { at: number; prev: string | null; next: string | null } | null; total: number; go: (ref: string | null) => void };

// Where this decision sits in the set the address names, else the Decisions
// list it was opened from. A decision answered off the list keeps its slot,
// so next is the one that slid into it. Call it once per page, from before
// the answer, so the slot is known when the decision leaves the list.
export function useDecisionStep(ids: readonly (string | undefined)[]): DecisionStep {
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
  return { pos, total: set.length, go };
}
