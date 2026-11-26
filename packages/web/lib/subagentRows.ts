// A card's subagents and spawned workers as the rail draws them under it: each
// one's state, which of them the person's filter keeps, and their order. The
// web rail (components/inbox/SessionCardParts) and the phone inbox both read
// these, so every mode on every surface agrees on a subagent's state.
// The phone bundle reaches this file: relative imports only, no DOM or React.
import { railRowPlacement, showsBlockedBadge, useInboxStore, type InboxSession, type SessionDecisionItem, type SubagentFilter } from "../store/inboxStore";
import { convHasPendingSend } from "../store/inboxOverlays";
import { awaitingOkIds } from "./decisionQueue";
import { hostedStopOf } from "./hostedNotice";
import { sessionLiveAt } from "./liveness";
import { SESSION_STATUSES, sessionStatusOf, type SessionStatus, type StatusLive } from "./sessionStatus";

/** The states each filter level keeps; "all" keeps every state. */
export const SUBAGENT_FILTER_STATES: Record<Exclude<SubagentFilter, "all">, ReadonlySet<SessionStatus>> = {
  active: new Set<SessionStatus>(["needs_you", "error", "working", "starting"]),
  active_done: new Set<SessionStatus>(["needs_you", "error", "working", "starting", "done"]),
};

export function subagentPasses(status: SessionStatus, filter: SubagentFilter): boolean {
  return filter === "all" || SUBAGENT_FILTER_STATES[filter].has(status);
}

/** The store facts a card's state reads beside its row (components/inbox/
 *  SessionCard's liveness): an unconfirmed send, the revive stamp that clears
 *  the blocked badge, a pending `cast decide`, a hosted stop. */
export type SubagentLiveState = {
  pendingMessages?: Record<string, readonly any[] | undefined>;
  blockedReviveRequestedAt?: Record<string, number | undefined>;
  sessionDecisions?: Record<string, SessionDecisionItem>;
  messages?: Record<string, readonly any[] | undefined>;
};

/** The live facts the Modern card passes sessionStatusOf, read without hooks:
 *  from `state`, the store's own state unless given. */
export function subagentLiveOf(session: InboxSession, now: number, state: SubagentLiveState = useInboxStore.getState()): StatusLive {
  const id = String(session._id);
  const pendingSend = convHasPendingSend(state.pendingMessages?.[id] as any);
  return {
    pendingSend,
    blocked: showsBlockedBadge(session.pending_api_error, pendingSend, state.blockedReviveRequestedAt?.[id], now),
    stopped: !!hostedStopOf(session as any, state.messages?.[id] as any),
    asking: awaitingOkIds(state.sessionDecisions).has(id),
  };
}

/** A subagent's state: the verdict its own card shows nested (the rail's
 *  per-row placement, no section, the card's live facts), so Folded, Compact
 *  and Full rows agree. */
export function subagentStatusOf(session: InboxSession, now: number, live: StatusLive = subagentLiveOf(session, now)): SessionStatus {
  return sessionStatusOf({ row: session, section: null, placement: railRowPlacement(session, now), now, live });
}

const SET_ASIDE = new Set<SessionStatus>(["stashed", "killed"]);

/** Whether the filter keeps a child. A stashed or killed child still reads
 *  Stashed or Killed, as its card does, but the filter judges it by its own
 *  activity, the test the bucket's "running" count uses: running, it counts
 *  as working. */
export function subagentKept(session: InboxSession, status: SessionStatus, now: number, filter: SubagentFilter): boolean {
  if (subagentPasses(status, filter)) return true;
  return SET_ASIDE.has(status) && subagentPasses("working", filter) && sessionLiveAt(session, now);
}

export type SubagentRow = { session: InboxSession; status: SessionStatus };

/** A card's children with their states: each once, only those the filter
 *  keeps (and `keepId`, the open one, whatever its state), most urgent state
 *  first and newest first within a state. */
export function subagentRowsOf(children: readonly InboxSession[], now: number, filter: SubagentFilter, keepId?: string | null): SubagentRow[] {
  const seen = new Set<string>();
  const rows: SubagentRow[] = [];
  for (const session of children) {
    const id = String(session._id);
    if (seen.has(id)) continue;
    seen.add(id);
    const status = subagentStatusOf(session, now);
    if (id !== keepId && !subagentKept(session, status, now, filter)) continue;
    rows.push({ session, status });
  }
  const rank = (s: SessionStatus) => SESSION_STATUSES.indexOf(s);
  return rows.sort((a, b) => rank(a.status) - rank(b.status) || (b.session.updated_at ?? 0) - (a.session.updated_at ?? 0));
}

export type SubagentStateGroup = { status: SessionStatus; count: number; newest: InboxSession };

/** Rows (subagentRowsOf order) folded to one entry per state, in the same
 *  order: how many, and the newest, which the folded line's count opens. */
export function subagentStateGroups(rows: readonly SubagentRow[]): SubagentStateGroup[] {
  const groups: SubagentStateGroup[] = [];
  for (const r of rows) {
    const g = groups.find((x) => x.status === r.status);
    if (g) g.count++;
    else groups.push({ status: r.status, count: 1, newest: r.session });
  }
  return groups;
}
