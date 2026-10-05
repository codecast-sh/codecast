/**
 * Where something reached from outside a view opens: a push, a deep link, a
 * tapped codecast link. A lane person (client_state.ui.lane) reads their
 * conversations and approvals in the lane, so a conversation or decision
 * route becomes the lane's screen for it; everyone else keeps the route.
 *
 * The lane is known once the store holds an answer that can carry it
 * (laneSettled): the server's client_state row, read back from the cache or
 * pushed by the feeder, or a lane this device wrote itself. A read-back
 * cache alone is not enough: on a fresh install or a first sign-in it is
 * empty, and an empty preference reads as "full" for a lane person. So every
 * entry (a push tapped on a killed app, a link that launched it, sign-in)
 * waits for it (laneKnown). No React Native and no router here, so it is
 * testable; laneRoute.ts and app/open do the navigating.
 */
import { isHostedAgentType } from '@codecast/shared/contracts';
import { LANE_PATHS, conversationPath, laneOf } from '@codecast/web/components/simple/lanePaths';

type Row = { agent_type?: string | null } | null | undefined;

/** The part of the inbox store these rules read. */
export interface LaneOpenState {
  clientStateInitialized: boolean;
  clientState?: { _id?: unknown; ui?: { lane?: string } | null } | null;
  sessions: Record<string, Row>;
  conversations: Record<string, Row>;
  sessionDecisions?: Record<string, { conversation_id?: string | null } | null | undefined>;
}

export interface LaneOpenStore {
  getState(): LaneOpenState;
  subscribe(listener: (state: LaneOpenState) => void): () => void;
}

/** How long an entry waits for the server's answer before it settles for the
 *  full app. Only a phone with no cached client state waits at all, and that
 *  is a cold start on whatever network it has, so the bound is generous. A
 *  person with no client_state row on the server (they never set anything)
 *  waits it out once, and the full app is right for them. */
export const LANE_WAIT_MS = 8000;

/** Whether the store can say which lane the person is in: the cache has been
 *  read back, and it holds the server's client_state row (its `_id`, which
 *  only a server push puts there and the cache keeps) or a lane this device
 *  set. A sign-out clears both. */
export function laneSettled(s: Pick<LaneOpenState, 'clientStateInitialized' | 'clientState'>): boolean {
  if (!s.clientStateInitialized) return false;
  return s.clientState?._id != null || s.clientState?.ui?.lane !== undefined;
}

/** Resolves once the lane is settled (laneSettled), or after `capMs`. */
export function laneKnown(store: LaneOpenStore, capMs = LANE_WAIT_MS): Promise<void> {
  if (laneSettled(store.getState())) return Promise.resolve();
  return new Promise((resolve) => {
    let unsubscribe: (() => void) | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = () => {
      unsubscribe?.();
      if (timer) clearTimeout(timer);
      resolve();
    };
    unsubscribe = store.subscribe((s) => {
      if (laneSettled(s)) finish();
    });
    timer = setTimeout(finish, capMs);
  });
}

const OUTSIDE_ROUTE = /^\/(session|decisions)\/([^/?#]+)/;

/** The screen an app route opens on for this person. A conversation opens in
 *  the lane unless its row is known to be a coding session; a decision opens
 *  in its conversation when that is a lane conversation, on the lane's
 *  approvals while the decision is not in the store yet, and on its own
 *  screen when it belongs to a coding session. */
export function laneRouteFor(route: string, s: LaneOpenState): string {
  if (laneOf(s.clientState?.ui) !== 'simple') return route;
  const m = OUTSIDE_ROUTE.exec(route);
  if (!m) return route;
  const id = m[2];
  if (m[1] === 'session') {
    const row = s.sessions[id] ?? s.conversations[id];
    return !row || isHostedAgentType(row.agent_type ?? undefined) ? conversationPath(id) : route;
  }
  const conversation = s.sessionDecisions?.[id]?.conversation_id;
  if (!conversation) return LANE_PATHS.approvals;
  const there = laneRouteFor(`/session/${conversation}`, s);
  return there.startsWith(LANE_PATHS.home) ? there : route;
}

/** laneRouteFor, once the lane is known. */
export async function routeFromOutside(route: string, store: LaneOpenStore, capMs = LANE_WAIT_MS): Promise<string> {
  await laneKnown(store, capMs);
  return laneRouteFor(route, store.getState());
}

/** The screen that waits for the lane before opening `route` (app/open). A
 *  link is routed synchronously, before the store is read back, so the
 *  routes laneRouteFor may change go through it; the rest go straight. */
export function viaOpener(route: string): string {
  return OUTSIDE_ROUTE.test(route) ? `/open${route}` : route;
}

/** The route app/open was asked for, from its catch-all segments and query. */
export function openerTarget(to: string | string[] | undefined, query: Record<string, string | string[] | undefined>): string {
  const path = `/${(Array.isArray(to) ? to : to ? [to] : []).map(encodeURIComponent).join('/')}`;
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    for (const one of Array.isArray(v) ? v : v === undefined ? [] : [v]) search.append(k, one);
  }
  const qs = search.toString();
  return qs ? `${path}?${qs}` : path;
}
