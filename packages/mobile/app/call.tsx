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
import { useQuery } from "convex/react";
import { useInboxStore, useMyUserId } from "@codecast/web/store/inboxStore";
import { roomRecordingLive, type RoomRecordingFields } from "@codecast/web/lib/calls/roomRecordingFields";
import {
  owedStopNotice,
  RECORD_ASK,
  RECORDING_SAVING_WORDS,
  RECORDING_SHARED_WORDS,
  RECORDING_STARTED_TITLE,
  TRANSCRIPT_SHARED_WORDS,
  roomRunWatch,
  stopNoticeCard,
  useRoomRecordingEnded,
  watchRoomRun,
  type StopNoticeCard,
} from "@codecast/web/lib/calls/roomRecordingEnd";
import { pressRoomRecording, pressedRunOf, useRecordingCooling } from "@codecast/web/lib/calls/recordingPress";
import { useRoomTranscribeOff, useRoomWordsPublic } from "@codecast/web/hooks/useRoomTranscribeOff";
import { useCoarseNow } from "@codecast/web/hooks/useCoarseNow";
import { formatCallTime } from "@codecast/shared/entities";
import { livekit } from "@/lib/calls/livekitNative";
import {
  guestIdFromIdentity,
  isRecordingFilming,
  markedName,
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
import { RecordingNotice, recNoticeStyles } from "@/components/calls/RecordingNotice";
import { useConfirmStopRecording, useRecordingField, useRoomRecordingMark } from "@/lib/calls/recordingMark";

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
  // What the header's chips say, read here so the header can make room for
  // them: with REC or transcribing showing, the screen is plainly the call
  // and the word "huddle" gives way.
  const filming = isRecordingFilming(useRoomRecordingMark(call.roomKey).status);
  const transcribing = useRoomTranscribing(call.roomKey);
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
          {!filming && !transcribing.on && <Text style={styles.headerTitle}>huddle</Text>}
          <RecordingBadge roomKey={call.roomKey} canStart={call.phase === "connected"} />
          <TranscribingChip transcribing={transcribing} />
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
                  : participantName(screenRef.participant.identity, screenRef.participant.name || screenRef.participant.identity, "'s screen")}
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
// Stops this phone has told its person about, by stopNoticeKey: collapsing
// the call screen and coming back does not say one twice.
const toldStops = new Set<string>();
const stopTold = (key: string) => toldStops.has(key);

/** The web's wait after a stop (recordingPress useRecordingCooling), read
 *  off the room's row. */
function useRoomRecordingCooling(roomKey: string | null): boolean {
  return useRecordingCooling(useRecordingField(roomKey, "recording_status"), useRecordingField(roomKey, "recording_stop_requested_at"));
}

/** Start recording for everyone, asked first: the room is filmed and every
 *  person in it is told, so it is never one stray tap. The press is the
 *  web's (lib/calls/recordingPress): the mark moves the moment Record is
 *  tapped, one press per room is in flight, and a press that does not land
 *  is undone and said. */
function useConfirmStartRecording(roomKey: string | null): () => void {
  return () =>
    Alert.alert(RECORD_ASK.title, RECORD_ASK.lines(roomKey).join("\n\n"), [
      { text: "Cancel", style: "cancel" },
      {
        text: RECORD_ASK.record,
        onPress: () => {
          if (!roomKey) return;
          void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          void pressRoomRecording(roomKey, true, (message) => Alert.alert("Couldn't start recording", message));
        },
      },
    ]);
}

function RecordingBadge({ roomKey, canStart }: { roomKey: string | null; canStart: boolean }) {
  const recording = isRecordingFilming(useRoomRecordingMark(roomKey).status);
  // The file's time 0; null while the room is still starting to be filmed.
  const startedAt = useRecordingField(roomKey, "recording_started_at");
  // The run's video goes out with the call's public link: said on the mark
  // itself, since a phone has no tooltip to carry it (the web's
  // RecordingMark says it in its title).
  const shared = !!useRecordingField(roomKey, "recording_video_shared");
  const configured = useRecordingField(roomKey, "recording_configured");
  const unavailable = useRecordingField(roomKey, "recording_unavailable");
  const cooling = useRoomRecordingCooling(roomKey);
  const confirmStop = useConfirmStopRecording(roomKey);
  const confirmStart = useConfirmStartRecording(roomKey);
  if (!recording) {
    if (!canStart) return null;
    // The last run is still being written: say so, and take no press until
    // the server would accept one.
    if (cooling) {
      return (
        <View style={[styles.recordBtn, styles.recordBtnQuiet]} accessibilityLabel={RECORDING_SAVING_WORDS}>
          {/* Still and grey, the web's saving dot: red means filming now. */}
          <View style={[styles.recordDot, styles.recordDotOff]} />
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
      accessibilityLabel={`${RECORDING_STARTED_TITLE}.${shared ? ` ${RECORDING_SHARED_WORDS}` : ""} Tap to stop it`}
    >
      <LivePulse color={Theme.red} size={6} />
      <Text style={styles.recText} numberOfLines={1}>REC</Text>
      {shared && <PublicGlyph color={Theme.red} />}
      {startedAt ? <RecordingClock startedAt={startedAt} /> : null}
    </Pressable>
  );
}

/** Time filmed so far, read the way the web's RecordingMark reads it (the
 *  shared formatCallTime on the shared one-second clock), so a person can
 *  tell a recording that began a moment ago from one an hour old before
 *  deciding to stop it. Its own component, so only the clock re-renders. */
function RecordingClock({ startedAt }: { startedAt: number }) {
  const now = useCoarseNow(1000);
  return <Text style={[styles.recText, styles.recClock]}>{formatCallTime(Math.max(0, now - startedAt))}</Text>;
}

// The room's words are being transcribed: a live record and the room not
// switched off, the rule the web stage's thread dot follows (green there,
// green here). The same getLive question Captions asks, so one subscription
// answers both. Quiet: a fact about the room, not a control.
function useRoomTranscribing(roomKey: string | null): { on: boolean; public: boolean } {
  const live = useQuery(api.transcripts.getLive, roomKey ? { room_key: roomKey, tail: 3 } : "skip");
  const off = useRoomTranscribeOff(roomKey);
  // The words reach anyone with the call's public link as they are said.
  const wordsPublic = useRoomWordsPublic(roomKey);
  // A record Record made with nobody scribing it yet (started_by null) holds
  // no words until a client claims it.
  return { on: !!live && !!live.started_by && !off, public: wordsPublic };
}

/** A chip's "public": a globe, where the web's tooltip would say it in words
 *  (the chip's accessibility label still does). A phone's header has no room
 *  for the word beside REC and transcribing on an SE-sized screen. */
function PublicGlyph({ color }: { color: string }) {
  return <Ionicons name="globe-outline" size={10} color={color} style={styles.publicGlyph} />;
}

function TranscribingChip({ transcribing }: { transcribing: { on: boolean; public: boolean } }) {
  if (!transcribing.on) return null;
  return (
    <View
      style={styles.transcribingChip}
      accessibilityLabel={`This call is being transcribed.${transcribing.public ? ` ${TRANSCRIPT_SHARED_WORDS}` : ""}`}
    >
      <LivePulse color={Theme.green} size={5} />
      <Text style={styles.transcribingText} numberOfLines={1}>transcribing</Text>
      {transcribing.public && <PublicGlyph color={Theme.green} />}
    </View>
  );
}

/** How a run ended, said to everyone in the room (the words and the rule
 *  the web's notice uses: lib/calls/roomRecordingEnd): who stopped it or why
 *  it stopped by itself, and where the video went, with a way to open it.
 *  Whoever pressed Stop is not told they stopped it, only where the file
 *  went once it lands, and whoever pressed Record for a run LiveKit refused
 *  is told why, even though the REC mark never came on. A run that stopped
 *  by itself while the huddle goes on (it failed, hit a limit, the room
 *  stood empty) stays until it is dismissed, and offers to record again;
 *  the rest go by themselves (stopNoticeCard, the web's rule). */
function RecordingEndNotice({ roomKey }: { roomKey: string | null }) {
  const router = useRouter();
  const me = useMyUserId();
  const filming = isRecordingFilming(useRoomRecordingMark(roomKey).status);
  const unavailable = useRecordingField(roomKey, "recording_unavailable");
  const confirmStart = useConfirmStartRecording(roomKey);
  const status = useRecordingField(roomKey, "recording_status");
  const runId = useRecordingField(roomKey, "recording_run_id");
  const end = useRoomRecordingEnded(roomKey);
  const watch = useRef(roomRunWatch(null));
  const [card, setCard] = useState<StopNoticeCard | null>(null);
  useEffect(() => {
    if (watch.current.room !== roomKey) {
      watch.current = roomRunWatch(roomKey);
      setCard(null);
    }
    if (!roomKey) return;
    const row = (useInboxStore.getState().callRooms as any)?.[roomKey] as RoomRecordingFields | undefined;
    const { running } = watchRoomRun(watch.current, roomRecordingLive(row) ?? null, end, pressedRunOf(roomKey), stopTold, Date.now());
    // A newer run is the news now; the last one's line goes.
    if (running) setCard(null);
    const owed = owedStopNotice(watch.current, end, me, stopTold, Date.now());
    if (!owed || owed.how === "wait") return;
    if (watch.current.stop === owed.stop) watch.current.stop = null;
    if (owed.how === "drop") return;
    toldStops.add(owed.key);
    const next = stopNoticeCard(owed.how, owed.end, me);
    setCard(next);
    if (next.failed || next.sticky) void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
  }, [roomKey, status, runId, end?.run_id, end?.status, me]);
  useEffect(() => {
    if (!card || card.sticky || card.failed) return;
    const timer = setTimeout(() => setCard((cur) => (cur === card ? null : cur)), 10_000);
    return () => clearTimeout(timer);
  }, [card]);
  if (!card) return null;
  const route = card.href ? mobileRouteForUrl(card.href) : null;
  // Somebody already pressed again, or LiveKit is refusing every recording:
  // the old run's card has nothing to offer but itself.
  const again = card.sticky && !unavailable && !filming;
  return (
    <View style={[recNoticeStyles.recNotice, card.failed ? recNoticeStyles.recNoticeFailed : recNoticeStyles.recNoticeEnded]} accessibilityRole="alert">
      <View style={[recNoticeStyles.recNoticeDot, { backgroundColor: card.failed ? Theme.orange : Theme.textDim }]} />
      <View style={recNoticeStyles.recNoticeBody}>
        <Text style={recNoticeStyles.recNoticeTitle}>{card.title}</Text>
        {!!card.body && <Text style={recNoticeStyles.recNoticeText}>{card.body}</Text>}
        <View style={recNoticeStyles.recNoticeActions}>
          <Pressable onPress={() => setCard(null)} hitSlop={6} style={({ pressed }) => [recNoticeStyles.recNoticeBtn, pressed && styles.pressed]}>
            <Text style={recNoticeStyles.recNoticeBtnText}>Got it</Text>
          </Pressable>
          {again && (
            // The card stays while the question is up: a Cancel there keeps
            // it, and the run the answer starts clears it (a newer run is
            // the news).
            <Pressable
              onPress={confirmStart}
              hitSlop={6}
              style={({ pressed }) => [recNoticeStyles.recNoticeBtn, pressed && styles.pressed]}
              accessibilityLabel="Record this call again for everyone"
            >
              <Text style={[recNoticeStyles.recNoticeBtnText, { color: Theme.red }]}>Record again</Text>
            </Pressable>
          )}
          {route && (
            <Pressable
              onPress={() => {
                setCard(null);
                router.push(route as never);
              }}
              hitSlop={6}
              style={({ pressed }) => [recNoticeStyles.recNoticeBtn, pressed && styles.pressed]}
              accessibilityLabel="Open the call at the recording"
            >
              <Text style={recNoticeStyles.recNoticeBtnText}>Open</Text>
            </Pressable>
          )}
        </View>
      </View>
    </View>
  );
}

/** A participant's first name, marked in words when they are a guest (a
 *  person from outside the team on a link) or an agent's face: a phone's
 *  name plate has no room for the web's badge, and neither may pass for a
 *  teammate. The words are the shared markedName, from the mark the web's badge
 *  reads. `what` names something of theirs ("'s screen") and goes before
 *  the mark: "riley's screen (guest)". */
function participantName(identity: string, name: string | undefined, what = ""): string {
  return markedName(firstName(name ?? ""), identity, name, what);
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
  // The chips give way before the collapse button does: an RN row never
  // wraps, so without a shrink the button is pushed off a small screen.
  headerLead: { flexDirection: "row", alignItems: "center", gap: 10, flexShrink: 1, minWidth: 0 },
  publicGlyph: { marginLeft: 3 },
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
  recClock: { marginLeft: 4, fontWeight: "500", letterSpacing: 0, fontVariant: ["tabular-nums"] },
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
  transcribingChip: { flexDirection: "row", alignItems: "center", gap: 3, flexShrink: 1, minWidth: 0 },
  transcribingText: { fontSize: 11, color: Theme.green },
  collapseBtn: { flexDirection: "row", alignItems: "center", gap: 4, padding: 6, flexShrink: 0 },
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
