// Everything BOTH views of the people window read, subscribed once.
//
// The wall and the list draw the same teammates from the same five feeds; what
// differs is only the shape they draw. Extracting this is not tidiness — it is
// the wake discipline. The panel is always mounted in a window of its own, so
// each of these reads had to be signature-gated exactly once, at the list, and
// two components each doing their own version of that is two chances to get it
// wrong. There is one version, and it is here.
import { useMemo } from "react";
import { useInboxStore } from "../../store/inboxStore";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { useLiveRooms, type LiveRoomRow } from "../../hooks/useLiveRooms";
import { useChatRail } from "../../hooks/useChatSync";
import { useWalkieStatus } from "../../hooks/useWalkie";
import { useFleetSummaries } from "../presence/useMemberActivity";
import { type FleetSummary } from "../presence/memberPresence";
import {
  dmBadgesByMember,
  isStrayWorkspace,
  roomsByMember,
  rosterSig,
  type DmBadge,
} from "./peopleRoster";

export interface PeopleRosterData {
  /** Coarse clock. Every activity line's duration ticks off this and nothing
   *  reads Date.now() in a render. */
  now: number;
  viewerId: string;
  /** The team, minus yourself: your own face belongs in the header, not in the
   *  list of people you can talk to. */
  members: any[];
  fleets: Map<string, FleetSummary>;
  roomFor: Map<string, LiveRoomRow>;
  dmFor: Map<string, DmBadge>;
  /** Whose voice is coming out of this machine right now, if anyone's. */
  talkingId: string;
  /** The room this client's own key is open into, if any. */
  sendingRoomKey: string | null;
  /** The active workspace pointer names a team the viewer has left. */
  strayWorkspace: boolean;
  /** How many huddles are open right now, for the team pulse. */
  huddles: number;
}

export function usePeopleRoster(): PeopleRosterData {
  const now = useCoarseNow(15_000);
  const viewerId = useInboxStore((s) => (s.currentUser?._id ? String(s.currentUser._id) : ""));
  // The roster array re-pushes every few seconds on teammates' heartbeat
  // counters. This window shows it forever, so it wakes on a signature of the
  // fields a face draws and reads the array itself out of getState().
  const sig = useInboxStore((s) => rosterSig(s.teamMembers));

  const fleets = useFleetSummaries();
  const rooms = useLiveRooms();
  const rail = useChatRail();
  const walkie = useWalkieStatus();

  const members = useMemo(
    () =>
      (useInboxStore.getState().teamMembers ?? []).filter(
        (m: any) => m?._id && String(m._id) !== viewerId,
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sig stands in for the churny array
    [sig, viewerId],
  );

  const roomFor = useMemo(() => roomsByMember(rooms), [rooms]);
  const dmFor = useMemo(() => dmBadgesByMember(rail), [rail]);

  // True only once the viewer's real team list has landed AND the active
  // pointer is not in it. Before that the list is empty for the ordinary reason
  // that it has not arrived, which must not be reported as a stray pointer.
  const strayWorkspace = useInboxStore((st) =>
    isStrayWorkspace(st.teams, st.clientState?.ui?.active_team_id),
  );

  return {
    now,
    viewerId,
    members,
    fleets,
    roomFor,
    dmFor,
    talkingId: String(walkie.incoming?.fromUserId ?? ""),
    sendingRoomKey: walkie.sending?.roomKey ?? null,
    strayWorkspace,
    huddles: rooms.length,
  };
}
