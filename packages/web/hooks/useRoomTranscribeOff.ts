import { useInboxStore } from "../store/inboxStore";

/** The huddle switched transcription off (its callRooms row: localFirst, so
 *  it paints on press). A huddle's record stays live through "off", which is
 *  a gap in it, so words are flowing only while the record is live and this
 *  is false. */
export function useRoomTranscribeOff(roomKey: string | null | undefined): boolean {
  return useInboxStore((s) => !!roomKey && !!s.callRooms[roomKey]?.transcribe_off);
}

/** The huddle's live record has its public link on, so the words reach
 *  anyone holding it as they are written (calls.getLiveRooms words_public,
 *  false while transcription is off). */
export function useRoomWordsPublic(roomKey: string | null | undefined): boolean {
  return useInboxStore((s) => !!roomKey && !!s.callRooms[roomKey]?.words_public);
}
