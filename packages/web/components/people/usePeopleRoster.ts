// Everything EVERY shape of the people window reads, subscribed once.
//
// The strip, the wall and the list draw the same teammates from the same five
// feeds; what differs is only the shape they draw. Extracting this is not
// tidiness — it is the wake discipline. The panel is always mounted in a
// window of its own, so each of these reads had to be signature-gated exactly
// once, at the top, and every component doing its own version of that is
// another chance to get it wrong. There is one version, it is here, and
// PeoplePanel calls it ONCE and hands the data down — a second call site is a
// second full set of subscriptions and timers in a window that never unmounts.
import { useMemo } from "react";
import { useInboxStore, useTrackedStore } from "../../store/inboxStore";
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
  /** YOUR face: your roster row when it has arrived, else the raw user doc.
   *  The roster row is the one that carries the derived presence fields, and
   *  it is also what setMyStatus patches — reading the user doc made the
   *  panel call its owner "Offline" while every teammate saw them active. */
  me: any | null;
  fleets: Map<string, FleetSummary>;
  roomFor: Map<string, LiveRoomRow>;
  dmFor: Map<string, DmBadge>;
  /** The live rooms themselves, for surfaces that offer the join. */
  rooms: LiveRoomRow[];
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
  // The `me` fallback fields: until the viewer's roster row lands, the header
  // and the strip draw the raw user doc, so a name or avatar syncing onto it
  // must wake this hook. Scalars, so a no-change sync wakes nobody.
  const user = useTrackedStore([
    (st: any) => st.currentUser?._id,
    (st: any) => st.currentUser?.name,
    (st: any) => st.currentUser?.email,
    (st: any) => st.currentUser?.image,
    (st: any) => st.currentUser?.github_avatar_url,
    (st: any) => st.currentUser?.status,
  ]).currentUser;
  const viewerId = user?._id ? String(user._id) : "";
  // The roster array re-pushes every few seconds on teammates' heartbeat
  // counters. This window shows it forever, so it wakes on a signature of the
  // fields a face draws and reads the array itself out of getState().
  const sig = useInboxStore((s) => rosterSig(s.teamMembers));

  const fleets = useFleetSummaries();
  const rooms = useLiveRooms();
  const rail = useChatRail();
  const walkie = useWalkieStatus();

  // One walk of the roster: the viewer's own row out, everyone else in.
  const { members, me } = useMemo(() => {
    const all = (useInboxStore.getState().teamMembers ?? []).filter((m: any) => m?._id);
    return {
      members: all.filter((m: any) => String(m._id) !== viewerId),
      me: all.find((m: any) => String(m._id) === viewerId) ?? user ?? null,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sig stands in for the churny array
  }, [sig, viewerId, user]);

  const roomFor = useMemo(() => roomsByMember(rooms), [rooms]);
  const dmFor = useMemo(() => dmBadgesByMember(rail), [rail]);

  // True only once the viewer's real team list has landed AND the active
  // pointer is not in it. Before that the list is empty for the ordinary reason
  // that it has not arrived, which must not be reported as a stray pointer.
  const strayWorkspace = useInboxStore((st) =>
    isStrayWorkspace(st.teams, st.clientState?.ui?.active_team_id),
  );

  const talkingId = String(walkie.incoming?.fromUserId ?? "");
  const sendingRoomKey = walkie.sending?.roomKey ?? null;

  // ONE object, stable between wakes. Every field above is a memoized ref or a
  // scalar, so this memo only produces a new ref when something a shape draws
  // actually changed — which is what lets a memoized faces row skip renders
  // while a hover or a clock tick moves some other part of the panel.
  return useMemo(
    () => ({
      now,
      viewerId,
      members,
      me,
      fleets,
      roomFor,
      dmFor,
      rooms,
      talkingId,
      sendingRoomKey,
      strayWorkspace,
      huddles: rooms.length,
    }),
    [now, viewerId, members, me, fleets, roomFor, dmFor, rooms, talkingId, sendingRoomKey, strayWorkspace],
  );
}
