// The mark an inbox draws for one session (inboxMarkOf): what a priority's
// milestone reads its sessions by (hooks/usePriorityModels liveMarkOf), so
// a milestone and the inbox can never draw one session two ways. Built from
// the inbox's own pieces: its placement (placeInboxRows), the section each
// row is drawn in (drawnSectionOf), and the card's own state for that section
// (lib/sessionStatus cardSectionOf, the panel's INBOX_SECTION_DECLARED_STATUS).
import { isHostedAgentType, isUnderRole } from "@codecast/shared/contracts";
import { hostedStopOf } from "../lib/hostedNotice";
import { queuesDecision, queuesOwnAsk } from "../lib/decisionQueue";
import { isPriorityCard } from "@codecast/shared/contracts/priorityCard";
import { INBOX_SECTION_DECLARED_STATUS, cardSectionOf, sessionStatusOf, type SessionStatus } from "../lib/sessionStatus";
import { dormantActivityOf } from "../lib/railActivity";
import {
  drawnSectionOf, filterInboxScope, placeInboxRows, railRowPlacement, subagentLiveOf, subagentStatusOf,
  type InboxSectionKey, type PlaceInboxState, type PlacedInbox, type SubagentLiveState,
} from "./inboxStore";

/** The inbox a mark is read from: web's sidebar (GlobalSessionPanel) or the phone's inbox. */
export type MarkInbox = "sidebar" | "phone";

/** Each drawn section's renderSection key, which INBOX_SECTION_DECLARED_STATUS reads. */
const PANEL_KEY_OF_SECTION: Record<InboxSectionKey, string> = {
  questions: "questions", pinned: "pinned", newSessions: "new", needsInput: "needs_input", done: "done", dormant: "dormant", working: "working",
};

/** The hidden buckets the inbox draws behind their headers (renderHiddenBucket), each as its cards' variant. */
const HIDDEN_BUCKETS = ["stashed", "dismissed"] as const;
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

const _snoozedIds = new WeakMap<PlacedInbox, Set<string>>();
function snoozedIdsOf(placed: PlacedInbox): Set<string> {
  let ids = _snoozedIds.get(placed);
  if (!ids) _snoozedIds.set(placed, (ids = new Set(placed.snoozed.map((r) => r._id))));
  return ids;
}

/** Each row the inbox draws nested under a drawn card (its subsByParent) → that card's id, per placed inbox. */
const _drawnNested = new WeakMap<PlacedInbox, Map<string, string>>();
function drawnParentOf(placed: PlacedInbox, id: string): string | null {
  let map = _drawnNested.get(placed);
  if (!map) {
    map = new Map();
    for (const [parent, subs] of placed.subsByParent) if (drawnSectionOf(placed, parent)) for (const sub of subs) if (!drawnSectionOf(placed, sub._id)) map.set(sub._id, parent);
    _drawnNested.set(placed, map);
  }
  return map.get(id) ?? null;
}

/**
 * What `inbox` draws for one session: its card's `mark`; whether the inbox
 * counts it as needing the viewer (`asks`: it sits in Questions or Needs
 * You, flat or counted there nested under a lead, or on a pinned card
 * waiting on the viewer); and `target`, the conversation that answer is in
 * (the session itself, or the lead a role's session rides).
 */
export type DrawnMark = { mark: SessionStatus; asks: boolean; target: string };

/**
 * Whether the sidebar's Decisions section lists this session for the viewer
 * (hooks/useDecisionQueue buildDecisionQueue, by its own predicates): an
 * authored ask queued for them, or, in their own scope, the session's own
 * open question or permission prompt.
 */
function inDecisionQueue(state: PlaceInboxState, id: string): boolean {
  const meId = state.currentUser?._id ? String(state.currentUser._id) : undefined;
  // A priority card sits in a session without being its question (shared isPriorityCard): it never makes the session ask.
  for (const d of Object.values(state.sessionDecisions ?? {})) if (d.conversation_id === id && !isPriorityCard(d) && queuesDecision(d, meId)) return true;
  const row = filterInboxScope(state.sessions, "mine", meId)[id];
  return !!row && queuesOwnAsk(row, state.questionResolutions);
}

/** The sections the inbox counts as needing the viewer (its Needs You count and Questions). */
const ASKING_SECTIONS: ReadonlySet<InboxSectionKey> = new Set(["questions", "needsInput"]);

/**
 * What `inbox` draws for one session, or null when it does not draw it (not
 * in the store, outside the scope, or folded below the old-session fold). It
 * follows the inbox's status view (the sections Questions, Pinned, New, Needs
 * You, Couldn't finish, Done, Working, Sleeping (snoozed rows included), and
 * Stashed and Dismissed behind their headers); the other views (Recent, by label, by
 * plan…) group the same rows differently, and a view filter (a project or
 * label chip) narrows what is on screen, not what the inbox holds, so neither
 * is read.
 *
 * The rows are placed as the inbox places them (placeInboxRows: the viewer's
 * scope, `focusedId` held in place: the sidebar's activeSessionId ??
 * currentSessionId, the phone's currentSessionId), each in the section it is
 * drawn in (drawnSectionOf), nested rows under a drawn card. The mark is the
 * one its card computes there: sessionStatusOf over the section (cardSectionOf
 * for a declared one; Questions is an ask), with the card's live facts from
 * subagentLiveOf. Whether it asks is where it sits, not its glyph: an API
 * error filed in Needs You draws the error mark and still asks; a nested row
 * asks where the inbox counts it (nestedSectionOf), or when its own ask is
 * what lifted its lead into Questions. A role's session riding
 * its lead is the role's to triage: it wears the lead's mark, and the lead's
 * conversation is where to answer, unless the session has an ask of its own
 * in the Decisions queue: then it asks, answered in itself. A row the inbox
 * lifts into Questions is drawn there even while a hidden bucket also holds
 * it. A session with an ask in the viewer's Decisions queue (the sidebar's
 * Decisions section; the phone's Decisions badge, menu and screen) asks
 * wherever it sits, and one the inbox does not otherwise draw is drawn there
 * as an ask. On the sidebar a hosted conversation that
 * ended on a stop is drawn under "Couldn't finish" and asks nothing; the
 * phone keeps it under Needs You as an ask.
 *
 * Placing here shares placeInboxRows' memo with the rail, so the rail's work
 * is reused rather than done twice. It keeps lastPlacedInbox current while no
 * rail is drawn too, so sidebarStatusOf reads this placement then; it is the
 * one the rail would draw, from the same inputs. Callers place only when the
 * inbox's wake signatures move (hooks/usePriorityModels usePriorityLiveStates).
 */
export function inboxMarkOf(
  state: PlaceInboxState & SubagentLiveState,
  id: string,
  { inbox, now, focusedId }: { inbox: MarkInbox; now: number; focusedId: string | null },
): DrawnMark | null {
  const row = state.sessions[id];
  // Decisions (the sidebar's section, the phone's badge and screen) lists every ask queued for the viewer wherever
  // its session sits (stashed, snoozed, dismissed, not even in the store): such a session needs the viewer, drawn there as an ask.
  const queued = inDecisionQueue(state, id);
  const asked: DrawnMark = { mark: "needs_you", asks: true, target: id };
  if (!row) return queued ? asked : null;
  const placed = placeInboxRows(state, { focusedId, now });
  const live = subagentLiveOf(row, now, state);
  // The phone files a hosted stop under Needs You and draws it there as an ask.
  if (inbox === "phone") live.stopped = false;
  const stopped = inbox === "sidebar" && !!hostedStopOf(row as any, state.messages?.[id] as any);
  const hosted = isHostedAgentType(row.agent_type);
  // A snoozed row sleeps in Sleeping, drawn there like the section's own rows.
  const section = drawnSectionOf(placed, id) ?? (snoozedIdsOf(placed).has(id) ? "dormant" : null);
  // A row the inbox lifts into Questions (an ask on a stashed or snoozed session) is drawn there, whatever bucket also holds it.
  const hidden = section === "questions" ? null : drawnHiddenOf(placed, id);
  if (queued && (hidden || (!section && !drawnParentOf(placed, id)))) return asked;
  if (hidden) return { mark: sessionStatusOf({ row, section: cardSectionOf(hidden, undefined), now, live, hosted }), asks: false, target: id };
  if (!section) {
    const parent = drawnParentOf(placed, id);
    if (!parent) return null;
    // A role's session rides its lead's card, except for an ask of its own in Decisions: the answer is in the session itself.
    if (isUnderRole(row)) return queued ? asked : inboxMarkOf(state, parent, { inbox, now, focusedId });
    // Counted where the inbox counts it nested, or the ask its lead was lifted into Questions for (askingChildParents).
    const counted = placed.nestedSectionOf.get(id);
    const asks = queued || (!!counted && ASKING_SECTIONS.has(counted) && !stopped) || (drawnSectionOf(placed, parent) === "questions" && !!live.asking);
    return { mark: subagentStatusOf(row, now, live), asks, target: id };
  }
  const key = section === "needsInput" && stopped ? "hosted_stopped" : PANEL_KEY_OF_SECTION[section];
  // An asleep row draws where the rail's split puts it (lib/railActivity): its own work running reads Working, its change shipping reads Shipping.
  const split = key === "dormant" ? dormantActivityOf(state as never, row as never, "dormant", now) : null;
  const cardSection = section === "questions" ? "questions" : split === "working" || split === "shipping" ? split : cardSectionOf(section === "working" ? "working" : "default", INBOX_SECTION_DECLARED_STATUS[key]);
  const mark = sessionStatusOf({ row, section: cardSection, placement: cardSection ? null : railRowPlacement(row, now), now, live, hosted });
  // A pinned card keeps its own verdict: it waits on the viewer when that verdict is an ask or a failure to clear.
  const asks = queued || (section === "pinned" ? mark === "needs_you" || mark === "error" : ASKING_SECTIONS.has(section) && key !== "hosted_stopped");
  return { mark, asks, target: id };
}
