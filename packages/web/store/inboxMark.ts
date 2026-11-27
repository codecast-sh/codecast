// The mark an inbox draws for one session (inboxMarkOf): what a priority's
// milestone reads its sessions by (hooks/usePriorityModels liveStateOf), so
// a milestone and the inbox can never draw one session two ways. Built from
// the inbox's own pieces: its placement (placeInboxRows), the section each
// row is drawn in (drawnSectionOf), and the card's own state for that section
// (lib/sessionStatus cardSectionOf, the panel's INBOX_SECTION_DECLARED_STATUS).
import { isHostedAgentType } from "@codecast/shared/contracts";
import { hostedStopOf } from "../lib/hostedNotice";
import { INBOX_SECTION_DECLARED_STATUS, cardSectionOf, sessionStatusOf, type SessionStatus } from "../lib/sessionStatus";
import {
  drawnSectionOf, placeInboxRows, railRowPlacement, subagentLiveOf, subagentStatusOf,
  type InboxSectionKey, type PlaceInboxState, type PlacedInbox, type SubagentLiveState,
} from "./inboxStore";

/** The inbox a mark is read from: web's sidebar (GlobalSessionPanel) or the phone's inbox. */
export type MarkInbox = "sidebar" | "phone";

/** Each drawn section's renderSection key, which INBOX_SECTION_DECLARED_STATUS reads. */
const PANEL_KEY_OF_SECTION: Record<InboxSectionKey, string> = {
  questions: "questions", pinned: "pinned", newSessions: "new", needsInput: "needs_input", done: "done", dormant: "dormant", working: "working",
};

/** The hidden buckets the inbox draws behind their headers (renderHiddenBucket), each as its cards' variant. */
const HIDDEN_BUCKETS = ["snoozed", "stashed", "dismissed"] as const;
const _drawnHidden = new WeakMap<PlacedInbox, Map<string, (typeof HIDDEN_BUCKETS)[number]>>();
function drawnHiddenOf(placed: PlacedInbox, id: string): (typeof HIDDEN_BUCKETS)[number] | null {
  let map = _drawnHidden.get(placed);
  if (!map) {
    map = new Map();
    for (const key of HIDDEN_BUCKETS) for (const row of placed[key]) map.set(row._id, key);
    _drawnHidden.set(placed, map);
  }
  return map.get(id) ?? null;
}

/** Each row the inbox draws nested under a drawn card (its subsByParent), per placed inbox. */
const _drawnNested = new WeakMap<PlacedInbox, Set<string>>();
function drawnNestedOf(placed: PlacedInbox): Set<string> {
  let set = _drawnNested.get(placed);
  if (!set) {
    set = new Set();
    for (const [parent, subs] of placed.subsByParent) if (drawnSectionOf(placed, parent)) for (const sub of subs) if (!drawnSectionOf(placed, sub._id)) set.add(sub._id);
    _drawnNested.set(placed, set);
  }
  return set;
}

/**
 * The mark `inbox` draws for one session, or null when it does not draw it
 * (not in the store, outside the scope, or folded below the old-session
 * fold). The rows are placed as the inbox places them (placeInboxRows: the
 * viewer's scope, the focused session held in place), each in the section it
 * is drawn in (drawnSectionOf; Snoozed, Stashed and Dismissed behind their
 * headers), nested rows under a drawn card; the mark is the one its card
 * computes there
 * (sessionStatusOf over cardSectionOf, the card's live facts from
 * subagentLiveOf). On the sidebar a hosted conversation that ended on a stop
 * is drawn under "Couldn't finish" (splitHostedStops); the phone keeps it
 * under Needs You and draws no stop. A view filter (a project or label chip)
 * is not read: it narrows what is on screen, not what the inbox holds.
 */
export function inboxMarkOf(
  state: PlaceInboxState & SubagentLiveState & { currentSessionId?: string | null },
  id: string,
  { inbox, now }: { inbox: MarkInbox; now: number },
): SessionStatus | null {
  const row = state.sessions[id];
  if (!row) return null;
  const placed = placeInboxRows(state, { focusedId: state.currentSessionId ?? null, now });
  const live = subagentLiveOf(row, now, state);
  // The phone files a hosted stop under Needs You and draws it there as an ask.
  if (inbox === "phone") live.stopped = false;
  const hosted = isHostedAgentType(row.agent_type);
  const hidden = drawnHiddenOf(placed, id);
  if (hidden) return sessionStatusOf({ row, section: cardSectionOf(hidden, undefined), now, live, hosted });
  const section = drawnSectionOf(placed, id);
  if (!section) return drawnNestedOf(placed).has(id) ? subagentStatusOf(row, now, live) : null;
  const key = inbox === "sidebar" && section === "needsInput" && hostedStopOf(row as any, state.messages?.[id] as any) ? "hosted_stopped" : PANEL_KEY_OF_SECTION[section];
  const cardSection = cardSectionOf(section === "working" ? "working" : "default", INBOX_SECTION_DECLARED_STATUS[key]);
  return sessionStatusOf({ row, section: cardSection, placement: cardSection ? null : railRowPlacement(row, now), now, live, hosted });
}
