import { useInboxStore } from "../store/inboxStore";

/** The huddle switched transcription off (its callRooms row: localFirst, so
 *  it paints on press). A huddle's record stays live through "off", which is
 *  a gap in it, so words are flowing only while the record is live and this
 *  is false. */
export function useRoomTranscribeOff(roomKey: string | null | undefined): boolean {
  return useInboxStore((s) => !!roomKey && !!s.callRooms[roomKey]?.transcribe_off);
}
