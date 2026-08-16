import { useEffect, useRef, useSyncExternalStore } from "react";
import { Animated, Pressable, StyleSheet, View } from "react-native";
import { usePathname, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Haptics from "expo-haptics";
import { Ionicons } from "@expo/vector-icons";
import { useQuery } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { Text } from "@/components/Themed";
import { Theme } from "@/constants/Theme";
import { useAuth } from "@/lib/auth";
import {
  acceptInvite,
  declineInvite,
  getCallSnapshot,
  setMuted,
  subscribeCall,
} from "@/lib/calls/callManager";
import { startRinging, stopRinging } from "@/lib/calls/ringtone";
import * as Notifications from "expo-notifications";

async function dismissRingNotifications() {
  try {
    const delivered = await Notifications.getPresentedNotificationsAsync();
    for (const n of delivered) {
      if ((n.request.content.data as any)?.type === "huddle_ring") {
        await Notifications.dismissNotificationAsync(n.request.identifier);
      }
    }
  } catch {}
}

// App-wide call chrome, mounted once in the root layout:
//   RING BANNER — an incoming huddle slides in from the top with the caller's
//   name and Join / Decline. Haptic on arrival; expires with the 45s server
//   TTL (the subscription stops returning it).
//   IN-CALL PILL — while a call is live and the stage is closed, a floating
//   pill above the tab bar keeps the call one tap away (and mute two).
export function CallOverlay() {
  const router = useRouter();
  const pathname = usePathname();
  const insets = useSafeAreaInsets();
  const { isAuthenticated } = useAuth();
  const call = useSyncExternalStore(subscribeCall, getCallSnapshot, getCallSnapshot);
  const myCalls = useQuery(api.calls.getMyCalls, isAuthenticated ? {} : "skip");
  const incoming = myCalls?.incoming ?? [];
  const ring = incoming[0] ?? null;

  // One haptic per distinct ring; the ringtone loops for as long as ANY ring
  // is live and stops the moment the subscription drops it (answered anywhere,
  // declined, cancelled by the caller, or expired server-side).
  const lastRingId = useRef<string | null>(null);
  useEffect(() => {
    const id = ring ? String(ring._id) : null;
    if (id && id !== lastRingId.current) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    }
    lastRingId.current = id;
    if (ring) void startRinging();
    else {
      stopRinging();
      // The ring settled (answered anywhere, declined, cancelled, expired):
      // clear any delivered ring push so the tray never shows a stale
      // "wants to huddle" for a call that already resolved.
      void dismissRingNotifications();
    }
  }, [ring]);
  useEffect(() => stopRinging, []);

  const slide = useRef(new Animated.Value(-120)).current;
  useEffect(() => {
    Animated.spring(slide, {
      toValue: ring ? 0 : -120,
      useNativeDriver: true,
      friction: 9,
      tension: 60,
    }).start();
  }, [ring, slide]);

  const onStage = pathname === "/call";
  const showPill = call.phase !== "idle" && !onStage;

  return (
    <>
      {/* Incoming ring banner */}
      <Animated.View
        pointerEvents={ring ? "auto" : "none"}
        style={[
          styles.banner,
          { top: insets.top + 6, transform: [{ translateY: slide }] },
        ]}
      >
        {ring && (
          <>
            <View style={styles.bannerAvatar}>
              <Text style={styles.bannerAvatarLetter}>
                {(ring.from_name || "?").charAt(0).toUpperCase()}
              </Text>
            </View>
            <View style={styles.bannerText}>
              <Text style={styles.bannerName} numberOfLines={1}>
                {ring.from_name}
              </Text>
              <Text style={styles.bannerSub} numberOfLines={1}>
                {ring.anchor_title ? `huddle · ${ring.anchor_title}` : "wants to huddle"}
              </Text>
            </View>
            <Pressable
              onPress={() => {
                stopRinging();
                void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                void acceptInvite(String(ring._id), ring.room_key);
                router.push("/call");
              }}
              style={({ pressed }) => [styles.joinBtn, pressed && styles.pressed]}
              accessibilityLabel="Join huddle"
            >
              <Ionicons name="call" size={16} color="#fff" />
            </Pressable>
            <Pressable
              onPress={() => {
                stopRinging();
                void declineInvite(String(ring._id));
              }}
              style={({ pressed }) => [styles.declineBtn, pressed && styles.pressed]}
              accessibilityLabel="Decline"
            >
              <Ionicons name="close" size={16} color={Theme.textMuted} />
            </Pressable>
          </>
        )}
      </Animated.View>

      {/* In-call pill */}
      {showPill && (
        <View style={[styles.pill, { bottom: insets.bottom + 64 }]}>
          <Pressable
            onPress={() => router.push("/call")}
            style={({ pressed }) => [styles.pillMain, pressed && styles.pressed]}
            accessibilityLabel="Open the call"
          >
            <View style={styles.liveDot} />
            <Text style={styles.pillText} numberOfLines={1}>
              {call.phase === "connecting" ? "connecting…" : "in a huddle"}
            </Text>
          </Pressable>
          <Pressable
            onPress={() => {
              void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              void setMuted(!call.muted);
            }}
            style={({ pressed }) => [styles.pillMute, pressed && styles.pressed]}
            accessibilityLabel={call.muted ? "Unmute" : "Mute"}
          >
            <Ionicons
              name={call.muted ? "mic-off" : "mic"}
              size={16}
              color={call.muted ? Theme.magenta : Theme.bgAlt}
            />
          </Pressable>
        </View>
      )}
    </>
  );
}

const styles = StyleSheet.create({
  banner: {
    position: "absolute",
    left: 12,
    right: 12,
    zIndex: 60,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: Theme.card,
    borderRadius: 16,
    paddingHorizontal: 12,
    paddingVertical: 10,
    shadowColor: "#000",
    shadowOpacity: 0.18,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 6 },
    elevation: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Theme.borderLight,
  },
  bannerAvatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: Theme.bgHighlight,
    alignItems: "center",
    justifyContent: "center",
  },
  bannerAvatarLetter: { fontSize: 15, color: Theme.textMuted },
  bannerText: { flex: 1, minWidth: 0 },
  bannerName: { fontSize: 14, color: Theme.text },
  bannerSub: { fontSize: 12, color: Theme.textMuted },
  joinBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: Theme.green,
    alignItems: "center",
    justifyContent: "center",
  },
  declineBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: Theme.bgHighlight,
    alignItems: "center",
    justifyContent: "center",
  },
  pressed: { opacity: 0.7 },

  pill: {
    position: "absolute",
    right: 14,
    zIndex: 55,
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: Theme.assistantBubble,
    borderRadius: 22,
    paddingLeft: 12,
    paddingRight: 6,
    paddingVertical: 6,
    gap: 8,
    shadowColor: "#000",
    shadowOpacity: 0.22,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 8,
  },
  pillMain: { flexDirection: "row", alignItems: "center", gap: 7, maxWidth: 150 },
  liveDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: Theme.green },
  pillText: { fontSize: 12, color: Theme.bgAlt },
  pillMute: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(253,246,227,0.12)",
  },
});
