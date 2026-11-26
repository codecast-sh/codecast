// The live inbox in the triage model: today's placement (placeInboxRows, the
// one chokepoint every list uses) plus each row's own facts and the viewer's
// unread verdict, regrouped by the shared triageOf. Nothing here decides who
// acts next on its own; it reads the verdict the inbox already reached.
import { childProducingAt, deriveLiveAt, isLoopFresh, type InboxBucket, type InboxPlacement } from "@codecast/shared/contracts";
import {
  ridesLead,
  shelfPlacement,
  TRIAGE_SECTIONS,
  triageAskRank,
  triageOf,
  triageSectionOf,
  type Triage,
  type TriageFacts,
  type TriageSection,
} from "@codecast/shared/contracts/triage";
import type { InboxSession, PlacedInbox } from "../../store/inboxStore";
import { liveFactsOf } from "../liveness";

export type TriagedRow = {
  s: InboxSession;
  triage: Triage;
  /** Where today's inbox files the same row. */
  today: InboxBucket | string;
};

export type LiveTriage = {
  sections: Record<TriageSection, TriagedRow[]>;
  /** Each move from today's section to the new one, with how many rows make it. */
  moves: Array<{ from: string; to: TriageSection; count: number }>;
  total: number;
};

/** The facts triageOf reads, off an inbox row at `now`. */
export function triageFactsOf(s: InboxSession, now: number, asking: boolean): TriageFacts {
  const live = deriveLiveAt(liveFactsOf(s), now);
  const loop = s.loop_state;
  return {
    messageCount: s.message_count ?? 0,
    updatedAt: s.updated_at ?? now,
    agentStatus: live.agent_status,
    awaitingInput: live.awaiting_input,
    asking,
    askKind: live.awaiting_input ? "question" : live.agent_status === "permission_blocked" ? "permission" : asking ? "decide" : null,
    declaredStatus: s.thread_state_status ?? null,
    settleVerdict: s.settle_verdict ?? null,
    apiError: s.pending_api_error === true,
    apiErrorKind: s.pending_api_error_kind ?? null,
    sessionError: !!s.session_error,
    unresponsive: live.is_unresponsive,
    hasPending: !!s.has_pending,
    childProducing: childProducingAt(s, now),
    loopArmed: !!loop && loop.status === "armed" && isLoopFresh(loop, now),
    loopWakeAt: loop?.status === "armed" ? loop.wakeup_at : null,
    triggerKind: s.armed_trigger_kind ?? null,
    parkedWakeKind: s.parked_wake_kind ?? null,
    openTasks: s.open_tasks?.length ?? 0,
    pr: s.pr_status ? { number: s.pr_status.number, state: s.pr_status.state } : null,
    userRest: s.inbox_rest ?? s.user_rest ?? null,
    pinned: !!s.inbox_pinned_at,
    stashed: !!s.inbox_stashed_at,
    snoozedUntil: s.inbox_snoozed_until ?? null,
    killed: !!s.inbox_killed_at,
    dismissed: !!s.inbox_dismissed_at,
  };
}

function emptySections(): Record<TriageSection, TriagedRow[]> {
  return Object.fromEntries(TRIAGE_SECTIONS.map((k) => [k, []])) as unknown as Record<TriageSection, TriagedRow[]>;
}

/** Regroups one placed inbox in the triage model, keeping today's order inside each section. */
export function triageInbox(placed: PlacedInbox, unread: Record<string, boolean>, now: number): LiveTriage {
  const sections = emptySections();
  const order = new Map<string, number>();
  placed.sorted.forEach((s, i) => order.set(s._id, i));
  const seen = new Set<string>();
  const moves = new Map<string, { from: string; to: TriageSection; count: number }>();

  const add = (s: InboxSession, placement: InboxPlacement) => {
    if (seen.has(s._id) || ridesLead(placement)) return;
    seen.add(s._id);
    const asking = placed.isQuestion(s);
    const triage = triageOf({ placement, facts: triageFactsOf(s, now, asking), unread: !!unread[s._id], now });
    const section = triageSectionOf(triage);
    if (!section) return;
    sections[section].push({ s, triage, today: placement.bucket });
    const key = `${placement.bucket}>${section}`;
    const m = moves.get(key) ?? { from: placement.bucket, to: section, count: 0 };
    m.count++;
    moves.set(key, m);
  };

  for (const s of placed.sorted) {
    const p = placed.placements.get(s._id);
    if (p) add(s, p);
  }
  for (const shelf of ["stashed", "snoozed", "dismissed"] as const) {
    for (const s of placed[shelf]) add(s, placed.placements.get(s._id) ?? shelfPlacement(shelf));
  }

  const rank = (r: TriagedRow) => order.get(r.s._id) ?? Number.MAX_SAFE_INTEGER;
  for (const key of TRIAGE_SECTIONS) {
    sections[key].sort((a, b) => triageAskRank(a.triage) - triageAskRank(b.triage) || rank(a) - rank(b));
  }
  return { sections, moves: [...moves.values()].sort((a, b) => b.count - a.count), total: seen.size };
}

/** Today's section a bucket names, for the compare view: the word the rail shows. */
export const TODAY_SECTION_WORD: Record<string, string> = {
  questions: "Questions", pinned: "Pinned", new: "New", needs_input: "Needs you", done: "Done",
  dormant: "Dormant", working: "Working", idle: "Idle", snoozed: "Snoozed", stashed: "Stashed",
  dismissed: "Killed", hidden: "Hidden",
};

// The section today's inbox would file a row under when nothing about the
// model changed it. A row elsewhere is a move: the compare view and the lab
// both show it. Done has no natural section: the model splits it by reading.
const TODAY_NATURAL: Record<string, TriageSection | null> = {
  questions: "you", needs_input: "you", done: null, working: "agent", dormant: "parked", new: "settled",
  idle: "settled", pinned: "pinned", stashed: "stashed", snoozed: "snoozed", dismissed: "retired", hidden: null,
};

export function isMove(todayBucket: string, section: TriageSection | null): boolean {
  return (TODAY_NATURAL[todayBucket] ?? null) !== section;
}
