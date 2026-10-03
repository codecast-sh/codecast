import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  Alert,
  Image,
  Pressable,
  StyleSheet,
  View,
  useWindowDimensions,
} from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Haptics from "expo-haptics";
import { Ionicons } from "@expo/vector-icons";
import { useMutation, useQuery } from "convex/react";
import { useInboxStore } from "@codecast/web/store/inboxStore";
import { roomRecordingLive, roomRecordingOn, type RoomRecordingFields } from "@codecast/web/lib/calls/roomRecordingFields";
import {
  owedStopNotice,
  recordingEndHref,
  roomRunWatch,
  savedWords,
  stoppedWords,
  useRoomRecordingEnded,
  watchRoomRun,
} from "@codecast/web/lib/calls/roomRecordingEnd";
import { useRoomTranscribeOff } from "@codecast/web/hooks/useRoomTranscribeOff";
import { livekit } from "@/lib/calls/livekitNative";
import {
  guestIdFromIdentity,
  humanizeConvexError,
  isGuestParticipant,
  RECORDING_RESTART_COOLDOWN_MS,
} from "@codecast/shared/contracts";
import { mobileRouteForUrl } from "@/lib/linkRoutes";

// VideoTrack from the guarded native module: on a binary without the LiveKit
// natives it is null and the stage renders avatars only (joinCall refuses to
// connect there anyway, so no video track can exist).
const VideoTrack: any = livekit?.VideoTrack ?? (() => null);
import { Track } from "livekit-client";
import { api } from "@codecast/convex/convex/_generated/api";
import { Text } from "@/components/Themed";
// The call stage is always dark (Solarized base03), whatever the app scheme:
// its `Theme.bgAlt` reads are light-on-dark contrast, so pin the light palette.
import { SolarizedLight as Theme } from "@/constants/Theme";
import {
  flipCamera,
  getCallSnapshot,
  getRoom,
  joinCall,
  leaveCall,
  setCamera,
  setMuted,
  setSpeaker,
  subscribeCall,
} from "@/lib/calls/callManager";
import { RingBanner, useIncomingRing, type RingRow } from "@/components/calls/CallOverlay";
import { LivePulse } from "@/components/calls/LiveRooms";
import { acceptInvite, declineInvite } from "@/lib/calls/callManager";
import { stopRinging } from "@/lib/calls/ringtone";
import { GuestDoor, GuestInviteRow, useGuestRemover } from "@/components/calls/GuestDoor";

// The call stage, phone-shaped. The same design intents as the web stage,
// re-derived for a hand-held portrait screen:
//   1. A teammate's screen share owns the stage (that is the codecast
//      gesture); faces shrink to a bottom filmstrip.
//   2. No share → cameras fill an adaptive grid; nobody on camera → large
//      avatars with speaking rings.
//   3. Captions ride the bottom when a scribe (web/desktop) is running.
// Controls are one thumb-reachable bar: mute · camera · flip · speaker ·
// leave. Backgrounding the app does NOT leave the call (UIBackgroundModes
// audio keeps it alive) — leaving is always an explicit red action.
export default function CallScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const call = useSyncExternalStore(subscribeCall, getCallSnapshot, getCallSnapshot);

  // The stage exists only while a call does; a call ending (any path) closes it.
  useEffect(() => {
    if (call.phase === "idle") router.back();
  }, [call.phase, router]);

  const room = getRoom();
  const speaking = useMemo(() => new Set(call.speaking), [call.speaking]);
  // A second ring while on the stage: the root-level banner is under this
  // fullScreenModal, so the stage renders its own (same component, same ring).
  const ring = useIncomingRing();
  // The caller's side of a ring: who we're ringing into THIS room, and whether
  // they declined (the server keeps declines visible for 30s).
  // Off the store (the sync bridge feeds calls.getMyCalls), so the strip is
  // right on the stage's first frame.
  const outgoing = useInboxStore((s) => s.myCalls.outgoing) as any[];
  const outgoingHere = outgoing.filter((o: any) => o.room_key === call.roomKey);
  const ringingNames = outgoingHere.filter((o: any) => o.status === "ringing").map((o: any) => firstName(o.to_name));
  const declinedNames = outgoingHere.filter((o: any) => o.status === "declined").map((o: any) => firstName(o.to_name));
  const onJoinRing = (r: RingRow) => {
    stopRinging();
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    void acceptInvite(String(r._id), r.room_key);
  };
  const onDeclineRing = (r: RingRow) => {
    stopRinging();
    void declineInvite(String(r._id));
  };

  // Track references for rendering, derived straight from the Room (the
  // snapshot's participants array carries flags; the video objects live on
  // the Room itself).
  const { screenRef, cameraRefs } = useMemo(() => {
    let screen: any = null;
    const cams: Array<{ ref: any; identity: string; name: string; isLocal: boolean }> = [];
    if (room) {
      const all = [room.localParticipant, ...room.remoteParticipants.values()];
      for (const p of all) {
        const scr = p.getTrackPublication(Track.Source.ScreenShare);
        if (!screen && scr?.track && (p.isLocal || scr.isSubscribed)) {
          screen = { participant: p, publication: scr, source: Track.Source.ScreenShare };
        }
        const cam = p.getTrackPublication(Track.Source.Camera);
        if (cam?.track && !cam.isMuted && (p.isLocal || cam.isSubscribed)) {
          cams.push({
            ref: { participant: p, publication: cam, source: Track.Source.Camera },
            identity: p.identity,
            name: p.name || p.identity,
            isLocal: p.isLocal,
          });
        }
      }
    }
    return { screenRef: screen, cameraRefs: cams };
    // call.participants is the change signal for track topology.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room, call.participants]);

  const voices = call.participants.filter(
    (p) => !cameraRefs.some((c) => c.identity === p.identity),
  );

  // A guest's face, pressed by somebody who may put them out, asks whether
  // to (useGuestRemover); anyone else's face is not a button.
  const removeGuest = useGuestRemover(call.roomKey);
  const removeGuestOf = (identity: string) => {
    const guestId = guestIdFromIdentity(identity);
    return guestId && removeGuest ? (name: string) => removeGuest(guestId, name) : null;
  };

  // A failed join is not a call: no controls, no captions — the reason, a
  // retry, and a way out. (The pill says "huddle failed" for the same phase.)
  if (call.phase === "error") {
    return (
      <View style={[styles.root, { paddingTop: insets.top }]}>
        <View style={styles.header}>
          <Text style={styles.headerTitle}>huddle</Text>
        </View>
        <View style={styles.errorStage}>
          <Ionicons name="alert-circle-outline" size={34} color={Theme.orange} />
          <Text style={styles.errorTitle}>Couldn't join</Text>
          <Text style={styles.errorText}>{call.error ?? "Something went wrong."}</Text>
          <View style={styles.errorActions}>
            {call.roomKey && (
              <Pressable
                onPress={() => {
                  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                  void joinCall(call.roomKey!);
                }}
                style={({ pressed }) => [styles.errorBtn, styles.errorBtnPrimary, pressed && styles.pressed]}
                accessibilityLabel="Try again"
              >
                <Text style={styles.errorBtnPrimaryText}>Try again</Text>
              </Pressable>
            )}
            <Pressable
              onPress={() => void leaveCall()}
              style={({ pressed }) => [styles.errorBtn, pressed && styles.pressed]}
              accessibilityLabel="Close"
            >
              <Text style={styles.errorBtnText}>Close</Text>
            </Pressable>
          </View>
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <RingBanner ring={ring} top={insets.top + 6} onJoin={onJoinRing} onDecline={onDeclineRing} switching />
      {/* Header: room context + collapse. */}
      <View style={styles.header}>
        <View style={styles.headerLead}>
          <Text style={styles.headerTitle}>huddle</Text>
          <RecordingBadge roomKey={call.roomKey} canStart={call.phase === "connected"} />
          <TranscribingChip roomKey={call.roomKey} />
        </View>
        <Pressable
          hitSlop={12}
          onPress={() => router.back()}
          style={({ pressed }) => [styles.collapseBtn, pressed && styles.pressed]}
          accessibilityLabel="Collapse — the call continues"
        >
          <Ionicons name="chevron-down" size={18} color={Theme.textMuted} />
          <Text style={styles.collapseText}>collapse</Text>
        </Pressable>
      </View>
      <RecordingNotice roomKey={call.roomKey} />
      <RecordingEndNotice roomKey={call.roomKey} />
      <GuestDoor roomKey={call.roomKey} />
      <GuestInviteRow roomKey={call.roomKey} />

      {/* Stage */}
      <View style={styles.stage}>
        {screenRef ? (
          <>
            <View style={styles.hero}>
              <VideoTrack trackRef={screenRef} style={styles.heroVideo} objectFit="contain" />
              <Text style={styles.plate}>
                {screenRef.participant.isLocal
                  ? "your screen"
                  : `${firstName(screenRef.participant.name || screenRef.participant.identity)}'s screen`}
              </Text>
            </View>
            {cameraRefs.length > 0 && (
              <View style={styles.filmstrip}>
                {cameraRefs.map((c) => (
                  <View
                    key={c.identity}
                    style={[
                      styles.stripTile,
                      speaking.has(c.identity) && styles.speakingBorder,
                    ]}
                  >
                    <VideoTrack trackRef={c.ref} style={styles.fill} objectFit="cover" mirror={c.isLocal} />
                    <Text style={styles.plateSmall}>{c.isLocal ? "you" : participantName(c.identity, c.name)}</Text>
                  </View>
                ))}
              </View>
            )}
          </>
        ) : cameraRefs.length > 0 ? (
          <View style={styles.grid}>
            {cameraRefs.map((c) => (
              <View
                key={c.identity}
                style={[
                  styles.gridTile,
                  { width: cameraRefs.length === 1 ? "100%" : (width - 36) / 2 },
                  cameraRefs.length <= 2 && styles.gridTileTall,
                  speaking.has(c.identity) && styles.speakingBorder,
                ]}
              >
                <VideoTrack trackRef={c.ref} style={styles.fill} objectFit="cover" mirror={c.isLocal} />
                <Text style={styles.plateSmall}>{c.isLocal ? "you" : participantName(c.identity, c.name)}</Text>
              </View>
            ))}
          </View>
        ) : (
          <View style={styles.audioStage}>
            {(call.participants.length <= 1) && (
              <Text style={styles.dimNote}>
                {call.phase === "connecting"
                  ? "connecting…"
                  : ringingNames.length > 0
                    ? `ringing ${ringingNames.join(", ")}…`
                    : declinedNames.length > 0
                      ? `${declinedNames.join(", ")} can't right now`
                      : "just you so far"}
              </Text>
            )}
            <View style={styles.avatarRow}>
              {call.participants.map((p) => (
                <Pressable
                  key={p.identity}
                  style={styles.avatarCol}
                  disabled={!removeGuestOf(p.identity)}
                  onPress={() => removeGuestOf(p.identity)?.(firstName(p.name ?? ""))}
                  accessibilityLabel={removeGuestOf(p.identity) ? `${participantName(p.identity, p.name)}: remove from the call` : undefined}
                >
                  <View
                    style={[styles.bigAvatar, speaking.has(p.identity) && styles.speakingRing]}
                  >
                    {p.image ? (
                      <Image source={{ uri: p.image }} style={styles.bigAvatarImage} />
                    ) : (
                      <Text style={styles.bigAvatarLetter}>
                        {(p.name || "?").charAt(0).toUpperCase()}
                      </Text>
                    )}
                  </View>
                  <View style={styles.avatarNameRow}>
                    <Text style={styles.avatarName}>{p.isLocal ? "you" : participantName(p.identity, p.name)}</Text>
                    {p.micMuted && (
                      <Ionicons name="mic-off" size={11} color={Theme.textDim} />
                    )}
                  </View>
                </Pressable>
              ))}
            </View>
          </View>
        )}

        {/* Voice-only roster while others are on camera */}
        {(screenRef || cameraRefs.length > 0) && voices.length > 0 && (
          <View style={styles.voiceRow}>
            {voices.map((p) => (
              <Pressable
                key={p.identity}
                disabled={!removeGuestOf(p.identity)}
                onPress={() => removeGuestOf(p.identity)?.(firstName(p.name ?? ""))}
                style={[styles.voiceChip, speaking.has(p.identity) && styles.speakingBorder]}
              >
                <Text style={styles.voiceChipText}>{p.isLocal ? "you" : participantName(p.identity, p.name)}</Text>
                {p.micMuted && <Ionicons name="mic-off" size={10} color={Theme.textDim} />}
              </Pressable>
            ))}
          </View>
        )}
      </View>

      <Captions roomKey={call.roomKey} />

      {call.error && (
        <View style={styles.errorBar}>
          <Text style={styles.errorBarText}>{call.error}</Text>
        </View>
      )}

      {/* Control bar — one thumb row. */}
      <View style={[styles.controls, { paddingBottom: Math.max(insets.bottom, 14) }]}>
        <ControlButton
          icon={call.muted ? "mic-off" : "mic"}
          active={!call.muted && call.pending !== "mic"}
          danger={call.muted && call.pending !== "mic"}
          disabled={call.pending === "mic"}
          label={call.pending === "mic" ? "asking…" : call.muted ? "unmute" : "mute"}
          onPress={() => {
            void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            void setMuted(!call.muted);
          }}
        />
        <ControlButton
          icon={call.cameraOn ? "videocam" : "videocam-off"}
          active={call.cameraOn && call.pending !== "camera"}
          disabled={call.pending === "camera"}
          label={call.pending === "camera" ? "asking…" : "camera"}
          onPress={() => {
            void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            void setCamera(!call.cameraOn);
          }}
        />
        <ControlButton
          icon="camera-reverse"
          disabled={!call.cameraOn}
          label="flip"
          onPress={() => void flipCamera()}
        />
        <ControlButton
          icon={call.speakerOn ? "volume-high" : "ear"}
          active={call.speakerOn}
          label={call.speakerOn ? "speaker" : "earpiece"}
          onPress={() => void setSpeaker(!call.speakerOn)}
        />
        <ControlButton
          icon="call"
          danger
          filled
          label="leave"
          onPress={() => {
            void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
            void leaveCall();
          }}
        />
      </View>
    </View>
  );
}

// The room is being recorded (convex callRecordings, filmed on LiveKit's
// servers): the same red REC every other call surface wears, read off the
// room's callRooms row (the store's one home for it, fed with the live rooms
// by the sync bridge), so it costs no query of its own and works against a
// server that predates recording (the flag is simply absent). Anyone in the
// call may start it or stop it, so the mark's place offers exactly that.
function useRoomRecordingFlag(roomKey: string | null): boolean {
  return useInboxStore((s) => roomRecordingOn(s as any, roomKey));
}

/** One recording field of the room's row, as a scalar the store compares
 *  (a whole row changes ref with every flag on it). Absent on a server that
 *  predates recording, which then offers no button. */
function useRecordingField<K extends keyof RoomRecordingFields>(roomKey: string | null, key: K): RoomRecordingFields[K] | undefined {
  return useInboxStore((s) => (roomKey ? ((s.callRooms as any)[roomKey] as RoomRecordingFields | undefined)?.[key] : undefined));
}

const useMeId = () => useInboxStore((s) => ((s as any).currentUser?._id?.toString?.() as string | undefined) ?? null);

// The run this phone's own press made, per room: what startRecording
// answered. A press LiveKit refuses fails after the mutation returns (the run
// is started on the server's own clock), so the presser is told through the
// stop notice when the room's last run turns out to be that one, failed
// (watchRoomRun, the rule the web keeps).
const pressedRuns = new Map<string, string>();
// Stops this phone has told its person about, by stopNoticeKey: collapsing
// the call screen and coming back does not say one twice.
const toldStops = new Set<string>();
const stopTold = (key: string) => toldStops.has(key);

/** A run that was stopped is still being written; a new press waits the
 *  server's short cooldown after the stop (the shared rule, counted from
 *  the stop, never from LiveKit's upload), then may record while the last
 *  file is still saving. True while it waits; re-renders when it ends. */
function useRecordingCooling(roomKey: string | null): boolean {
  const status = useRecordingField(roomKey, "recording_status");
  const stopAt = useRecordingField(roomKey, "recording_stop_requested_at") ?? null;
  const [, tick] = useState(0);
  const left = status === "stopping" && stopAt !== null ? stopAt + RECORDING_RESTART_COOLDOWN_MS - Date.now() : 0;
  useEffect(() => {
    if (left <= 0) return;
    const timer = setTimeout(() => tick((n) => n + 1), left + 50);
    return () => clearTimeout(timer);
  }, [left > 0, stopAt]);
  return status === "stopping" && (stopAt === null || left > 0);
}

/** Start recording for everyone, asked first: the room is filmed and every
 *  person in it is told, so it is never one stray tap. The mark turns red
 *  when the server's row says the run began, the same moment every other
 *  surface turns. */
function useConfirmStartRecording(roomKey: string | null): () => void {
  const start = useMutation(api.callRecordings.startRecording);
  return () =>
    Alert.alert("Record this call?", "Video and shared screens are kept with the call. Everyone in it is told, and anyone can stop it.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Record",
        onPress: () => {
          if (!roomKey) return;
          void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          void start({ room_key: roomKey })
            .then((res) => {
              if (!res.existing) pressedRuns.set(roomKey, String(res.recording_id));
            })
            .catch((err: unknown) => Alert.alert("Couldn't start recording", humanizeConvexError(err, "Something went wrong")));
        },
      },
    ]);
}

/** Stop for everyone, asked once more first: one tap must not end the room's
 *  recording. */
function useConfirmStopRecording(roomKey: string | null): () => void {
  const stop = useMutation(api.callRecordings.stopRecording);
  return () =>
    Alert.alert("Stop recording for everyone?", "The video so far is kept with the call.", [
      { text: "Keep recording", style: "cancel" },
      {
        text: "Stop recording",
        style: "destructive",
        onPress: () => {
          if (!roomKey) return;
          void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          void stop({ room_key: roomKey }).catch((err: unknown) =>
            Alert.alert("Couldn't stop the recording", humanizeConvexError(err, "Something went wrong")),
          );
        },
      },
    ]);
}

function RecordingBadge({ roomKey, canStart }: { roomKey: string | null; canStart: boolean }) {
  const recording = useRoomRecordingFlag(roomKey);
  const configured = useRecordingField(roomKey, "recording_configured");
  const unavailable = useRecordingField(roomKey, "recording_unavailable");
  const cooling = useRecordingCooling(roomKey);
  const confirmStop = useConfirmStopRecording(roomKey);
  const confirmStart = useConfirmStartRecording(roomKey);
  if (!recording) {
    if (!canStart) return null;
    // The last run is still being written: say so, and take no press until
    // the server would accept one.
    if (cooling) {
      return (
        <View style={[styles.recordBtn, styles.recordBtnQuiet]} accessibilityLabel="Saving the last recording">
          <LivePulse color={Theme.red} size={5} />
          <Text style={styles.recordText}>saving</Text>
        </View>
      );
    }
    if (configured !== true) return null;
    // Set up, but LiveKit is refusing every recording right now (the plan
    // spent its minutes): the chip stays, dimmed, and a tap says why, so
    // "off for now" never reads as "this app cannot record".
    if (unavailable) {
      return (
        <Pressable
          onPress={() => Alert.alert("Recording is unavailable", unavailable)}
          hitSlop={8}
          style={({ pressed }) => [styles.recordBtn, styles.recordBtnQuiet, pressed && styles.pressed]}
          accessibilityRole="button"
          accessibilityState={{ disabled: true }}
          accessibilityLabel={`Recording unavailable: ${unavailable}`}
        >
          <View style={[styles.recordDot, styles.recordDotOff]} />
          <Text style={styles.recordText}>record</Text>
        </Pressable>
      );
    }
    return (
      <Pressable
        onPress={confirmStart}
        hitSlop={8}
        style={({ pressed }) => [styles.recordBtn, pressed && styles.pressed]}
        accessibilityRole="button"
        accessibilityLabel="Record this call for everyone"
      >
        <View style={styles.recordDot} />
        <Text style={styles.recordText}>record</Text>
      </Pressable>
    );
  }
  return (
    <Pressable
      onPress={confirmStop}
      hitSlop={8}
      style={({ pressed }) => [styles.recBadge, pressed && styles.pressed]}
      accessibilityRole="button"
      accessibilityLabel="This call is being recorded. Tap to stop it"
    >
      <LivePulse color={Theme.red} size={6} />
      <Text style={styles.recText}>REC</Text>
    </Pressable>
  );
}

// The room's words are being transcribed: a live record and the room not
// switched off, the rule the web stage's thread dot follows (green there,
// green here). The same getLive question Captions asks, so one subscription
// answers both. Quiet: a fact about the room, not a control.
function TranscribingChip({ roomKey }: { roomKey: string | null }) {
  const live = useQuery(api.transcripts.getLive, roomKey ? { room_key: roomKey, tail: 3 } : "skip");
  const off = useRoomTranscribeOff(roomKey);
  if (!live || off) return null;
  return (
    <View style={styles.transcribingChip} accessibilityLabel="This call is being transcribed">
      <LivePulse color={Theme.green} size={5} />
      <Text style={styles.transcribingText}>transcribing</Text>
    </View>
  );
}

// Rooms whose current recording this phone has already told its person
// about. Module-wide, so collapsing the call screen and coming back mid-run
// does not tell them again. A room drops out the moment its flag goes false
// (the next run is told afresh) and the moment the person leaves it (walking
// back in is joining later, which is told).
const toldRecording = new Set<string>();
let forgetOnLeave: (() => void) | null = null;
function noteToldRecording(roomKey: string): void {
  toldRecording.add(roomKey);
  forgetOnLeave ??= subscribeCall(() => {
    const seat = getCallSnapshot().roomKey;
    for (const told of [...toldRecording]) if (told !== seat) toldRecording.delete(told);
  });
}

/** Everyone in the room is told a recording is running, in words, once a
 *  run: when somebody starts it while this person is in, and when they walk
 *  into a room already being recorded. The badge alone is not telling. */
function RecordingNotice({ roomKey }: { roomKey: string | null }) {
  const recording = useRoomRecordingFlag(roomKey);
  const confirmStop = useConfirmStopRecording(roomKey);
  // Whoever pressed Record confirmed it themselves and is not told again,
  // the rule every surface keeps (web owesRecordingNotice).
  const me = useMeId();
  const by = useRecordingField(roomKey, "recording_by_id");
  const pressedByMe = !!me && by === me;
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
  return (
    <View style={styles.recNotice} accessibilityRole="alert">
      <LivePulse color={Theme.red} size={6} />
      <View style={styles.recNoticeBody}>
        <Text style={styles.recNoticeTitle}>This call is being recorded</Text>
        <Text style={styles.recNoticeText}>Video and shared screens are kept with the call. Anyone in it can stop it.</Text>
        <View style={styles.recNoticeActions}>
          <Pressable onPress={() => setShown(null)} hitSlop={6} style={({ pressed }) => [styles.recNoticeBtn, pressed && styles.pressed]}>
            <Text style={styles.recNoticeBtnText}>Got it</Text>
          </Pressable>
          <Pressable onPress={confirmStop} hitSlop={6} style={({ pressed }) => [styles.recNoticeBtn, pressed && styles.pressed]}>
            <Text style={[styles.recNoticeBtnText, { color: Theme.red }]}>Stop recording</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

/** How a run ended, said to everyone in the room (the words and the rule
 *  the web's notice uses: lib/calls/roomRecordingEnd): who stopped it or why
 *  it stopped by itself, and where the video went, with a way to open it.
 *  Whoever pressed Stop is not told they stopped it, only where the file
 *  went once it lands, and whoever pressed Record for a run LiveKit refused
 *  is told why, even though the REC mark never came on. A failure stays
 *  until it is read; the rest go by themselves. */
function RecordingEndNotice({ roomKey }: { roomKey: string | null }) {
  const router = useRouter();
  const me = useMeId();
  const status = useRecordingField(roomKey, "recording_status");
  const runId = useRecordingField(roomKey, "recording_run_id");
  const end = useRoomRecordingEnded(roomKey);
  const watch = useRef(roomRunWatch(null));
  const [card, setCard] = useState<{ title: string; body: string; failed: boolean; href: string | null } | null>(null);
  useEffect(() => {
    if (watch.current.room !== roomKey) {
      watch.current = roomRunWatch(roomKey);
      setCard(null);
    }
    if (!roomKey) return;
    const row = (useInboxStore.getState().callRooms as any)?.[roomKey] as RoomRecordingFields | undefined;
    const { running } = watchRoomRun(watch.current, roomRecordingLive(row) ?? null, end, pressedRuns.get(roomKey) ?? null, stopTold, Date.now());
    // A newer run is the news now; the last one's line goes.
    if (running) setCard(null);
    const owed = owedStopNotice(watch.current, end, me, stopTold, Date.now());
    if (!owed || owed.how === "wait") return;
    if (watch.current.stop === owed.stop) watch.current.stop = null;
    if (owed.how === "drop") return;
    toldStops.add(owed.key);
    const words = owed.how === "saved" ? { title: savedWords(owed.end), body: "", failed: false } : stoppedWords(owed.end, me);
    setCard({ ...words, href: recordingEndHref(owed.end) });
    if (words.failed) void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
  }, [roomKey, status, runId, end?.run_id, end?.status, me]);
  useEffect(() => {
    if (!card || card.failed) return;
    const timer = setTimeout(() => setCard((cur) => (cur === card ? null : cur)), 10_000);
    return () => clearTimeout(timer);
  }, [card]);
  if (!card) return null;
  const route = card.href ? mobileRouteForUrl(card.href) : null;
  return (
    <View style={[styles.recNotice, card.failed ? styles.recNoticeFailed : styles.recNoticeEnded]} accessibilityRole="alert">
      <View style={[styles.recNoticeDot, { backgroundColor: card.failed ? Theme.orange : Theme.textDim }]} />
      <View style={styles.recNoticeBody}>
        <Text style={styles.recNoticeTitle}>{card.title}</Text>
        {!!card.body && <Text style={styles.recNoticeText}>{card.body}</Text>}
        <View style={styles.recNoticeActions}>
          <Pressable onPress={() => setCard(null)} hitSlop={6} style={({ pressed }) => [styles.recNoticeBtn, pressed && styles.pressed]}>
            <Text style={styles.recNoticeBtnText}>Got it</Text>
          </Pressable>
          {route && (
            <Pressable
              onPress={() => {
                setCard(null);
                router.push(route as never);
              }}
              hitSlop={6}
              style={({ pressed }) => [styles.recNoticeBtn, pressed && styles.pressed]}
              accessibilityLabel="Open the call at the recording"
            >
              <Text style={styles.recNoticeBtnText}>Open</Text>
            </Pressable>
          )}
        </View>
      </View>
    </View>
  );
}

/** A participant's first name, marked in words when they are a guest (a
 *  person from outside the team on a link): a phone's name plate has no room
 *  for the web's badge, and a guest must never pass for a teammate. The
 *  shared test (isGuestParticipant), the one the web's badge uses. */
function participantName(identity: string, name: string | undefined): string {
  return isGuestParticipant(identity, name) ? `${firstName(name ?? "")} (guest)` : firstName(name ?? "");
}

function firstName(name: string): string {
  return name.split("@")[0].split(/\s+/)[0].toLowerCase() || "teammate";
}

// Live captions while a web/desktop scribe runs — read-only on mobile.
// Captions older than this are noise, not context: joining a huddle an hour
// into a lulled transcript must not resurface the last thing said.
const CAPTION_MAX_AGE_MS = 45_000;

function Captions({ roomKey }: { roomKey: string | null }) {
  const live = useQuery(api.transcripts.getLive, roomKey ? { room_key: roomKey, tail: 3 } : "skip");
  // The query only re-renders on new segments; aging OUT needs a clock. Tick
  // coarsely and only while something is showing.
  const [now, setNow] = useState(() => Date.now());
  const hasTail = !!live && live.tail.length > 0;
  useEffect(() => {
    if (!hasTail) return;
    const t = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(t);
  }, [hasTail]);
  if (!live || live.tail.length === 0) return null;
  const fresh = live.tail.filter((seg: any) => !seg.at || now - seg.at < CAPTION_MAX_AGE_MS);
  if (fresh.length === 0) return null;
  return (
    <View style={styles.captions}>
      {fresh.slice(-2).map((seg: any, i: number, arr: any[]) => (
        <Text
          key={seg.seq}
          style={[styles.captionLine, i === arr.length - 1 && styles.captionLatest]}
          numberOfLines={2}
        >
          <Text style={styles.captionSpeaker}>{participantName(seg.speaker_id ?? "", seg.speaker_name)} </Text>
          {seg.text}
        </Text>
      ))}
    </View>
  );
}

function ControlButton({
  icon,
  label,
  onPress,
  active,
  danger,
  filled,
  disabled,
}: {
  icon: any;
  label: string;
  onPress: () => void;
  active?: boolean;
  danger?: boolean;
  filled?: boolean;
  disabled?: boolean;
}) {
  return (
    <Pressable
      onPress={disabled ? undefined : onPress}
      accessibilityLabel={label}
      style={({ pressed }) => [
        styles.ctl,
        active && styles.ctlActive,
        danger && !filled && styles.ctlDanger,
        filled && styles.ctlFilled,
        disabled && styles.ctlDisabled,
        pressed && !disabled && styles.pressed,
      ]}
    >
      <Ionicons
        name={icon}
        size={22}
        color={
          filled
            ? "#fff"
            : danger
              ? Theme.magenta
              : active
                ? Theme.cyan
                : Theme.textMuted
        }
      />
      <Text style={[styles.ctlLabel, filled && { color: "#fff" }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Theme.assistantBubble },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 18,
    paddingVertical: 10,
  },
  headerTitle: { fontSize: 14, color: Theme.bgAlt, opacity: 0.7 },
  headerLead: { flexDirection: "row", alignItems: "center", gap: 10 },
  recBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
    paddingLeft: 3,
    paddingRight: 7,
    paddingVertical: 3,
    borderRadius: 6,
    backgroundColor: "rgba(220,50,47,0.16)",
    borderWidth: 1,
    borderColor: "rgba(220,50,47,0.35)",
  },
  recText: { fontSize: 10.5, fontWeight: "600", letterSpacing: 0.6, color: Theme.red },
  recordBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: "rgba(253,246,227,0.18)",
  },
  recordDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: Theme.red, opacity: 0.85 },
  recordText: { fontSize: 11, color: Theme.bgAlt, opacity: 0.75 },
  recordBtnQuiet: { opacity: 0.55 },
  recordDotOff: { backgroundColor: Theme.textDim, opacity: 0.6 },
  transcribingChip: { flexDirection: "row", alignItems: "center", gap: 3 },
  transcribingText: { fontSize: 11, color: Theme.green },
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
  collapseBtn: { flexDirection: "row", alignItems: "center", gap: 4, padding: 6 },
  collapseText: { fontSize: 12, color: Theme.bgAlt, opacity: 0.7 },
  pressed: { opacity: 0.6 },
  errorStage: { flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: 32, gap: 10 },
  errorTitle: { fontSize: 18, color: Theme.bgAlt },
  errorText: { fontSize: 13, color: Theme.textDim, textAlign: "center", lineHeight: 19 },
  errorActions: { flexDirection: "row", gap: 12, marginTop: 14 },
  errorBtn: { paddingHorizontal: 18, paddingVertical: 10, borderRadius: 10, backgroundColor: "rgba(253,246,227,0.10)" },
  errorBtnPrimary: { backgroundColor: Theme.green },
  errorBtnPrimaryText: { fontSize: 13, color: "#fff" },
  errorBtnText: { fontSize: 13, color: Theme.bgAlt },

  stage: { flex: 1, paddingHorizontal: 12, gap: 10 },
  hero: {
    flex: 1,
    borderRadius: 14,
    overflow: "hidden",
    backgroundColor: "#001b22",
  },
  heroVideo: { flex: 1 },
  fill: { width: "100%", height: "100%" },
  plate: {
    position: "absolute",
    left: 10,
    bottom: 8,
    fontSize: 11,
    color: Theme.bgAlt,
    backgroundColor: "rgba(0,27,34,0.75)",
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    overflow: "hidden",
  },
  plateSmall: {
    position: "absolute",
    left: 6,
    bottom: 5,
    fontSize: 10,
    color: Theme.bgAlt,
    backgroundColor: "rgba(0,27,34,0.75)",
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 3,
    overflow: "hidden",
  },
  filmstrip: { flexDirection: "row", gap: 8, height: 108 },
  stripTile: {
    width: 84,
    borderRadius: 10,
    overflow: "hidden",
    backgroundColor: "#001b22",
  },
  grid: {
    flex: 1,
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 12,
    alignContent: "center",
    justifyContent: "center",
  },
  gridTile: {
    aspectRatio: 3 / 4,
    borderRadius: 14,
    overflow: "hidden",
    backgroundColor: "#001b22",
  },
  gridTileTall: { aspectRatio: 3 / 4.6 },
  speakingBorder: { borderWidth: 2, borderColor: Theme.cyan },

  audioStage: { flex: 1, alignItems: "center", justifyContent: "center", gap: 20 },
  dimNote: { fontSize: 13, color: Theme.bgAlt, opacity: 0.5 },
  avatarRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 28,
    justifyContent: "center",
  },
  avatarCol: { alignItems: "center", gap: 10 },
  bigAvatar: {
    width: 84,
    height: 84,
    borderRadius: 42,
    backgroundColor: Theme.textSecondary,
    alignItems: "center",
    justifyContent: "center",
  },
  // Fills the circle exactly, so the speaking ring stays a ring around the
  // photo rather than a border with a gap.
  bigAvatarImage: { width: 84, height: 84, borderRadius: 42 },
  speakingRing: { borderWidth: 3, borderColor: Theme.cyan },
  bigAvatarLetter: { fontSize: 30, color: Theme.bgAlt },
  avatarNameRow: { flexDirection: "row", alignItems: "center", gap: 5 },
  avatarName: { fontSize: 12, color: Theme.bgAlt, opacity: 0.85 },

  voiceRow: { flexDirection: "row", flexWrap: "wrap", gap: 6, paddingBottom: 4 },
  voiceChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: "rgba(253,246,227,0.08)",
    borderRadius: 12,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  voiceChipText: { fontSize: 11, color: Theme.bgAlt, opacity: 0.85 },

  captions: { paddingHorizontal: 22, paddingVertical: 6, gap: 2 },
  captionLine: { fontSize: 12, color: Theme.bgAlt, opacity: 0.55, textAlign: "center" },
  captionLatest: { opacity: 0.95 },
  captionSpeaker: { color: Theme.cyan, fontSize: 11 },

  errorBar: {
    marginHorizontal: 18,
    marginBottom: 6,
    backgroundColor: "rgba(203,75,22,0.18)",
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  errorBarText: { fontSize: 12, color: "#e8a87c" },

  controls: {
    flexDirection: "row",
    justifyContent: "space-evenly",
    alignItems: "center",
    paddingTop: 10,
  },
  ctl: { alignItems: "center", gap: 3, minWidth: 56, paddingVertical: 6, borderRadius: 12 },
  ctlActive: {},
  ctlDanger: {},
  ctlFilled: { backgroundColor: Theme.magenta, paddingHorizontal: 14 },
  ctlDisabled: { opacity: 0.3 },
  ctlLabel: { fontSize: 10, color: Theme.bgAlt, opacity: 0.6 },
});
