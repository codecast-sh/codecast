import { useInboxStore } from "../../store/inboxStore";
import { roomRecordingFields } from "./roomRecordingFields";

/** One calls.getLiveRooms answer into its two homes: the room flags a person
 *  flips go to `callRooms` (localFirst, so an in-flight toggle survives a
 *  stale push) and the roster to `liveRooms`. One function, so web's
 *  useCallSync and the phone's call feeder file the same rows. */
export function applyLiveRoomsPush(d: unknown): void {
  if (!Array.isArray(d)) return;
  const store = useInboxStore.getState();
  store.syncTable("callRooms", d.map((r: any) => ({
    _id: r.room_key,
    locked: !!r.locked,
    transcribe_off: !!r.transcribe_off,
    transcribe_off_at: r.transcribe_off_at ?? null,
    words_public: !!r.words_public,
    // The room's recording, whole: the flag, the run behind it and
    // whether a press could work (hooks/useRoomRecording, "one home").
    ...roomRecordingFields(r),
  })));
  store.syncTable("liveRooms", d.map(({ locked: _l, transcribe_off: _t, transcribe_off_at: _a, words_public: _w, recording: _r, recording_run: _run, recording_configured: _c, ...room }: any) => room));
}
