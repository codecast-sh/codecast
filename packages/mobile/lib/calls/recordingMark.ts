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
import type { RoomRecordingFields } from "@codecast/web/lib/calls/roomRecordingFields";
import { STOP_RECORDING_ASK } from "@codecast/web/lib/calls/roomRecordingEnd";
import { pressRoomRecording } from "@codecast/web/lib/calls/recordingPress";
// The mark itself is the web's own hook (Metro-safe), so the pill, the badge
// and the notice read it exactly as every web surface does.
export { useRoomRecordingMark } from "@codecast/web/lib/calls/recordingPress";

/** One recording field of the room's row, as a scalar the store compares
 *  (a whole row changes ref with every flag on it). Absent on a server that
 *  predates recording, which then offers no button. */
export function useRecordingField<K extends keyof RoomRecordingFields>(roomKey: string | null, key: K): RoomRecordingFields[K] | undefined {
  return useInboxStore((s) => (roomKey ? ((s.callRooms as any)[roomKey] as RoomRecordingFields | undefined)?.[key] : undefined));
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
