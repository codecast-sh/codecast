import { Alert, TouchableOpacity, StyleSheet } from "react-native";
import { useRouter } from "expo-router";
import * as Haptics from "expo-haptics";
import { Ionicons } from "@expo/vector-icons";
import { useQuery } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { CHANNEL_HUDDLE_WARNING_SIZE, parseRoomKey, sessionRoomKey } from "@codecast/shared/contracts";
import { Text } from "@/components/Themed";
import { Theme, themedStyles, useTheme } from "@/constants/Theme";
import { joinCall, startHuddle } from "@/lib/calls/callManager";

// The huddle affordance for anything with a room: one tap joins the room
// (same key web's chips use) — and rings `ring` if given (a DM or group
// thread rings its people). When
// teammates are already in it, the button shows their count so it reads as
// "join them", not "start something". Renders nothing when calling is not
// configured, or when calls are off for the room's team (a per-team opt-in;
// getCallConfig lists the caller's teams that have it on) — no dead
// affordance.
export function HuddleButton({
  roomKey,
  teamId,
  ring,
  anchorTitle,
  channelMemberCount,
}: {
  roomKey: string;
  teamId?: string | null;
  ring?: string[];
  anchorTitle?: string;
  channelMemberCount?: number;
}) {
  const Theme = useTheme();
  const router = useRouter();
  const config = useQuery(api.calls.getCallConfig);
  const enabled = config?.enabled === true && !!teamId && (config.teams ?? []).includes(String(teamId));
  const occupancy = useQuery(api.calls.getRoomOccupancy, enabled ? { room_keys: [roomKey] } : "skip");
  if (!enabled) return null;
  const inRoom = (occupancy as any)?.[roomKey]?.length ?? 0;
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
  return (
    <TouchableOpacity
      disabled={isChannel && inRoom === 0 && channelMemberCount === undefined}
      onPress={() => {
        if (inRoom === 0 && isChannel && (channelMemberCount ?? 0) > CHANNEL_HUDDLE_WARNING_SIZE) {
          Alert.alert(
            `Buzz everyone in ${anchorTitle || "this channel"}?`,
            `This channel has ${channelMemberCount} members. Starting a huddle will buzz all ${channelMemberCount! - 1} other members.`,
            [{ text: "Cancel", style: "cancel" }, { text: "Start and buzz everyone", onPress: start }],
          );
        } else {
          start();
        }
      }}
      style={[styles.btn, inRoom > 0 && styles.btnLive]}
      hitSlop={{ top: 12, bottom: 12, left: 4, right: 4 }}
      activeOpacity={0.6}
      accessibilityLabel={
        inRoom > 0
          ? `Join huddle, ${inRoom} in it`
          : isChannel || ring?.length
            ? "Start a huddle and ring everyone here"
            : "Start a huddle here"
      }
    >
      <Ionicons name="headset-outline" size={17} color={inRoom > 0 ? Theme.green : Theme.textMuted} />
      {inRoom > 0 && <Text style={styles.count}>{inRoom}</Text>}
    </TouchableOpacity>
  );
}

// Session screens: the room of one conversation.
export function SessionHuddleButton({ conversationId, teamId }: { conversationId: string; teamId?: string | null }) {
  return <HuddleButton roomKey={sessionRoomKey(conversationId)} teamId={teamId} />;
}

const styles = themedStyles((Theme) => StyleSheet.create({
  btn: { flexDirection: "row", alignItems: "center", gap: 3, paddingHorizontal: 6, paddingVertical: 4 },
  btnLive: { backgroundColor: Theme.green + "1f", borderRadius: 10 },
  count: { fontSize: 11, color: Theme.green },
}));
