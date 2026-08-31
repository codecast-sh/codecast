// Test harness for the placement chokepoint (placeInboxRows). The pre-C5
// classifier took bare (sessions, queued, pendingSendIds, opts) arguments;
// dozens of section tests were written against that shape. This adapter keeps
// those tests exercising the REAL chokepoint — membership, fold, shared
// placement, overlays — through a compatible signature.
//
// Two deliberate conveniences:
//   • rows missing `updated_at` get "now" (the shared working-set selection
//     drops rows outside the 30-day recency window; a fixture that says
//     nothing about time means "current");
//   • show-old defaults ON so a fixture deliberately aged past the fold still
//     renders (fold behavior has its own tests).
import {
  placeInboxRows,
  visualOrderSessions,
  __resetInboxPlacementCacheForTests,
  type InboxSession,
  type PlacedInbox,
} from "../inboxStore";

export type PlaceHarnessOpts = {
  currentSessionId?: string | null;
  pendingCreateIds?: ReadonlySet<string>;
  reviveRequestedAt?: Record<string, number>;
  now?: number;
  showOld?: boolean;
  scope?: "mine" | "team";
  teamInboxIds?: ReadonlySet<string>;
  sessionDecisions?: Record<string, any>;
  questionResolutions?: Record<string, { at: number; message_count: number }>;
  currentUser?: { _id?: unknown } | null;
};

export function placeSections(
  sessions: Record<string, InboxSession>,
  queued: Set<string> = new Set(),
  pendingSendIds: ReadonlySet<string> = new Set(),
  opts: PlaceHarnessOpts = {},
): PlacedInbox {
  __resetInboxPlacementCacheForTests();
  const now = opts.now ?? Date.now();
  const filled: Record<string, InboxSession> = {};
  for (const [id, s] of Object.entries(sessions)) {
    filled[id] = s.updated_at === undefined ? { ...s, updated_at: now } : s;
  }
  const pendingMessages: Record<string, any[]> = {};
  for (const id of pendingSendIds) {
    pendingMessages[id] = [{ _id: `pm-${id}`, role: "user", content: "x", timestamp: now }];
  }
  const pendingCreates: Record<string, unknown> = {};
  for (const id of opts.pendingCreateIds ?? []) pendingCreates[id] = true;
  return placeInboxRows(
    {
      sessions: filled,
      sessionsWithQueuedMessages: queued,
      pendingMessages,
      clientState: { ui: { inbox_show_old: opts.showOld ?? true, inbox_scope: opts.scope ?? "mine" } },
      currentUser: opts.currentUser ?? null,
      teamInboxIds: opts.teamInboxIds,
      sessionDecisions: opts.sessionDecisions,
      questionResolutions: opts.questionResolutions,
      pendingSessionCreates: pendingCreates,
      blockedReviveRequestedAt: opts.reviveRequestedAt ?? {},
      currentSessionId: opts.currentSessionId ?? null,
    },
    { focusedId: opts.currentSessionId ?? null, now },
  );
}

// The pre-C5 visualOrderSessions signature, adapted onto the chokepoint: the
// order tests keep their fixtures and assert the same walk over placed
// sections.
export function orderSections(
  sessions: Record<string, InboxSession>,
  queued: Set<string> = new Set(),
  projectFilter: string | null = null,
  pendingSendIds: ReadonlySet<string> = new Set(),
  opts: PlaceHarnessOpts & {
    bucketFilters?: readonly any[];
    bucketByConv?: Record<string, string | undefined>;
    filterExclude?: boolean;
    collapsedSections?: Record<string, boolean>;
    yourMove?: boolean;
  } = {},
): InboxSession[] {
  const placed = placeSections(sessions, queued, pendingSendIds, opts);
  return visualOrderSessions(placed, projectFilter, {
    bucketFilters: opts.bucketFilters,
    bucketByConv: opts.bucketByConv,
    filterExclude: opts.filterExclude,
    collapsedSections: opts.collapsedSections,
    yourMove: opts.yourMove,
  });
}
