import { useMemo } from "react";
import { useInboxStore } from "../store/inboxStore";
import { guestsSig, rosterWithGuests, withGuestMedia } from "../lib/calls/roomGuests";
import { walkieCallState } from "../lib/calls/walkie";

const NO_SEATS: any[] = [];
const roomGuestsOf = (st: any, roomKey: string | null) =>
  roomKey ? st.liveRooms?.find((r: any) => r.room_key === roomKey)?.guests : undefined;

/**
 * Everyone a member's call surface draws for a room: its seats, then the
 * guests let in on a link (lib/calls/roomGuests). Every surface that draws the
 * people of the call a person is in reads it here, the stage and the legacy
 * floating circles alike, so a guest with their camera off is a face in both
 * and is marked as a guest in both.
 *
 * `listed` is the server's list, `roster` the same list as the media has it
 * once connected (a guest who cannot be heard is not drawn as here, and a
 * guest's microphone shows), and `guestMedia` what the media said, null when
 * nobody can say. The guests are read by signature: liveRooms is rewritten
 * whole on every push, and only who is in (and their names) paints. The
 * caller re-renders with the call tiles, which is when the media moves.
 */
export function useStageRoster(roomKey: string | null, connected: boolean) {
  const seats: any[] = useInboxStore((st: any) => (roomKey ? st.callOccupancy[roomKey] : undefined)) ?? NO_SEATS;
  const guestKey = useInboxStore((st: any) => guestsSig(roomGuestsOf(st, roomKey)));
  const listed: any[] = useMemo(
    () => rosterWithGuests(seats, roomGuestsOf(useInboxStore.getState(), roomKey)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [seats, guestKey, roomKey],
  );
  const guestMedia = connected ? walkieCallState().guests : null;
  const roster: any[] = useMemo(() => withGuestMedia(listed, guestMedia), [listed, guestMedia]);
  return { listed, roster, guestMedia };
}
