import { Alert, TouchableOpacity, StyleSheet } from "react-native";
import { useRouter } from "expo-router";
import * as Haptics from "expo-haptics";
import { Ionicons } from "@expo/vector-icons";
import { useInboxStore } from "@codecast/web/store/inboxStore";
import { CHANNEL_HUDDLE_WARNING_SIZE, parseRoomKey, sessionRoomKey } from "@codecast/shared/contracts";
import { Text } from "@/components/Themed";
import { Theme, themedStyles, useTheme } from "@/constants/Theme";
import { joinCall, startHuddle } from "@/lib/calls/callManager";

type HuddleTarget = {
  roomKey: string;
  teamId?: string | null;
  ring?: string[];
  anchorTitle?: string;
  channelMemberCount?: number;
};

// What a huddle affordance needs, wherever it is drawn (a header button, a row
// in an action sheet): whether calling is on for the room's team, who is in the
// room, a label that reads "join them" when someone is, and the press itself.
export function useHuddleAction({ roomKey, teamId, ring, anchorTitle, channelMemberCount }: HuddleTarget) {
  const router = useRouter();
  // Both off the store the sync bridge feeds: whether calling is on for the
  // team, and who is in this room (every live room in my teams carries its
  // members), so the affordance paints its final state on the first frame.
  const enabled = useInboxStore((s) => {
    const config = s.callConfig as { enabled: boolean; teams?: string[] } | null;
    return config?.enabled === true && !!teamId && (config.teams ?? []).includes(String(teamId));
  });
  const inRoom = useInboxStore((s) => s.liveRooms.find((r: any) => r.room_key === roomKey)?.members.length ?? 0);
  const isChannel = parseRoomKey(roomKey)?.kind === "channel";
  const start = () => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    if (inRoom === 0 && (isChannel || ring?.length)) {
      void startHuddle({ roomKey, toUserIds: ring ?? [], anchorTitle, ringChannel: isChannel });
    } else {
      void joinCall(roomKey);
    }
    router.push("/call");
  };
  const press = () => {
    if (inRoom === 0 && isChannel && (channelMemberCount ?? 0) > CHANNEL_HUDDLE_WARNING_SIZE) {
      Alert.alert(
        `Buzz everyone in ${anchorTitle || "this channel"}?`,
        `This channel has ${channelMemberCount} members. Starting a huddle will buzz all ${channelMemberCount! - 1} other members.`,
        [{ text: "Cancel", style: "cancel" }, { text: "Start and buzz everyone", onPress: start }],
      );
    } else {
      start();
    }
  };
  const label = inRoom > 0
    ? `Join huddle, ${inRoom} in it`
    : isChannel || ring?.length
      ? "Start a huddle and ring everyone here"
      : "Start a huddle here";
  return {
    enabled,
    inRoom,
    label,
    press,
    pressDisabled: isChannel && inRoom === 0 && channelMemberCount === undefined,
  };
}

// The huddle affordance for anything with a room: one tap joins the room
// (same key web's chips use) — and rings `ring` if given (a DM or group
// thread rings its people). When teammates are already in it, the button
// shows their count so it reads as "join them", not "start something".
// Renders nothing when calling is not configured, or when calls are off for
// the room's team (a per-team opt-in; callConfig lists the caller's teams that
// have it on) — no dead affordance.
export function HuddleButton(target: HuddleTarget) {
  const Theme = useTheme();
  const huddle = useHuddleAction(target);
  if (!huddle.enabled) return null;
  return (
    <TouchableOpacity
      disabled={huddle.pressDisabled}
      onPress={huddle.press}
      style={[styles.btn, huddle.inRoom > 0 && styles.btnLive]}
      hitSlop={{ top: 12, bottom: 12, left: 4, right: 4 }}
      activeOpacity={0.6}
      accessibilityLabel={huddle.label}
    >
      <Ionicons name="headset-outline" size={17} color={huddle.inRoom > 0 ? Theme.green : Theme.textMuted} />
      {huddle.inRoom > 0 && <Text style={styles.count}>{huddle.inRoom}</Text>}
    </TouchableOpacity>
  );
}

// Session screens: the room of one conversation.
export function useSessionHuddle(conversationId: string, teamId?: string | null) {
  return useHuddleAction({ roomKey: sessionRoomKey(conversationId), teamId });
}

const styles = themedStyles((Theme) => StyleSheet.create({
  btn: { flexDirection: "row", alignItems: "center", gap: 3, paddingHorizontal: 6, paddingVertical: 4 },
  btnLive: { backgroundColor: Theme.green + "1f", borderRadius: 10 },
  count: { fontSize: 11, color: Theme.green },
}));
