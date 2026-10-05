// The room's recording, as every phone surface reads it: the call screen's
// REC badge and notices, the collapsed in-call pill, and the notice that
// shows over any screen when somebody starts recording. One module, so the
// mark the pill wears and the one the call screen wears cannot disagree.
//
// The room is filmed on LiveKit's servers (convex callRecordings) and the
// facts ride the room's callRooms row (the store's one home for them, fed
// with the live rooms by the sync bridge), so none of this costs a query of
// its own, and a server that predates recording simply has no fields.
import { Alert } from "react-native";
import * as Haptics from "expo-haptics";
import { useInboxStore } from "@codecast/web/store/inboxStore";
import { roomRecordingLive, roomRecordingOn, type RoomRecordingFields } from "@codecast/web/lib/calls/roomRecordingFields";
import { STOP_RECORDING_ASK } from "@codecast/web/lib/calls/roomRecordingEnd";
import { pressRoomRecording, recordingMarkStatus, useRoomRecordingPress } from "@codecast/web/lib/calls/recordingPress";

/** The room's flag alone: on while a run is filming it. */
export function useRoomRecordingFlag(roomKey: string | null): boolean {
  return useInboxStore((s) => roomRecordingOn(s as any, roomKey));
}

/** One recording field of the room's row, as a scalar the store compares
 *  (a whole row changes ref with every flag on it). Absent on a server that
 *  predates recording, which then offers no button. */
export function useRecordingField<K extends keyof RoomRecordingFields>(roomKey: string | null, key: K): RoomRecordingFields[K] | undefined {
  return useInboxStore((s) => (roomKey ? ((s.callRooms as any)[roomKey] as RoomRecordingFields | undefined)?.[key] : undefined));
}

/** The room's red mark as the web's settles it (recordingMarkStatus): this
 *  phone's press in flight decides, then the run on the room's row, then
 *  the flag alone on a server too old to send the run. */
export function useRecordingMarkStatus(roomKey: string | null) {
  const press = useRoomRecordingPress(roomKey);
  return useInboxStore((s) => {
    const row = roomKey ? ((s.callRooms as any)[roomKey] as RoomRecordingFields | undefined) : undefined;
    return recordingMarkStatus({ press, flag: !!row?.recording, live: roomRecordingLive(row) });
  });
}

export const useMeId = () => useInboxStore((s) => ((s as any).currentUser?._id?.toString?.() as string | undefined) ?? null);

/** Stop for everyone, asked once more first: one tap must not end the room's
 *  recording. */
export function useConfirmStopRecording(roomKey: string | null): () => void {
  return () =>
    Alert.alert(STOP_RECORDING_ASK.title, STOP_RECORDING_ASK.body, [
      { text: STOP_RECORDING_ASK.keep, style: "cancel" },
      {
        text: STOP_RECORDING_ASK.stop,
        style: "destructive",
        onPress: () => {
          if (!roomKey) return;
          void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          void pressRoomRecording(roomKey, false, (message) => Alert.alert("Couldn't stop the recording", message));
        },
      },
    ]);
}
