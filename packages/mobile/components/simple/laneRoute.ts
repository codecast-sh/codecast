// Which lane the phone opens in (client_state.ui.lane, the same preference
// the web reads through lanePref). Someone who lives in the assistant lane
// lands on its home rather than the inbox, as web's DashboardShell sends
// /inbox to /simple.
//
// Only a gesture on this phone moves the view at once (moveToLane). The
// preference also changes when the person flips it on another device; that
// never pulls this phone out of what it is showing, a half-typed reply or a
// session. It takes effect the next time the person arrives at the tabs.
import { useEffect, useRef } from 'react';
import { router, useSegments } from 'expo-router';
import { useInboxStore } from '@codecast/web/store/inboxStore';
import { LANE_HOME, laneOf, writeLane, type Lane } from '@codecast/web/components/simple/lanePref';
import { laneKnown, laneRouteFor, laneSettled, routeFromOutside, type LaneOpenStore } from '@/lib/laneOpen';

const store = useInboxStore as unknown as LaneOpenStore;

/** Where each lane opens on the phone: the lane's home, or the tabs. */
const PHONE_LANE_HOME: Record<Lane, string> = { simple: LANE_HOME.simple, full: '/' };

/** Opens a lane's home as the only screen, so back never leads into the
 *  other lane. */
function land(lane: Lane): void {
  if (router.canDismiss()) router.dismissAll();
  router.replace(PHONE_LANE_HOME[lane] as never);
}

/** Mounted once, in the root AuthGate. Until the lane is settled (lib/
 *  laneOpen: the server's client_state is in the store, cached or pushed)
 *  nothing moves. Arriving at the tabs (at launch, or coming back to them)
 *  with the lane on opens the lane's home; a preference that changes while
 *  the person stays put moves nothing. A first sign-in on a new phone may
 *  land on the tabs before the server answers; the first settled pass counts
 *  as an arrival, so a lane person still on the tabs moves to the lane then. */
export function useLaneLanding(isAuthenticated: boolean): void {
  const segments = useSegments();
  const simple = useInboxStore((s) => (laneSettled(s) ? laneOf(s.clientState?.ui) === 'simple' : null));
  // The group the last pass saw; null until the lane is settled, so the
  // first settled pass counts as an arrival.
  const lastGroup = useRef<string | undefined | null>(null);
  // A plain string: the generated route types know the groups only once the
  // dev server has regenerated them.
  const group: string | undefined = segments[0];
  useEffect(() => {
    if (!isAuthenticated || simple === null) return;
    const arrived = lastGroup.current !== group;
    lastGroup.current = group;
    if (simple && group === '(tabs)' && arrived) land('simple');
  }, [isAuthenticated, simple, group]);
}

/** Moves the person between lanes from this phone: the preference is
 *  written (it follows them to every device) and the view lands on the
 *  lane's home. */
export function moveToLane(lane: Lane): void {
  writeLane(lane);
  land(lane);
}

/** Opens a conversation from a push, once the lane is known: a push tapped
 *  on a killed app arrives before the cache is read back (lib/laneOpen). */
export function openConversationFromOutside(id: string): void {
  void routeFromOutside(`/session/${id}`, store).then((route) => router.push(route as never));
}

/** After sign-in: the home of the person's lane as the only screen, then
 *  the screen a link asked for before sign-in on top of it, through the
 *  same rule as every outside entry (the link may have been resolved while
 *  signed out, under an empty preference). Landing on the lane's own home
 *  (not the tabs) means useLaneLanding sees no arrival at the tabs, so it
 *  cannot replace the restored link. */
export async function landAfterSignIn(target: string | null): Promise<void> {
  await laneKnown(store);
  const state = store.getState();
  land(laneOf(state.clientState?.ui));
  if (target) router.push(laneRouteFor(target, state) as never);
}
