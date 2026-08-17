import { TouchableOpacity, StyleSheet } from "react-native";
import { useRouter } from "expo-router";
import * as Haptics from "expo-haptics";
import { Ionicons } from "@expo/vector-icons";
import { useQuery } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { sessionRoomKey } from "@codecast/shared/contracts";
import { Text } from "@/components/Themed";
import { Theme } from "@/constants/Theme";
import { joinCall } from "@/lib/calls/callManager";

// The huddle affordance on a session screen: one tap joins the session's own
// room ("huddle about THIS conversation" — same key web's header chip uses).
// When teammates are already in it, the button shows their count so it reads
// as "join them", not "start something". Renders nothing when calling is not
// configured — no dead affordance.
export function SessionHuddleButton({ conversationId }: { conversationId: string }) {
  const router = useRouter();
  const enabled = useQuery(api.calls.getCallConfig)?.enabled === true;
  const roomKey = sessionRoomKey(conversationId);
  const occupancy = useQuery(api.calls.getRoomOccupancy, enabled ? { room_keys: [roomKey] } : "skip");
  if (!enabled) return null;
  const inRoom = (occupancy as any)?.[roomKey]?.length ?? 0;
  return (
    <TouchableOpacity
      onPress={() => {
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
        void joinCall(roomKey);
        router.push("/call");
      }}
      style={[styles.btn, inRoom > 0 && styles.btnLive]}
      hitSlop={{ top: 12, bottom: 12, left: 4, right: 4 }}
      activeOpacity={0.6}
      accessibilityLabel={inRoom > 0 ? `Join huddle, ${inRoom} in it` : "Start a huddle about this session"}
    >
      <Ionicons name="headset-outline" size={17} color={inRoom > 0 ? Theme.green : Theme.textMuted} />
      {inRoom > 0 && <Text style={styles.count}>{inRoom}</Text>}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  btn: { flexDirection: "row", alignItems: "center", gap: 3, paddingHorizontal: 6, paddingVertical: 4 },
  btnLive: { backgroundColor: Theme.green + "1f", borderRadius: 10 },
  count: { fontSize: 11, color: Theme.green },
});
