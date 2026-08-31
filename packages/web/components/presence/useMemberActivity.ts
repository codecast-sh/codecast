import { useMemo } from "react";
import {
  useInboxStore,
  useTrackedStore,
  sessionsWithPendingSend,
  pendingSendWakeSig,
} from "../../store/inboxStore";
import { fleetCountedSessions, fleetSessionsWakeSig } from "../fleetBands";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { useLiveRoomOfMember } from "../../hooks/useLiveRooms";
import { useWalkieStatus } from "../../hooks/useWalkie";
import {
  fleetSummariesByMember,
  memberPresenceVisual,
  presenceActivityLine,
  type FleetSummary,
  type PresenceVisual,
} from "./memberPresence";

/**
 * Fleet counts for every teammate, from the sessions the store ALREADY holds —
 * restricted to the rows the inbox itself renders (fleetCountedSessions), so
 * the card's numbers always agree with the board and the sidebar badges. The
 * viewer's own set spans every project and machine (the personal inbox
 * subscription is user-wide); teammates' rows count only while the team
 * subscription is live, since outside it their liveness is frozen.
 *
 * Signature-gated, because the people window's roster mounts this and never
 * unmounts. `s.sessions` is a mutative draft: a heartbeat or a streamed
 * message_count on ANY session hands back a new collection ref, and subscribing
 * to it would re-render the whole roster and re-scan the store's 30-day cache
 * several times a minute for a number that did not change. Calling this once at
 * the list instead of per row bounds the call COUNT; only the signature bounds
 * the churn.
 *
 * `fleetSessionsWakeSig` projects exactly what the band and the visibility
 * rules branch on and lives beside `fleetBandFor`, so the two are edited
 * together. The transitions that are driven by TIME rather than by a field —
 * a status going stale — are not in it by design; the coarse clock below is
 * what carries those.
 */
export function useFleetSummaries(): Map<string, FleetSummary> {
  const now = useCoarseNow(15_000);
  const s = useTrackedStore([
    (st: any) => fleetSessionsWakeSig(st.sessions),
    (st: any) => st.sessionsWithQueuedMessages,
    (st: any) => pendingSendWakeSig(st.pendingMessages),
    (st: any) => st.teamInboxIds,
  ]);
  const sessionsSig = fleetSessionsWakeSig(s.sessions);
  const pendingSig = pendingSendWakeSig(s.pendingMessages);
  return useMemo(() => {
    // The signatures are the real deps; the raw collections are read fresh here.
    const st = useInboxStore.getState();
    const opts = {
      queued: st.sessionsWithQueuedMessages ?? new Set<string>(),
      pendingSendIds: sessionsWithPendingSend(st.pendingMessages),
      now,
    };
    const counted = fleetCountedSessions(st.sessions ?? {}, {
      ...opts,
      teamInboxIds: st.teamInboxIds,
      currentSessionId: st.currentSessionId,
      reviveRequestedAt: st.blockedReviveRequestedAt,
    });
    return fleetSummariesByMember(counted, opts);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the signatures stand in for the churny collections
  }, [sessionsSig, pendingSig, s.sessionsWithQueuedMessages, s.teamInboxIds, now]);
}

export interface MemberActivity {
  /** What the badge draws. */
  visual: PresenceVisual;
  /** The one line: "in a huddle · #design", "2 agents working · fixing auth". */
  line: string;
  fleet: FleetSummary | null;
  /** The huddle they are in, when this viewer can see it at all. */
  room: ReturnType<typeof useLiveRoomOfMember>;
}

/**
 * Everything a surface needs to say what one person is doing: the badge state
 * and the activity line, from the live store, the live rooms and the walkie.
 *
 * For a single face (a hover card, a DM header) call this. For a roster, call
 * useFleetSummaries once at the list and presenceActivityLine per row, so
 * twenty rows share one subscription.
 */
export function useMemberActivity(member: any): MemberActivity {
  const now = useCoarseNow(15_000);
  const memberId = String(member?._id ?? "");
  const fleets = useFleetSummaries();
  const room = useLiveRoomOfMember(memberId);
  // "Talking" only where it is free and true: a burst this client is HEARING
  // right now. Whether a teammate is talking to somebody else is not something
  // this viewer is told, and must not be guessed at.
  const walkie = useWalkieStatus();
  const talking = String(walkie.incoming?.fromUserId ?? "") === memberId && !!memberId;
  // A scalar, so this always-mounted hook never subscribes to a churny row.
  const viewerId = useInboxStore((st: any) => (st.currentUser?._id ? String(st.currentUser._id) : ""));
  const fleet = fleets.get(memberId) ?? null;
  const visual = memberPresenceVisual(member);
  const line = useMemo(
    () => presenceActivityLine(member, { now, fleet, room, talking, viewerId }),
    [member, now, fleet, room, talking, viewerId],
  );
  return { visual, line, fleet, room };
}
