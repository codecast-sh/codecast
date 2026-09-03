// Test harness for the placement chokepoint (placeInboxRows). The pre-C5
// classifier took bare (sessions, queued, pendingSendIds, opts) arguments;
// dozens of section tests were written against that shape. This adapter keeps
// those tests exercising the REAL chokepoint — membership, fold, shared
// placement, overlays — through a compatible signature.
//
// Three deliberate conveniences:
//   • rows missing `updated_at` get "now" (the shared working-set selection
//     drops rows outside the 30-day recency window; a fixture that says
//     nothing about time means "current");
//   • show-old defaults ON so a fixture deliberately aged past the fold still
//     renders (fold behavior has its own tests);
//   • short fixture ids ("wk1", "stale") are rekeyed to Convex-shaped ids for
//     the call and mapped back on the way out. The chokepoint reads a
//     non-Convex id as an optimistic create stub (the store convention:
//     stub ids are never 32 chars), which would skip placement for every
//     legacy fixture; rekeying lets those fixtures stand for REAL rows. Ids
//     that are already Convex-shaped pass through untouched.
import {
  placeInboxRows,
  visualOrderSessions,
  isConvexId,
  __resetInboxPlacementCacheForTests,
  type InboxSession,
  type PlacedInbox,
  type ProjectFilterTerm,
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
  // Ids that MUST stay non-Convex: fixtures standing for optimistic create
  // stubs (the create_stub overlay), exempt from the rekey.
  stubIds?: ReadonlySet<string>;
};

// Deterministic 32-char id for a short fixture tag: the tag (lowercased,
// non-alphanumerics stripped) followed by a length-tagged zero pad, so "a"
// and "a0" cannot collide.
function convexIdFor(tag: string): string {
  const clean = tag.toLowerCase().replace(/[^a-z0-9]/g, "");
  const body = `${clean}z${clean.length}`;
  return body.length >= 32 ? body.slice(0, 32) : body.padEnd(32, "0");
}

class IdRekey {
  private fwd = new Map<string, string>();
  private back = new Map<string, string>();
  constructor(private readonly keep: ReadonlySet<string>) {}
  to(id: string): string {
    if (isConvexId(id) || this.keep.has(id)) return id;
    let out = this.fwd.get(id);
    if (!out) {
      out = convexIdFor(id);
      this.fwd.set(id, out);
      this.back.set(out, id);
    }
    return out;
  }
  from(id: string): string {
    return this.back.get(id) ?? id;
  }
  toOpt(id: string | null | undefined): string | null {
    return id == null ? null : this.to(id);
  }
}

export function placeSections(
  sessions: Record<string, InboxSession>,
  queued: Set<string> = new Set(),
  pendingSendIds: ReadonlySet<string> = new Set(),
  opts: PlaceHarnessOpts = {},
): PlacedInbox {
  __resetInboxPlacementCacheForTests();
  const now = opts.now ?? Date.now();
  const rk = new IdRekey(opts.stubIds ?? new Set());
  // The original row for each rekeyed id — outputs hand back THESE objects so
  // assertions on `_id` / identity keep working.
  const original = new Map<string, InboxSession>();
  const filled: Record<string, InboxSession> = {};
  for (const [id, s] of Object.entries(sessions)) {
    const cid = rk.to(id);
    original.set(cid, s);
    const row: InboxSession = {
      ...s,
      _id: cid,
      updated_at: s.updated_at === undefined ? now : s.updated_at,
    };
    if (s.parent_conversation_id) row.parent_conversation_id = rk.to(s.parent_conversation_id);
    if (s.forked_from) row.forked_from = rk.to(s.forked_from);
    if (s.spawned_by_conversation_id) row.spawned_by_conversation_id = rk.to(s.spawned_by_conversation_id);
    filled[cid] = row;
  }
  const pendingMessages: Record<string, any[]> = {};
  for (const id of pendingSendIds) {
    pendingMessages[rk.to(id)] = [{ _id: `pm-${id}`, role: "user", content: "x", timestamp: now }];
  }
  const pendingCreates: Record<string, unknown> = {};
  for (const id of opts.pendingCreateIds ?? []) pendingCreates[rk.to(id)] = true;
  const rekeyRecord = <T,>(rec: Record<string, T> | undefined): Record<string, T> | undefined => {
    if (!rec) return rec;
    const out: Record<string, T> = {};
    for (const [id, v] of Object.entries(rec)) out[rk.to(id)] = v;
    return out;
  };
  const sessionDecisions = opts.sessionDecisions
    ? Object.fromEntries(
        Object.entries(opts.sessionDecisions).map(([k, d]) => [
          k,
          d && typeof d === "object" && typeof d.conversation_id === "string"
            ? { ...d, conversation_id: rk.to(d.conversation_id) }
            : d,
        ]),
      )
    : undefined;
  const placed = placeInboxRows(
    {
      sessions: filled,
      sessionsWithQueuedMessages: new Set([...queued].map((id) => rk.to(id))),
      pendingMessages,
      clientState: { ui: { inbox_show_old: opts.showOld ?? true, inbox_scope: opts.scope ?? "mine" } },
      currentUser: opts.currentUser ?? null,
      teamInboxIds: opts.teamInboxIds ? new Set([...opts.teamInboxIds].map((id) => rk.to(id))) : undefined,
      sessionDecisions,
      questionResolutions: rekeyRecord(opts.questionResolutions),
      pendingSessionCreates: pendingCreates,
      blockedReviveRequestedAt: rekeyRecord(opts.reviveRequestedAt) ?? {},
      currentSessionId: rk.toOpt(opts.currentSessionId),
    },
    { focusedId: rk.toOpt(opts.currentSessionId), now },
  );

  // Map back: original row objects, original ids on every keyed structure.
  const rowOut = (s: InboxSession) => original.get(s._id) ?? s;
  const rows = (xs: InboxSession[]) => xs.map(rowOut);
  const rowMap = (m: Map<string, InboxSession[]>) => {
    const out = new Map<string, InboxSession[]>();
    for (const [k, v] of m) out.set(rk.from(k), rows(v));
    return out;
  };
  const visibleSessions: Record<string, InboxSession> = {};
  for (const [id, s] of Object.entries(placed.visibleSessions)) visibleSessions[rk.from(id)] = rowOut(s);
  const placements = new Map<string, PlacedInbox["placements"] extends Map<string, infer V> ? V : never>();
  for (const [id, p] of placed.placements) placements.set(rk.from(id), p);
  const questionIds = new Set(placed.questions.map((s) => rk.from(s._id)));
  return {
    ...placed,
    visibleSessions,
    placements,
    sorted: rows(placed.sorted),
    questions: rows(placed.questions),
    pinned: rows(placed.pinned),
    newSessions: rows(placed.newSessions),
    needsInput: rows(placed.needsInput),
    done: rows(placed.done),
    dormant: rows(placed.dormant),
    working: rows(placed.working),
    stashed: rows(placed.stashed),
    dismissed: rows(placed.dismissed),
    subsByParent: rowMap(placed.subsByParent),
    forksByParent: rowMap(placed.forksByParent),
    isQuestion: (s: InboxSession) => questionIds.has(s._id) || placed.isQuestion(s),
  };
}

// The pre-C5 visualOrderSessions signature, adapted onto the chokepoint: the
// order tests keep their fixtures and assert the same walk over placed
// sections.
export function orderSections(
  sessions: Record<string, InboxSession>,
  queued: Set<string> = new Set(),
  projectFilters: readonly ProjectFilterTerm[] | null = null,
  pendingSendIds: ReadonlySet<string> = new Set(),
  opts: PlaceHarnessOpts & {
    bucketFilters?: readonly any[];
    bucketByConv?: Record<string, string | undefined>;
    collapsedSections?: Record<string, boolean>;
    yourMove?: boolean;
  } = {},
): InboxSession[] {
  const placed = placeSections(sessions, queued, pendingSendIds, opts);
  return visualOrderSessions(placed, projectFilters ?? undefined, {
    bucketFilters: opts.bucketFilters,
    bucketByConv: opts.bucketByConv,
    collapsedSections: opts.collapsedSections,
    yourMove: opts.yourMove,
  });
}
