// The offload review's state, with no drawing in it, so the web's review
// panel (OffloadReview) and the phone's offload screen run the same review.
// Every movable session the dial picks is ticked; ticking by hand takes over
// from the dial. Destinations default to spreading across hosts
// (lib/resourceOffload assignDestinations). The review holds the plan it
// opened on, so a new sample never reorders or re-picks what the person is
// looking at. Pressing Move confirms the checks no machine can prove, recorded
// per session as such, never as a passed check. Blockers cannot be overridden.
import { useEffect, useMemo, useRef, useState } from "react";
import { WAIT_PRESETS } from "../../lib/migrationPlan";
import { memoryUsed } from "./resourceModel";
import type { OffloadCandidate, OffloadDestination, OffloadPlan, OffloadSelection, ResourceActions, ResourceSession } from "./types";
import { bringsByDefault, rehearsalPending, type MoveRehearsal } from "@codecast/shared/contracts/moveRehearsal";
import { assignDestinations, holdPlan, loadShareOf, loadShift, sliceForPercent } from "../../lib/resourceOffload";

export const movable = (r: OffloadCandidate["perDestination"][string] | undefined) => r?.readiness === "ready" || r?.readiness === "preflight_required";

export const SAFE_WAITS = WAIT_PRESETS.filter((p) => p.value > 0);
export const AUTO = "auto";

function groupBy(rows: Array<{ id: string; reason: string }>): Array<[string, string[]]> {
  const m = new Map<string, string[]>();
  for (const r of rows) m.set(r.reason, [...(m.get(r.reason) ?? []), r.id]);
  return [...m].sort((a, b) => b[1].length - a[1].length);
}

/** `destinationId` is set only when the user sent this one session somewhere other than the batch. */
type Choice = { checked: boolean; destinationId?: string; /** Paths the person turned on or off, over the defaults. */ bring?: Record<string, boolean> };

/** The paths a move brings for this rehearsal: the defaults, then the person's own picks. */
function bringFor(r: MoveRehearsal | undefined, picks: Record<string, boolean> | undefined): string[] {
  return (r?.missing ?? []).filter((m) => picks?.[m.path] ?? bringsByDefault(m)).map((m) => m.path);
}

const movableHere = (plan: OffloadPlan) => plan.candidates.filter((c) => plan.destinations.some((d) => movable(c.perDestination[d.deviceId])));
const round5 = (n: number) => Math.round(n / 5) * 5;

/**
 * Where the dial starts. Under pressure: enough of the movable load to bring
 * the hottest measure back to about 70%, all of it when that is not enough.
 * Otherwise half.
 */
function startingPercent(plan: OffloadPlan): number {
  const sample = plan.sourceSample;
  const peak = Math.max(sample.cpuPercent ?? 0, memoryUsed(sample) / Math.max(sample.memoryTotal, 1) * 100);
  if (!plan.incident || peak <= 70) return 50;
  const movableShare = movableHere(plan).reduce((n, c) => n + loadShareOf(c, sample), 0);
  if (movableShare <= 0) return 100;
  return Math.min(100, Math.max(10, Math.ceil((((peak - 70) / peak) / movableShare) * 20) * 5));
}

export type OffloadReviewInput = {
  plan: OffloadPlan;
  sessions: ResourceSession[];
  /** Sessions ticked before opening review; without them the dial picks. */
  initialSelected?: string[];
  actions?: ResourceActions;
  actionsDisabledReason?: string;
};

export type ReceivingHost = { d: OffloadDestination; cs: OffloadCandidate[] };

export function useOffloadReview({ plan: livePlan, sessions, initialSelected, actions, actionsDisabledReason }: OffloadReviewInput) {
  const [held] = useState(livePlan);
  const plan = useMemo(() => holdPlan(held, livePlan), [held, livePlan]);
  const byId = useMemo(() => new Map(sessions.map((s) => [s.sessionId, s])), [sessions]);
  const preselect = initialSelected?.length ? new Set(initialSelected) : undefined;
  // The dial picks the sessions; ticking a box by hand takes over until the dial moves again (null).
  // Undefined is the starting position, worked out once the movable sessions are known.
  const [dial, setDial] = useState<number | null | undefined>(preselect ? null : undefined);
  // Choices survive new samples: the plan is rebuilt every sample, the user's review is not.
  const [edited, setChoices] = useState<Record<string, Choice>>({});
  const [chosenMode, setMode] = useState<string>(AUTO);
  const [wait, setWait] = useState(SAFE_WAITS[1]?.value ?? SAFE_WAITS[0].value);

  // A host no session can move to (offline for good, blocked for all) is not a choice.
  const reachable = plan.destinations.filter((d) => plan.candidates.some((c) => movable(c.perDestination[d.deviceId])));
  const mode = chosenMode === AUTO || reachable.some((d) => d.deviceId === chosenMode) ? chosenMode : AUTO;
  const pinned = (c: OffloadCandidate) => { const id = edited[c.sessionId]?.destinationId; return id && movable(c.perDestination[id]) ? id : undefined; };
  const canMove = movableHere(plan);
  // The slice is redone when the dial moves or the set of movable sessions changes, never on a mere new sample.
  const movableKey = canMove.map((c) => c.sessionId).join(",");
  const slice = useMemo(() => {
    if (dial === null) return null;
    const pct = dial ?? startingPercent(plan);
    return { pct, ids: new Set(sliceForPercent(canMove, plan.sourceSample, pct).ids) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dial, movableKey]);
  const blocked = plan.candidates.filter((c) => !canMove.includes(c));
  const isChecked = (c: OffloadCandidate) => slice ? slice.ids.has(c.sessionId) : edited[c.sessionId]?.checked ?? (preselect ? preselect.has(c.sessionId) : false);
  /** Hand edits start from what is ticked now, so taking over from the dial keeps its picks. */
  const handEdit = (change: (s: Record<string, Choice>) => Record<string, Choice>) => {
    setChoices((s) => change(Object.fromEntries(plan.candidates.map((c) => [c.sessionId, { ...s[c.sessionId], checked: isChecked(c) }]))));
    setDial(null);
  };
  const picked = canMove.filter(isChecked);
  const auto = assignDestinations(plan, picked.filter((c) => !pinned(c)), mode);
  const destOf = (c: OffloadCandidate) => pinned(c) ?? auto.get(c.sessionId) ?? c.suggestedDestinationId ?? plan.destinations.find((d) => movable(c.perDestination[d.deviceId]))?.deviceId ?? "";
  const going = picked.filter((c) => movable(c.perDestination[destOf(c)]));
  const rehearsalOf = (c: OffloadCandidate) => c.perDestination[destOf(c)]?.rehearsal;
  const resultOf = (c: OffloadCandidate) => { const r = rehearsalOf(c); return r?.status === "done" ? r.result : undefined; };
  const bringOf = (c: OffloadCandidate) => bringFor(resultOf(c), edited[c.sessionId]?.bring);
  // Pressing Move confirms the items no check can prove, and what the rehearsal shows on each row: the paths left behind, services staying here, missing commands.
  const selections: OffloadSelection[] = going.map((c) => {
    const result = resultOf(c);
    const bring = bringOf(c);
    return { sessionId: c.sessionId, destinationId: destOf(c), attested: [...new Set([...c.perDestination[destOf(c)].pending, ...(result ? rehearsalPending(result, bring) : [])])], ...(bring.length ? { bring } : {}) };
  });

  // The server's dry run runs once on open, so its blockers show before anyone presses Move.
  const preflight = actions?.onPreflight;
  const firstCheck = useRef(true);
  useEffect(() => {
    if (!firstCheck.current || !preflight || canMove.length === 0) return;
    firstCheck.current = false;
    preflight(canMove.map((c) => ({ sessionId: c.sessionId, destinationId: destOf(c), attested: [] })));
  });

  // Each ticked session's move is rehearsed once per destination per review, when it is first ticked there; one that failed is asked again by the next review.
  const rehearse = actions?.onRehearse;
  const asked = useRef(new Set<string>());
  const toRehearse = going.filter((c) => { const r = rehearsalOf(c); return (!r || r.status === "failed") && !asked.current.has(`${c.sessionId}:${destOf(c)}`); });
  const rehearseKey = toRehearse.map((c) => `${c.sessionId}:${destOf(c)}`).join(",");
  useEffect(() => {
    if (!rehearse || !rehearseKey) return;
    const t = setTimeout(() => {
      for (const c of toRehearse) asked.current.add(`${c.sessionId}:${destOf(c)}`);
      rehearse(toRehearse.map((c) => ({ sessionId: c.sessionId, destinationId: destOf(c), attested: [] })));
    }, 600);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rehearseKey]);

  const sumOf = (cs: OffloadCandidate[]) => ({
    cpu: cs.some((c) => c.relief.cpu === undefined) ? undefined : cs.reduce((a, c) => a + (c.relief.cpu ?? 0), 0),
    rss: cs.reduce((a, c) => a + (c.relief.rssHigh ?? 0), 0),
  });
  const leaving = sumOf(going);
  const poolShare = canMove.reduce((n, c) => n + loadShareOf(c, plan.sourceSample), 0);
  const achieved = poolShare > 0 ? round5(going.reduce((n, c) => n + loadShareOf(c, plan.sourceSample), 0) / poolShare * 100) : 0;
  const source = loadShift(plan.sourceSample, leaving, -1);
  const receiving = plan.destinations
    .map((d) => ({ d, cs: going.filter((c) => destOf(c) === d.deviceId) }))
    .filter(({ d, cs }) => cs.length > 0 || (mode === d.deviceId));
  const hostsUsed = receiving.filter((r) => r.cs.length > 0).length;
  const unevaluated = (initialSelected ?? []).filter((id) => !plan.candidates.some((c) => c.sessionId === id) && !plan.notOffered.some((n) => n.sessionId === id));
  const midTurn = going.some((c) => c.disruption === "mid_turn");
  const allChecked = canMove.length > 0 && picked.length === canMove.length;
  const setAll = (checked: boolean) => handEdit((s) => Object.fromEntries(plan.candidates.map((c) => [c.sessionId, { ...s[c.sessionId], checked }])));
  const titleOf = (id: string) => byId.get(id)?.title ?? id;
  // Grouped by reason, largest first: a count per reason reads at a glance where a line per session does not.
  // Busy ones are listed above with their load and controls; the rest group by reason.
  const busy = new Set(plan.staying.map((st) => st.sessionId));
  const stayGroups = groupBy([
    ...blocked.map((c) => ({ id: c.sessionId, reason: Object.values(c.perDestination).flatMap((r) => r.blockers)[0] ?? "Blocked" })),
    ...plan.notOffered.map((n) => ({ id: n.sessionId, reason: n.reason })),
    ...unevaluated.map((id) => ({ id, reason: "Not checked yet" })),
  ].filter((r) => !busy.has(r.id)));
  const stayCount = stayGroups.reduce((n, [, ids]) => n + ids.length, 0);

  const stopping = going.flatMap((c) => c.stops);
  const stoppingOutside = stopping.filter((p) => p.detached).length;
  const moveBlocked = !actions?.onStartOffload ? (actionsDisabledReason ?? "Moving is not available here") : going.length === 0 ? "Select at least one session" : undefined;

  const check = (c: OffloadCandidate, v: boolean) => handEdit((s) => ({ ...s, [c.sessionId]: { ...s[c.sessionId], checked: v } }));
  const setBring = (c: OffloadCandidate, path: string, on: boolean) => setChoices((s) => ({ ...s, [c.sessionId]: { ...s[c.sessionId], checked: s[c.sessionId]?.checked ?? isChecked(c), bring: { ...s[c.sessionId]?.bring, [path]: on } } }));
  const pinDestination = (c: OffloadCandidate, destinationId: string) => handEdit((s) => ({ ...s, [c.sessionId]: { checked: true, destinationId } }));
  const hostOf = (c: OffloadCandidate) => plan.destinations.find((d) => d.deviceId === destOf(c));
  /** The host a ticked row names: only when the batch spreads or the person pinned it. */
  const shownHost = (c: OffloadCandidate) => (picked.includes(c) && (hostsUsed > 1 || !!pinned(c)) ? hostOf(c) : undefined);
  /** Press Move: returns the launch's client batch id when it started. */
  const start = () => actions?.onStartOffload?.(selections, { waitForTurnMs: wait });
  const setBackground = actions?.onSetBackground && !actionsDisabledReason ? (sessionId: string, on: boolean) => actions.onSetBackground!(plan.deviceId, sessionId, on) : undefined;

  return {
    plan, byId, titleOf, reachable, mode, setMode, canMove, picked, going, destOf, pinned, rehearsalOf, bringOf,
    dialValue: slice?.pct ?? achieved, setDial, leaving, poolShare, source, receiving, hostsUsed, sumOf, midTurn,
    allChecked, setAll, check, setBring, pinDestination, shownHost, busy, stayGroups, stayCount, stopping, stoppingOutside,
    wait, setWait, moveBlocked, start, setBackground,
  };
}
