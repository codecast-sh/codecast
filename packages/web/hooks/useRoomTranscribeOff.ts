import { useInboxStore } from "../store/inboxStore";

/** The huddle switched transcription off (liveRooms.transcribe_off, painted on
 *  press by the room's pending flag). A huddle's record stays live through
 *  "off", which is a gap in it, so words are flowing only while the record is
 *  live and this is false. */
export function useRoomTranscribeOff(roomKey: string | null | undefined): boolean {
  return useInboxStore(
    (s: any) => !!roomKey && !!(s.liveRooms as any[] | undefined)?.find((r) => r.room_key === roomKey)?.transcribe_off,
  );
}
