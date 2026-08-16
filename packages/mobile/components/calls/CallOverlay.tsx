import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Animated, Keyboard, Pressable, StyleSheet, View } from "react-native";
import { usePathname, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Haptics from "expo-haptics";
import { Ionicons } from "@expo/vector-icons";
import { useQuery } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { Text } from "@/components/Themed";
import { Theme, TAB_BAR_HEIGHT } from "@/constants/Theme";
import { CALL_PUSH_TYPE_RING } from "@codecast/shared/contracts";
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
      if ((n.request.content.data as any)?.type === CALL_PUSH_TYPE_RING) {
        await Notifications.dismissNotificationAsync(n.request.identifier);
      }
    }
  } catch {}
}

export type RingRow = {
  _id: string;
  room_key: string;
  from_name?: string | null;
  anchor_title?: string | null;
};

// The incoming-ring card, presentational: slides in from the top with the
// caller and Join / Decline. Rendered by CallOverlay (root, every non-modal
// screen) AND by the call stage (a fullScreenModal covers the root layer, so
// a second ring during a call would otherwise be invisible — and every other
// signal is deliberately suppressed there). `switching` relabels Join for the
// in-call case: accepting swaps rooms.
export function RingBanner({
  ring,
  top,
  onJoin,
  onDecline,
  switching,
}: {
  ring: RingRow | null;
  top: number;
  onJoin: (r: RingRow) => void;
  onDecline: (r: RingRow) => void;
  switching?: boolean;
}) {
  const slide = useRef(new Animated.Value(-120)).current;
  useEffect(() => {
    Animated.spring(slide, {
      toValue: ring ? 0 : -120,
      useNativeDriver: true,
      friction: 9,
      tension: 60,
    }).start();
  }, [ring, slide]);
  return (
    <Animated.View
      pointerEvents={ring ? "auto" : "none"}
      style={[styles.banner, { top, transform: [{ translateY: slide }] }]}
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
              {ring.from_name || "A teammate"}
            </Text>
            <Text style={styles.bannerSub} numberOfLines={1}>
              {ring.anchor_title
                ? `huddle · ${ring.anchor_title}`
                : switching
                  ? "wants to huddle — join to switch"
                  : "wants to huddle"}
            </Text>
          </View>
          <Pressable
            onPress={() => onJoin(ring)}
            style={({ pressed }) => [styles.joinBtn, pressed && styles.pressed]}
            accessibilityLabel={switching ? "Switch to this huddle" : "Join huddle"}
          >
            <Ionicons name="call" size={16} color="#fff" />
          </Pressable>
          <Pressable
            onPress={() => onDecline(ring)}
            style={({ pressed }) => [styles.declineBtn, pressed && styles.pressed]}
            accessibilityLabel="Decline"
          >
            <Ionicons name="close" size={16} color={Theme.textMuted} />
          </Pressable>
        </>
      )}
    </Animated.View>
  );
}

// The live incoming ring (first of any), for whichever surface renders the
// banner. Shared so the stage and the overlay agree on which ring is showing.
export function useIncomingRing(): RingRow | null {
  const { isAuthenticated } = useAuth();
  const myCalls = useQuery(api.calls.getMyCalls, isAuthenticated ? {} : "skip");
  return (myCalls?.incoming?.[0] as RingRow | undefined) ?? null;
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
  const ring = useIncomingRing();
  // Manual "busy" is the closed door — same rule as web's useCallRing and the
  // server's ring push: the banner still shows (a silent, dismissable card),
  // but no sound and no haptic.
  const me = useQuery(api.users.getCurrentUser, isAuthenticated ? {} : "skip");
  const quiet = (me as any)?.status === "busy";
  // A call that owns the audio session silences the ring (see ringtone.ts).
  const callOwnsAudio = call.phase === "connecting" || call.phase === "connected";

  // One haptic per distinct ring; the ringtone loops for as long as ANY ring
  // is live and stops the moment the subscription drops it (answered anywhere,
  // declined, cancelled by the caller, or expired server-side) — or the moment
  // a call starts, so joining a huddle from the team tab silences a pending ring.
  const lastRingId = useRef<string | null>(null);
  useEffect(() => {
    const id = ring ? String(ring._id) : null;
    if (id && id !== lastRingId.current && !quiet) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    }
    lastRingId.current = id;
    if (ring && !quiet && !callOwnsAudio) void startRinging();
    else stopRinging();
    if (!ring) {
      // The ring settled (answered anywhere, declined, cancelled, expired):
      // clear any delivered ring push so the tray never shows a stale
      // "wants to huddle" for a call that already resolved.
      void dismissRingNotifications();
    }
  }, [ring, quiet, callOwnsAudio]);
  useEffect(() => stopRinging, []);

  const joinRing = (r: RingRow) => {
    stopRinging();
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    void acceptInvite(String(r._id), r.room_key);
    if (pathname !== "/call") router.push("/call");
  };
  const declineRing = (r: RingRow) => {
    stopRinging();
    void declineInvite(String(r._id));
  };

  const onStage = pathname === "/call";
  const showPill = call.phase !== "idle" && !onStage;
  // Tab screens carry the tab bar; anything pushed over them (session, chat,
  // thread) does not.
  const onTabScreen =
    pathname === "/" || pathname === "/inbox" || pathname === "/tasks" || pathname === "/team" ||
    pathname === "/notifications" || pathname === "/settings" || pathname === "/(tabs)" || pathname.startsWith("/(tabs)/");
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  useEffect(() => {
    const show = Keyboard.addListener("keyboardWillShow", (e) => setKeyboardHeight(e.endCoordinates.height));
    const hide = Keyboard.addListener("keyboardWillHide", () => setKeyboardHeight(0));
    return () => { show.remove(); hide.remove(); };
  }, []);

  return (
    <>
      {/* Incoming ring banner — also mounted on the call stage (a
          fullScreenModal covers this root-level layer). */}
      <RingBanner ring={ring} top={insets.top + 6} onJoin={joinRing} onDecline={declineRing} />

      {/* In-call pill */}
      {showPill && (
        <View
          style={[
            styles.pill,
            // Above the tab bar on tab screens; above the home indicator (or
            // the keyboard) elsewhere. The tab bar's box already includes the
            // bottom inset, so never add both.
            { bottom: (onTabScreen ? TAB_BAR_HEIGHT : Math.max(insets.bottom, 12)) + keyboardHeight + 10 },
          ]}
        >
          <Pressable
            onPress={() => router.push("/call")}
            style={({ pressed }) => [styles.pillMain, pressed && styles.pressed]}
            accessibilityLabel="Open the call"
          >
            <View style={[styles.liveDot, call.phase === "error" && styles.errorDot]} />
            <Text style={styles.pillText} numberOfLines={1}>
              {call.phase === "connecting"
                ? "connecting…"
                : call.phase === "error"
                  ? "huddle failed"
                  : "in a huddle"}
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
    borderRadius: 28,
    paddingLeft: 14,
    paddingRight: 6,
    paddingVertical: 4,
    gap: 8,
    shadowColor: "#000",
    shadowOpacity: 0.22,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 8,
  },
  pillMain: { flexDirection: "row", alignItems: "center", gap: 7, maxWidth: 160, minHeight: 44, paddingRight: 4 },
  liveDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: Theme.green },
  errorDot: { backgroundColor: Theme.orange },
  pillText: { fontSize: 12, color: Theme.bgAlt },
  pillMute: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(253,246,227,0.12)",
  },
});
