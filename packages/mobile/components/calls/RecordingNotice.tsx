import { useEffect, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import * as Haptics from "expo-haptics";
import { owesRecordingNotice, RECORDING_STARTED_TITLE, startedWords, STOP_RECORDING_ASK } from "@codecast/web/lib/calls/roomRecordingEnd";
import { Text } from "@/components/Themed";
// A call surface is always dark (Solarized base03), whatever the app scheme.
import { SolarizedLight as Theme } from "@/constants/Theme";
import { getCallSnapshot, subscribeCall } from "@/lib/calls/callManager";
import { useConfirmStopRecording, useRoomRecordingMark } from "@/lib/calls/recordingMark";
import { useMyUserId } from "@codecast/web/store/inboxStore";
import { LivePulse } from "./LiveRooms";

// Runs this phone has already told its person about, by run id, the key the
// web's notice keeps too (owesRecordingNotice). Module-wide, so the call
// screen and the overlay (which shows the notice over any other screen)
// share it: collapsing the call screen, or opening it mid-run, never tells
// them again. Keyed by the run, never the room: a phone asleep through a
// Stop and a new Record only ever sees the latest row, and the second run,
// perhaps somebody else's, is news all the same. Leaving the room forgets
// its runs (walking back in is joining later, which is told).
const toldRuns = new Map<string, string>(); // run id -> room
let forgetOnLeave: (() => void) | null = null;
function noteToldRun(runId: string, roomKey: string): void {
  toldRuns.set(runId, roomKey);
  forgetOnLeave ??= subscribeCall(() => {
    const seat = getCallSnapshot().roomKey;
    for (const [run, room] of [...toldRuns]) if (room !== seat) toldRuns.delete(run);
  });
}
const toldRun = (runId: string) => toldRuns.has(runId);

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
  const { live } = useRoomRecordingMark(roomKey);
  const confirmStop = useConfirmStopRecording(roomKey);
  const me = useMyUserId();
  // The run on show; null once it ends, or when there is nothing to say.
  const [shown, setShown] = useState<string | null>(null);
  const runId = live?.run_id ?? null;
  const owed = !!roomKey && owesRecordingNotice(live, me, toldRun);
  useEffect(() => {
    if (!roomKey || !owed) return;
    // Asked again here, not taken from the render: the call screen and the
    // overlay can both be mounted, and only the first to get here says it.
    if (!owesRecordingNotice(live, me, toldRun)) return;
    noteToldRun(live.run_id, roomKey);
    setShown(live.run_id);
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per run
  }, [roomKey, runId, owed]);
  if (!live || live.status === "stopping" || shown !== live.run_id) return null;
  const card = (
    <View style={[recNoticeStyles.recNotice, floating && styles.floatingCard]} accessibilityRole="alert">
      <LivePulse color={Theme.red} size={6} />
      <View style={recNoticeStyles.recNoticeBody}>
        <Text style={recNoticeStyles.recNoticeTitle}>{RECORDING_STARTED_TITLE}</Text>
        <Text style={recNoticeStyles.recNoticeText}>{startedWords(live)}</Text>
        <View style={recNoticeStyles.recNoticeActions}>
          <Pressable onPress={() => setShown(null)} hitSlop={6} style={({ pressed }) => [recNoticeStyles.recNoticeBtn, pressed && recNoticeStyles.pressed]}>
            <Text style={recNoticeStyles.recNoticeBtnText}>Got it</Text>
          </Pressable>
          <Pressable onPress={confirmStop} hitSlop={6} style={({ pressed }) => [recNoticeStyles.recNoticeBtn, pressed && recNoticeStyles.pressed]}>
            <Text style={[recNoticeStyles.recNoticeBtnText, { color: Theme.red }]}>{STOP_RECORDING_ASK.stop}</Text>
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
