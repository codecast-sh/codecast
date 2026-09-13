import { useEffect, useMemo, useRef, useState } from "react";
import { Animated, Pressable, StyleSheet, View as RNView } from "react-native";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import FontAwesome from "@expo/vector-icons/FontAwesome";
import * as Haptics from "expo-haptics";
import { useMutation, useQuery } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { CALL_KNOCK_TTL_MS } from "@codecast/shared/contracts";
import { describeRoom } from "@codecast/web/lib/calls/roomLabels";
import { Text } from "@/components/Themed";
import { SolarizedLight, Spacing, themedStyles, useTheme } from "@/constants/Theme";
import { ChatAvatar } from "@/components/chat/MessageRow";
import { joinCall } from "@/lib/calls/callManager";

// Live now, phone-shaped: the huddles running anywhere in your teams, listed
// where you would walk past them. A room is a door — one tap walks into a
// room open to you (muted, no ring, like sitting down at an occupied table)
// and knocks at a locked one. Nothing renders when no huddle is live: rooms
// are keys, not entities, and an empty room does not exist.
//
// The rows are named by the SAME rule as every web surface (describeRoom), so
// a huddle never reads differently on the phone than in the dock.

export type LiveRoomRow = {
  roomKey: string;
  label: string;
  locked: boolean;
  /** The server's own authorizeRoom answer: Join versus Knock branches on this,
   *  never on `locked` (calls.knock refuses anyone who could just join). */
  canJoin: boolean;
  redacted: boolean;
  members: { user_id: string; user_name?: string; user_image?: string }[];
  /** I am seated in it right now. */
  mine: boolean;
};

export type LiveRoomsInput = {
  members: any[] | undefined;
  currentUser: any | null | undefined;
  channels: any[] | undefined;
  rail: { channel_id: string; member_ids?: string[] }[] | undefined;
  /** My live call's room, so "mine" is true the moment I start connecting. */
  myRoomKey: string | null;
};

export function useLiveRooms(input: LiveRoomsInput, enabled: boolean): LiveRoomRow[] | undefined {
  const rooms = useQuery(api.calls.getLiveRooms, enabled ? {} : "skip");
  const { members, currentUser, channels, rail, myRoomKey } = input;
  return useMemo(() => {
    if (!enabled) return [];
    if (rooms === undefined) return undefined;
    const me = String(currentUser?._id ?? "");
    const chatChannels: Record<string, any> = {};
    for (const c of channels ?? []) chatChannels[String(c._id)] = c;
    const store = {
      teamMembers: members ?? [],
      currentUser: currentUser ?? null,
      chatChannels,
      chatRail: rail,
      conversations: {},
      sessions: {},
      liveRooms: rooms,
    };
    return rooms.map((room: any) => ({
      roomKey: room.room_key,
      label: describeRoom(room.room_key, store as any, { redacted: room.redacted, serverTitle: room.title }).label,
      locked: !!room.locked,
      canJoin: !!room.can_join,
      redacted: !!room.redacted,
      members: room.members ?? [],
      mine: myRoomKey === room.room_key || (room.members ?? []).some((m: any) => String(m.user_id) === me),
    }));
  }, [enabled, rooms, members, currentUser, channels, rail, myRoomKey]);
}

/** A knock expires on its own after the server's TTL, so the "knocked" state
 *  is a timestamp per room, re-read on a slow tick. */
function useKnocks(): { knocked: (roomKey: string) => boolean; knock: (roomKey: string) => Promise<void> } {
  const knockMutation = useMutation(api.calls.knock);
  const [at, setAt] = useState<Record<string, number>>({});
  const [, tick] = useState(0);
  useEffect(() => {
    if (Object.keys(at).length === 0) return;
    const t = setInterval(() => tick((n) => n + 1), 5_000);
    return () => clearInterval(t);
  }, [at]);
  return {
    knocked: (roomKey) => Date.now() - (at[roomKey] ?? 0) < CALL_KNOCK_TTL_MS,
    knock: async (roomKey) => {
      setAt((prev) => ({ ...prev, [roomKey]: Date.now() }));
      try {
        await knockMutation({ room_key: roomKey });
      } catch {
        setAt((prev) => {
          const next = { ...prev };
          delete next[roomKey];
          return next;
        });
      }
    },
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
  const { knocked, knock } = useKnocks();
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
  ) : knocked(row.roomKey) ? (
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
  cardLabel: { flex: 1, fontSize: 14, fontWeight: "600", color: Theme.text },
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
