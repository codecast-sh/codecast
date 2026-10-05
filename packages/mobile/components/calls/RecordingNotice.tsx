import { useEffect, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import * as Haptics from "expo-haptics";
import { RECORDING_STARTED_TITLE, startedWords } from "@codecast/web/lib/calls/roomRecordingEnd";
import { Text } from "@/components/Themed";
// A call surface is always dark (Solarized base03), whatever the app scheme.
import { SolarizedLight as Theme } from "@/constants/Theme";
import { getCallSnapshot, subscribeCall } from "@/lib/calls/callManager";
import { useConfirmStopRecording, useMeId, useRecordingField, useRoomRecordingFlag } from "@/lib/calls/recordingMark";
import { LivePulse } from "./LiveRooms";

// Rooms whose current recording this phone has already told its person
// about. Module-wide, so the call screen and the overlay (which shows the
// notice over any other screen) share it: collapsing the call screen, or
// opening it mid-run, never tells them again. A room drops out the moment
// its flag goes false (the next run is told afresh) and the moment the person
// leaves it (walking back in is joining later, which is told).
const toldRecording = new Set<string>();
let forgetOnLeave: (() => void) | null = null;
function noteToldRecording(roomKey: string): void {
  toldRecording.add(roomKey);
  forgetOnLeave ??= subscribeCall(() => {
    const seat = getCallSnapshot().roomKey;
    for (const told of [...toldRecording]) if (told !== seat) toldRecording.delete(told);
  });
}

/**
 * Everyone in the room is told a recording is running, in words and with a
 * haptic, once a run: when somebody starts it while this person is in, and
 * when they walk into a room already being recorded. The badge alone is not
 * telling. Mounted on the call screen (in its flow, under the header) and by
 * the call overlay over every other screen (`floating`, its top edge), since
 * a run started while the person is on another tab must not wait for them
 * to reopen the call to be said.
 */
export function RecordingNotice({ roomKey, floating }: { roomKey: string | null; floating?: { top: number } }) {
  const recording = useRoomRecordingFlag(roomKey);
  const confirmStop = useConfirmStopRecording(roomKey);
  // Whoever pressed Record confirmed it themselves and is not told again,
  // the rule every surface keeps (web owesRecordingNotice).
  const me = useMeId();
  const by = useRecordingField(roomKey, "recording_by_id");
  const pressedByMe = !!me && by === me;
  // Who pressed and whether the video goes out with the public link, read
  // off the room's row as scalars: the words every web surface says
  // (startedWords). A server too old to name the run gets the plain line.
  const byName = useRecordingField(roomKey, "recording_by_name");
  const videoShared = useRecordingField(roomKey, "recording_video_shared");
  const [shown, setShown] = useState<string | null>(null);
  useEffect(() => {
    if (!roomKey) return;
    if (!recording) {
      toldRecording.delete(roomKey);
      setShown(null);
      return;
    }
    if (toldRecording.has(roomKey)) return;
    noteToldRecording(roomKey);
    if (pressedByMe) return;
    setShown(roomKey);
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
  }, [roomKey, recording, pressedByMe]);
  if (!recording || shown !== roomKey) return null;
  const card = (
    <View style={[recNoticeStyles.recNotice, floating && styles.floatingCard]} accessibilityRole="alert">
      <LivePulse color={Theme.red} size={6} />
      <View style={recNoticeStyles.recNoticeBody}>
        <Text style={recNoticeStyles.recNoticeTitle}>{RECORDING_STARTED_TITLE}</Text>
        <Text style={recNoticeStyles.recNoticeText}>{startedWords(byName ? { started_by: { id: by ?? "", name: byName }, video_shared: !!videoShared } : null)}</Text>
        <View style={recNoticeStyles.recNoticeActions}>
          <Pressable onPress={() => setShown(null)} hitSlop={6} style={({ pressed }) => [recNoticeStyles.recNoticeBtn, pressed && recNoticeStyles.pressed]}>
            <Text style={recNoticeStyles.recNoticeBtnText}>Got it</Text>
          </Pressable>
          <Pressable onPress={confirmStop} hitSlop={6} style={({ pressed }) => [recNoticeStyles.recNoticeBtn, pressed && recNoticeStyles.pressed]}>
            <Text style={[recNoticeStyles.recNoticeBtnText, { color: Theme.red }]}>Stop recording</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
  if (!floating) return card;
  // Over a light screen the card's red tint needs the call's dark plate
  // under it, the plate the in-call pill sits on.
  return <View style={[styles.floating, { top: floating.top }]}>{card}</View>;
}

/** The look of a call's notices on the dark call surface: this one, and the
 *  call screen's end-of-recording card beside it. */
export const recNoticeStyles = StyleSheet.create({
  recNotice: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 9,
    marginHorizontal: 14,
    marginBottom: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: "rgba(220,50,47,0.12)",
    borderWidth: 1,
    borderColor: "rgba(220,50,47,0.30)",
  },
  recNoticeEnded: { backgroundColor: "rgba(253,246,227,0.06)", borderColor: "rgba(253,246,227,0.14)" },
  recNoticeFailed: { backgroundColor: "rgba(203,75,22,0.12)", borderColor: "rgba(203,75,22,0.35)" },
  recNoticeDot: { width: 7, height: 7, borderRadius: 3.5, marginTop: 4 },
  recNoticeBody: { flex: 1, gap: 2, marginTop: -3 },
  recNoticeTitle: { fontSize: 12.5, color: Theme.bgAlt },
  recNoticeText: { fontSize: 11.5, lineHeight: 16, color: Theme.textDim },
  recNoticeActions: { flexDirection: "row", gap: 6, marginTop: 6, marginLeft: -6 },
  recNoticeBtn: { paddingHorizontal: 6, paddingVertical: 3, borderRadius: 6 },
  recNoticeBtnText: { fontSize: 11.5, color: Theme.bgAlt },
  pressed: { opacity: 0.6 },
});

const styles = StyleSheet.create({
  floating: {
    position: "absolute",
    left: 12,
    right: 12,
    // Under the ring banner (60), over the in-call pill (55).
    zIndex: 58,
    borderRadius: 10,
    backgroundColor: Theme.assistantBubble,
    shadowColor: "#000",
    shadowOpacity: 0.22,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 8,
  },
  floatingCard: { marginHorizontal: 0, marginBottom: 0 },
});
