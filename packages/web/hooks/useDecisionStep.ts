"use client";

import { useMemo, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { DECISION_SET_PARAM, decisionNav, decisionSetHref, parseDecisionSet, useDecisionListOrder, type DecisionSlot } from "../lib/decisions/decisionSet";
import { useDecisionQueue } from "./useDecisionQueue";

export type DecisionStep = { pos: { at: number; prev: string | null; next: string | null }; total: number; go: (ref: string | null) => void };

const SESSION_REF = "s:";

/** The queue the sidebar counts, in its own order: a decision by its id, a session parked on a terminal question as
 *  `s:<conversation>`, which the stepper opens. */
function useQueueOrder(): string[] {
  const queue = useDecisionQueue();
  return useMemo(() => queue.map((q) => (q.decisionId ? q.shortId ?? q.decisionId : `${SESSION_REF}${q.conversationId}`)), [queue]);
}

// Where this decision sits in the set the address names, else the queue the
// sidebar counts, else the Decisions list's order (a team or answered one),
// so the page always has a way through and its count is the badge's. A
// decision answered off its set keeps its slot, so next is the one that slid
// into it. Call it once per page, from before the answer, so the slot is
// known when the decision leaves the set.
export function useDecisionStep(ids: readonly (string | undefined)[]): DecisionStep {
  const router = useRouter();
  const params = useSearchParams();
  const named = parseDecisionSet(params?.get(DECISION_SET_PARAM));
  const listOrder = useDecisionListOrder();
  const queueOrder = useQueueOrder();
  const last = useRef<DecisionSlot | null>(null);
  const { src, set, at, prev, next, slot } = decisionNav({ named, list: listOrder, queue: queueOrder }, ids, last.current);
  last.current = slot;
  const go = (ref: string | null) => {
    if (!ref) return;
    if (ref.startsWith(SESSION_REF)) router.push(`/decisions?s=${ref.slice(SESSION_REF.length)}`);
    else router.replace(src === "named" ? decisionSetHref(ref, named) : `/decisions/${ref}`);
  };
  return { pos: { at, prev, next }, total: set.length, go };
}
