import { useEffect, useRef, useSyncExternalStore } from "react";
import { Animated, Pressable, StyleSheet, View as RNView } from "react-native";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import FontAwesome from "@expo/vector-icons/FontAwesome";
import * as Haptics from "expo-haptics";
import { useMutation } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useLiveRoomRows, type LiveRoomRow } from "@codecast/web/hooks/liveRoomRows";
import { useInboxStore } from "@codecast/web/store/inboxStore";
import { Text } from "@/components/Themed";
import { SolarizedLight, Spacing, themedStyles, useTheme } from "@/constants/Theme";
import { ChatAvatar } from "@/components/chat/MessageRow";
import { getCallSnapshot, joinCall, subscribeCall } from "@/lib/calls/callManager";

// Live now, phone-shaped: the huddles running anywhere in your teams, listed
// where you would walk past them. A room is a door — one tap walks into a
// room open to you (muted, no ring, like sitting down at an occupied table)
// and knocks at a locked one. Nothing renders when no huddle is live: rooms
// are keys, not entities, and an empty room does not exist.
//
// The rows are named by the SAME rule as every web surface (describeRoom), so
// a huddle never reads differently on the phone than in the dock.

export type { LiveRoomRow };

/** The live huddles off the store (the sync bridge feeds calls.getLiveRooms),
 *  through web's own derivation, with "mine" meaning my call plane's room. */
export function useLiveRooms(enabled: boolean): LiveRoomRow[] {
  const myRoomKey = useSyncExternalStore(subscribeCall, () => getCallSnapshot().roomKey, () => null);
  const rows = useLiveRoomRows(myRoomKey);
  return enabled ? rows : NO_ROWS;
}

const NO_ROWS: LiveRoomRow[] = [];

/** Knock at a locked door. The row reads "knocked" the moment it is pressed
 *  (the store's knock mark, the same one web paints) and goes back if the
 *  server refuses. The mark expires on the server's TTL by itself. */
function useKnock(): (roomKey: string) => Promise<void> {
  const knockMutation = useMutation(api.calls.knock);
  return async (roomKey) => {
    const store = useInboxStore.getState();
    store.noteKnock(roomKey);
    try {
      await knockMutation({ room_key: roomKey });
    } catch {
      store.clearKnock(roomKey);
    }
  };
}

/** A slow breathing dot: the section is alive, and says so without a count. */
export function LivePulse({ color, size = 8 }: { color: string; size?: number }) {
  const scale = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(scale, { toValue: 1.6, duration: 900, useNativeDriver: true }),
        Animated.timing(scale, { toValue: 1, duration: 900, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [scale]);
  return (
    <RNView style={{ width: size * 2, height: size * 2, alignItems: "center", justifyContent: "center" }}>
      <Animated.View
        style={{
          position: "absolute",
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: color,
          opacity: 0.35,
          transform: [{ scale }],
        }}
      />
      <RNView style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color }} />
    </RNView>
  );
}

/** Overlapping faces, newest on top. */
export function Facepile({ members, max = 3, size = 26 }: { members: LiveRoomRow["members"]; max?: number; size?: number }) {
  const Theme = useTheme();
  const shown = members.slice(0, max);
  const extra = members.length - shown.length;
  return (
    <RNView style={{ flexDirection: "row", alignItems: "center" }}>
      {shown.map((m, i) => (
        <RNView
          key={m.user_id}
          style={{
            marginLeft: i === 0 ? 0 : -(size * 0.35),
            borderRadius: size / 2 + 2,
            borderWidth: 2,
            borderColor: Theme.bg,
            zIndex: shown.length - i,
          }}
        >
          <ChatAvatar author={{ id: m.user_id, name: m.user_name || "Teammate", avatarUrl: m.user_image }} size={size} />
        </RNView>
      ))}
      {extra > 0 && (
        <RNView
          style={{
            marginLeft: -(size * 0.35),
            width: size + 4,
            height: size + 4,
            borderRadius: (size + 4) / 2,
            borderWidth: 2,
            borderColor: Theme.bg,
            backgroundColor: Theme.bgHighlight,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Text style={{ fontSize: 10, color: Theme.textMuted }}>+{extra}</Text>
        </RNView>
      )}
    </RNView>
  );
}

function peopleLine(row: LiveRoomRow): string {
  const names = row.members.map((m) => (m.user_name || "Teammate").split(/\s+/)[0]);
  const list = names.length <= 3 ? names.join(", ") : `${names.slice(0, 2).join(", ")} and ${names.length - 2} more`;
  return row.mine ? `you're in it with ${names.length === 1 ? "nobody yet" : list}` : list;
}

/** One live huddle: faces, name, who is in it, and the one thing you may do
 *  about it. */
export function LiveRoomCard({ row }: { row: LiveRoomRow }) {
  const Theme = useTheme();
  const router = useRouter();
  const knock = useKnock();
  const walkIn = () => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    void joinCall(row.roomKey);
    router.push("/call");
  };
  const action = row.mine ? (
    <Pressable onPress={() => router.push("/call")} style={({ pressed }) => [styles.actionGhost, pressed && styles.pressed]} accessibilityLabel={`Show ${row.label}`}>
      <Text style={styles.actionGhostText}>open</Text>
    </Pressable>
  ) : row.canJoin ? (
    <Pressable onPress={walkIn} style={({ pressed }) => [styles.actionJoin, pressed && styles.pressed]} accessibilityLabel={`Join ${row.label}`}>
      <Ionicons name="headset" size={13} color={SolarizedLight.bgAlt} />
      <Text style={styles.actionJoinText}>join</Text>
    </Pressable>
  ) : row.knocked ? (
    <RNView style={styles.actionGhost}>
      <Text style={styles.actionGhostText}>knocked</Text>
    </RNView>
  ) : (
    <Pressable
      onPress={() => {
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        void knock(row.roomKey);
      }}
      style={({ pressed }) => [styles.actionKnock, pressed && styles.pressed]}
      accessibilityLabel={`Knock at ${row.label}`}
    >
      <Text style={styles.actionKnockText}>knock</Text>
    </Pressable>
  );
  return (
    <Pressable
      onPress={row.mine || row.canJoin ? walkIn : undefined}
      style={({ pressed }) => [styles.card, row.mine && styles.cardMine, pressed && (row.mine || row.canJoin) && styles.pressed]}
    >
      <Facepile members={row.members} />
      <RNView style={styles.cardMain}>
        <RNView style={styles.cardHead}>
          {row.locked && <FontAwesome name="lock" size={11} color={Theme.textMuted0} style={{ marginRight: 4 }} />}
          <Text style={[styles.cardLabel, row.redacted && styles.cardLabelRedacted]} numberOfLines={1}>
            {row.label}
          </Text>
          {/* Being filmed, said before anyone walks in: the web's
              LiveRoomLabel dot, off the same row. */}
          {row.recording && <RNView style={styles.recDot} accessible accessibilityLabel="This call is being recorded" />}
        </RNView>
        <Text style={styles.cardSub} numberOfLines={1}>{peopleLine(row)}</Text>
      </RNView>
      {action}
    </Pressable>
  );
}

const styles = themedStyles((Theme) => StyleSheet.create({
  card: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    marginHorizontal: Spacing.md,
    marginBottom: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 14,
    backgroundColor: Theme.violet + "14",
    borderWidth: 1,
    borderColor: Theme.violet + "38",
  },
  cardMine: { backgroundColor: Theme.green + "16", borderColor: Theme.green + "44" },
  cardMain: { flex: 1, minWidth: 0 },
  cardHead: { flexDirection: "row", alignItems: "center" },
  cardLabel: { flexShrink: 1, fontSize: 14, fontWeight: "600", color: Theme.text },
  recDot: { width: 6, height: 6, borderRadius: 3, marginLeft: 6, backgroundColor: Theme.red },
  cardLabelRedacted: { fontStyle: "italic", color: Theme.textMuted },
  cardSub: { fontSize: 11.5, color: Theme.textMuted, marginTop: 2 },
  actionJoin: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    height: 32,
    paddingHorizontal: 12,
    borderRadius: 16,
    backgroundColor: Theme.violet,
  },
  actionJoinText: { fontSize: 12.5, fontWeight: "700", color: SolarizedLight.bgAlt },
  actionKnock: {
    height: 32,
    paddingHorizontal: 12,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: Theme.violet + "80",
    alignItems: "center",
    justifyContent: "center",
  },
  actionKnockText: { fontSize: 12.5, fontWeight: "600", color: Theme.violet },
  actionGhost: {
    height: 32,
    paddingHorizontal: 12,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: Theme.bg + "80",
  },
  actionGhostText: { fontSize: 12, color: Theme.textMuted },
  pressed: { opacity: 0.7 },
}));
