import { useEffect, useMemo, useSyncExternalStore } from "react";
import {
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
import { VideoTrack } from "@livekit/react-native";
import { Track } from "livekit-client";
import { api } from "@codecast/convex/convex/_generated/api";
import { Text } from "@/components/Themed";
import { Theme } from "@/constants/Theme";
import {
  flipCamera,
  getCallSnapshot,
  getRoom,
  leaveCall,
  setCamera,
  setMuted,
  setSpeaker,
  subscribeCall,
} from "@/lib/calls/callManager";

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

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      {/* Header: room context + collapse. */}
      <View style={styles.header}>
        <Text style={styles.headerTitle}>huddle</Text>
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
                    <Text style={styles.plateSmall}>{c.isLocal ? "you" : firstName(c.name)}</Text>
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
                <Text style={styles.plateSmall}>{c.isLocal ? "you" : firstName(c.name)}</Text>
              </View>
            ))}
          </View>
        ) : (
          <View style={styles.audioStage}>
            {call.participants.length === 0 && (
              <Text style={styles.dimNote}>
                {call.phase === "connecting" ? "connecting…" : "just you so far"}
              </Text>
            )}
            <View style={styles.avatarRow}>
              {call.participants.map((p) => (
                <View key={p.identity} style={styles.avatarCol}>
                  <View
                    style={[styles.bigAvatar, speaking.has(p.identity) && styles.speakingRing]}
                  >
                    <Text style={styles.bigAvatarLetter}>
                      {(p.name || "?").charAt(0).toUpperCase()}
                    </Text>
                  </View>
                  <View style={styles.avatarNameRow}>
                    <Text style={styles.avatarName}>{p.isLocal ? "you" : firstName(p.name)}</Text>
                    {p.micMuted && (
                      <Ionicons name="mic-off" size={11} color={Theme.textDim} />
                    )}
                  </View>
                </View>
              ))}
            </View>
          </View>
        )}

        {/* Voice-only roster while others are on camera */}
        {(screenRef || cameraRefs.length > 0) && voices.length > 0 && (
          <View style={styles.voiceRow}>
            {voices.map((p) => (
              <View
                key={p.identity}
                style={[styles.voiceChip, speaking.has(p.identity) && styles.speakingBorder]}
              >
                <Text style={styles.voiceChipText}>{p.isLocal ? "you" : firstName(p.name)}</Text>
                {p.micMuted && <Ionicons name="mic-off" size={10} color={Theme.textDim} />}
              </View>
            ))}
          </View>
        )}
      </View>

      <Captions roomKey={call.roomKey} />

      {call.error && (
        <View style={styles.errorBar}>
          <Text style={styles.errorText}>{call.error}</Text>
        </View>
      )}

      {/* Control bar — one thumb row. */}
      <View style={[styles.controls, { paddingBottom: Math.max(insets.bottom, 14) }]}>
        <ControlButton
          icon={call.muted ? "mic-off" : "mic"}
          active={!call.muted}
          danger={call.muted}
          label={call.muted ? "unmute" : "mute"}
          onPress={() => {
            void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            void setMuted(!call.muted);
          }}
        />
        <ControlButton
          icon={call.cameraOn ? "videocam" : "videocam-off"}
          active={call.cameraOn}
          label="camera"
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

function firstName(name: string): string {
  return name.split("@")[0].split(/\s+/)[0].toLowerCase() || "teammate";
}

// Live captions while a web/desktop scribe runs — read-only on mobile.
function Captions({ roomKey }: { roomKey: string | null }) {
  const live = useQuery(api.transcripts.getLive, roomKey ? { room_key: roomKey, tail: 3 } : "skip");
  if (!live || live.tail.length === 0) return null;
  return (
    <View style={styles.captions}>
      {live.tail.slice(-2).map((seg: any, i: number, arr: any[]) => (
        <Text
          key={seg.seq}
          style={[styles.captionLine, i === arr.length - 1 && styles.captionLatest]}
          numberOfLines={2}
        >
          <Text style={styles.captionSpeaker}>{firstName(seg.speaker_name)} </Text>
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
  collapseBtn: { flexDirection: "row", alignItems: "center", gap: 4, padding: 6 },
  collapseText: { fontSize: 12, color: Theme.bgAlt, opacity: 0.7 },
  pressed: { opacity: 0.6 },

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
  errorText: { fontSize: 12, color: "#e8a87c" },

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
