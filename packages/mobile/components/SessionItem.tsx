import { StyleSheet, TouchableOpacity, View as RNView, Animated as RNAnimated, PanResponder, Image, Modal, Pressable } from 'react-native';
import { Text as RNText } from '@/components/Themed';
import { useRef, useCallback, useEffect, useMemo, useState } from 'react';
import { cleanUserMessage } from '@codecast/web/components/sessionMessage';
import { useInboxStore } from '@codecast/web/store/inboxStore';
import { useAckAssignment } from '@codecast/web/hooks/useAckAssignment';
import { threadStateView } from '@codecast/web/lib/threadState';
import { gestureHandler } from '@/lib/gestureHandler';
import * as Haptics from 'expo-haptics';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import Feather from '@expo/vector-icons/Feather';
import { Theme, Spacing } from '@/constants/Theme';

export type SessionData = {
  _id: string;
  session_id?: string;
  title?: string;
  subtitle?: string;
  updated_at: number;
  started_at?: number;
  project_path?: string | null;
  git_root?: string | null;
  agent_type?: string;
  message_count: number;
  is_idle?: boolean;
  is_unresponsive?: boolean;
  is_connected?: boolean;
  has_pending?: boolean;
  agent_status?: string;
  is_deferred?: boolean;
  is_pinned?: boolean;
  last_user_message?: string | null;
  idle_summary?: string | null;
  // The agent's pinned "where this stands" line (cast state) and its
  // provenance: when it was written, and the message count it was written at.
  thread_state?: string | null;
  thread_state_at?: number | null;
  thread_state_msg_count?: number | null;
  thread_state_status?: string | null;
  session_error?: string;
  author_name?: string | null;
  is_own?: boolean;
  icon?: string;
  icon_color?: string;
  is_favorite?: boolean;
  model?: string | null;
  inbox_stashed_at?: number | null;
  inbox_dismissed_at?: number | null;
  // Newest image in the session (server-denormalized) — the row thumbnail
  // when the inbox_image_thumbs pref is on.
  image_preview_url?: string | null;
  // Unacknowledged handoff: a teammate assigned this session to the current
  // user (see listInboxSessions enrichment). "Got it" acks it in place.
  assigned_ping?: { by_name: string; note?: string | null; at: number } | null;
};

/** "claude-opus-4-8" → "opus-4-8"; unknowns pass through. */
export function formatModelShort(model?: string | null): string | null {
  if (!model) return null;
  return model.replace(/^claude-/, "").replace(/-20\d{6}$/, "");
}

export function formatRelativeTime(timestamp: number): string {
  const now = Date.now();
  const diffMs = now - timestamp;
  const diffMinutes = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);
  if (diffMinutes < 1) return "just now";
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  const date = new Date(timestamp);
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function formatDuration(ms: number): string {
  if (ms < 60000) return "<1m";
  const minutes = Math.floor(ms / 60000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rem = minutes % 60;
  if (hours < 24) return rem > 0 ? `${hours}h ${rem}m` : `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export function cleanTitle(raw?: string): string {
  if (!raw) return 'Untitled';
  let t = raw.trim();
  const jsonMatch = t.match(/```(?:json)?\s*\{[\s\S]*?"title"\s*:\s*"([^"]+)"[\s\S]*?```/);
  if (jsonMatch) return jsonMatch[1];
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  try { const p = JSON.parse(t); if (p.title) return p.title; } catch {}
  return t || 'Untitled';
}

export function agentLabel(agentType: string): string {
  switch (agentType) {
    case "claude_code": return "Claude";
    case "codex": return "Codex";
    case "cursor": return "Cursor";
    case "gemini": return "Gemini";
    default: return "";
  }
}

const projectColors = [Theme.blue, Theme.cyan, Theme.violet, Theme.magenta, Theme.green, Theme.orange];

export function projectColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0;
  return projectColors[Math.abs(hash) % projectColors.length];
}

export function agentColor(agentType: string): string {
  switch (agentType) {
    case "claude_code": return Theme.orange;
    case "codex": return Theme.green;
    case "cursor": return Theme.violet;
    case "gemini": return Theme.blue;
    default: return Theme.textMuted0;
  }
}

export function statusColor(session: SessionData): string {
  if (session.session_error) return Theme.red;
  if (session.is_unresponsive) return Theme.orange;
  if (session.has_pending) return Theme.accent;
  if (session.agent_status === "working" || session.agent_status === "thinking") return Theme.greenBright;
  if (session.agent_status === "permission_blocked") return Theme.orange;
  if (session.is_idle) return Theme.textMuted0;
  if (session.is_connected) return Theme.greenBright;
  return Theme.textMuted0;
}

export function statusLabel(session: SessionData): string | null {
  if (session.session_error) return "error";
  if (session.agent_status === "working") return "working";
  if (session.agent_status === "thinking") return "thinking";
  if (session.agent_status === "permission_blocked") return "blocked";
  if (session.is_unresponsive) return "unresponsive";
  if (session.has_pending) return "pending";
  if (session.is_connected && !session.is_idle) return "active";
  return null;
}

export function projectName(conv: { git_root?: string | null; project_path?: string | null }): string | null {
  const path = conv.git_root || conv.project_path;
  if (!path) return null;
  return path.split('/').pop() || null;
}

export function PulsingDot({ color }: { color: string }) {
  const opacity = useRef(new RNAnimated.Value(1)).current;
  useEffect(() => {
    const animation = RNAnimated.loop(
      RNAnimated.sequence([
        RNAnimated.timing(opacity, { toValue: 0.3, duration: 800, useNativeDriver: true }),
        RNAnimated.timing(opacity, { toValue: 1, duration: 800, useNativeDriver: true }),
      ])
    );
    animation.start();
    return () => animation.stop();
  }, [opacity]);
  return <RNAnimated.View style={[styles.statusDot, { backgroundColor: color, opacity }]} />;
}

function StatusDot({ session }: { session: SessionData }) {
  const color = statusColor(session);
  const isAnimated = session.agent_status === "working" || session.agent_status === "thinking" || session.has_pending;
  if (isAnimated) return <PulsingDot color={color} />;
  return <RNView style={[styles.statusDot, { backgroundColor: color }]} />;
}

export function SessionItem({ session, onPress, onPin, onLongPress }: { session: SessionData; onPress: () => void; onPin?: () => void; onLongPress?: () => void }) {
  const project = projectName(session);
  const agent = agentLabel(session.agent_type ?? "");
  const durationMs = session.updated_at - (session.started_at ?? session.updated_at);
  const sColor = statusColor(session);
  const sLabel = statusLabel(session);
  const showAuthor = session.author_name && session.is_own === false;
  // Same preview filter as the web inbox cards: machine-delivered messages
  // (cast send, teammate broadcasts, scheduled tasks) and harness noise never
  // surface as "what the human said".
  const userMessage = cleanUserMessage(session.last_user_message);
  // The agent's pinned thread state, shared with the web card so both surfaces
  // agree on the headline and on when a state has gone stale. Read at render
  // rather than on a ticker: a row re-renders on every list update, and the
  // freshness only drives a colour.
  const stateView = threadStateView(session, session.message_count ?? 0, Date.now());
  // Row thumbnail for sessions that contain images — same pref as web
  // (inbox_image_thumbs, stamped LWW so the toggle follows the user).
  // Tapping it zooms the image in a modal instead of opening the session
  // (the nested Pressable wins the touch over the row's TouchableOpacity).
  const showImageThumb = useInboxStore((s) => s.clientState?.ui?.inbox_image_thumbs === true);
  const [thumbZoom, setThumbZoom] = useState(false);
  // Broken preview image → drop the slot, otherwise it reserves row width.
  const [thumbBroken, setThumbBroken] = useState(false);
  const thumbUrl = showImageThumb && !thumbBroken ? session.image_preview_url : null;
  const ackAssignment = useAckAssignment();
  // Handoff note starts clamped; tapping the pill body reveals the full reason.
  const [pingExpanded, setPingExpanded] = useState(false);

  return (
    <TouchableOpacity
      onPress={onPress}
      onLongPress={onLongPress ? () => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); onLongPress(); } : undefined}
      delayLongPress={400}
      style={[styles.conversationContent, thumbUrl ? styles.contentWithThumb : null]}
      activeOpacity={0.6}
    >
      <RNView style={thumbUrl ? styles.contentColumn : null}>
      <RNView style={styles.conversationHeader}>
        <RNView style={styles.titleRow}>
          <RNView style={styles.iconWithStatus}>
            <StatusDot session={session} />
          </RNView>
          {session.is_favorite && (
            <Feather name="star" size={11} color={Theme.accent} style={{ marginRight: 3 }} />
          )}
          <RNText style={styles.conversationTitle} numberOfLines={1}>
            {cleanTitle(session.title)}
          </RNText>
        </RNView>
        <RNView style={styles.rightMeta}>
          {sLabel && <RNText style={[styles.statusBadge, { color: sColor }]}>{sLabel}</RNText>}
          <RNText style={styles.timeText}>{formatRelativeTime(session.updated_at)}</RNText>
          {session.is_pinned && (
            <FontAwesome name="thumb-tack" size={10} color={Theme.magenta} />
          )}
        </RNView>
      </RNView>

      {session.assigned_ping && (
        // Mirror of the web card's handoff pill: who handed this over, their
        // note, and "Got it" to accept without opening the session. The nested
        // Pressable wins the touch over the row's TouchableOpacity.
        <RNView style={styles.assignedPingRow}>
          <FontAwesome name="user-plus" size={10} color={Theme.violet} style={{ marginTop: 3 }} />
          {/* The note is the REASON for the handoff — clamped for the list,
              tap the body to read all of it without opening the session. */}
          <Pressable
            style={{ flex: 1, minWidth: 0 }}
            onPress={session.assigned_ping.note ? () => setPingExpanded((v) => !v) : onPress}
          >
            <RNText style={styles.assignedPingTitle} numberOfLines={1}>
              {session.assigned_ping.by_name} assigned this to you
            </RNText>
            {session.assigned_ping.note ? (
              <RNText style={styles.assignedPingNote} numberOfLines={pingExpanded ? undefined : 2}>
                “{session.assigned_ping.note}”
              </RNText>
            ) : null}
          </Pressable>
          <Pressable
            onPress={() => {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              ackAssignment(session._id);
            }}
            hitSlop={8}
            style={styles.assignedPingAck}
          >
            <RNText style={styles.assignedPingAckText}>Got it</RNText>
          </Pressable>
        </RNView>
      )}

      {stateView ? (
        // The agent's pinned "where this stands" line (cast state) replaces the
        // generated summary — same rule as the web card. The pin marks it as
        // the agent's own account, and turns orange once the thread has run far
        // past the write, so a neglected line stops reading as current.
        <RNView style={styles.stateRow}>
          <FontAwesome
            name="thumb-tack"
            size={9}
            // The declared status owns the pin color (blocked = orange, done =
            // teal, working = green like the web card and the liveness pulse —
            // no yellow in the mobile theme); rows written before the status
            // existed keep the freshness rule.
            color={
              stateView.status === 'blocked' ? Theme.orange
                : stateView.status === 'done' ? Theme.cyan
                : stateView.status === 'working' ? Theme.green
                : stateView.freshness === 'fresh' ? Theme.cyan : Theme.orange
            }
            style={styles.statePin}
          />
          <RNText style={styles.stateText} numberOfLines={2}>
            {stateView.cardLine}
          </RNText>
        </RNView>
      ) : (session.idle_summary || session.subtitle) ? (
        <RNText style={styles.summaryText} numberOfLines={2}>
          {session.idle_summary || session.subtitle}
        </RNText>
      ) : null}

      {userMessage && (
        <RNText style={styles.userMessage} numberOfLines={1}>
          <RNText style={styles.userMessageCaret}>&gt; </RNText>
          {userMessage}
        </RNText>
      )}

      <RNView style={styles.conversationMeta}>
        {project && (
          <RNText style={[styles.projectBadge, { color: projectColor(project), backgroundColor: projectColor(project) + '28' }]} numberOfLines={1}>{project}</RNText>
        )}
        {showAuthor && (
          <RNText style={styles.authorText}>{session.author_name}</RNText>
        )}
        {agent ? (
          <RNText style={[styles.agentBadge, { color: agentColor(session.agent_type ?? "") }]}>{agent}</RNText>
        ) : null}
        {formatModelShort(session.model) && (
          <RNText style={styles.modelBadge} numberOfLines={1}>{formatModelShort(session.model)}</RNText>
        )}
        {session.message_count > 0 && (
          <RNText style={styles.messageCount}>{session.message_count} msgs</RNText>
        )}
      </RNView>
      </RNView>
      {thumbUrl && (
        <Pressable onPress={() => setThumbZoom(true)} hitSlop={6}>
          <Image source={{ uri: thumbUrl }} style={styles.imageThumb} resizeMode="cover" onError={() => setThumbBroken(true)} />
        </Pressable>
      )}
      {thumbZoom && thumbUrl && (
        <Modal visible transparent animationType="fade" onRequestClose={() => setThumbZoom(false)}>
          <Pressable style={styles.thumbZoomOverlay} onPress={() => setThumbZoom(false)}>
            <Image source={{ uri: thumbUrl }} style={styles.thumbZoomImage} resizeMode="contain" />
          </Pressable>
        </Modal>
      )}
    </TouchableOpacity>
  );
}

export function SwipeableSessionItem({ session, onPress, onDismiss, onPin, onLongPress }: {
  session: SessionData;
  onPress: () => void;
  onDismiss: () => void;
  onPin?: () => void;
  onLongPress?: () => void;
}) {
  const translateX = useRef(new RNAnimated.Value(0)).current;
  const didSwipe = useRef(false);

  // Keep the latest action callbacks reachable from the once-created responder.
  const cb = useRef({ onDismiss, onPin });
  cb.current = { onDismiss, onPin };

  const springBack = useCallback((after?: () => void) => {
    RNAnimated.spring(translateX, {
      toValue: 0,
      useNativeDriver: true,
      tension: 100,
      friction: 10,
    }).start(after ? () => after() : undefined);
  }, [translateX]);

  // Shared release logic for both gesture paths below. vx is px/s: a committed
  // drag (past the distance threshold) OR a flick (shorter drag at speed)
  // triggers the action; anything else springs back.
  const settle = useCallback((dx: number, vx: number) => {
    if (dx < -100 || (dx < -48 && vx < -800)) {
      // tactile confirm at the commit point — a destructive dismiss reads as
      // accidental without it.
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      RNAnimated.timing(translateX, {
        toValue: -400,
        duration: 200,
        useNativeDriver: true,
      }).start(() => cb.current.onDismiss());
    } else if ((dx > 80 || (dx > 48 && vx > 800)) && cb.current.onPin) {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      springBack(cb.current.onPin);
    } else {
      springBack();
    }
    requestAnimationFrame(() => { didSwipe.current = false; });
  }, [springBack, translateX]);

  // Gesture-handler pan with NATIVE arbitration. The previous JS PanResponder
  // raced the FlatList's native scroll recognizer and usually lost (the swipe
  // only triggered from a standstill, perfectly horizontal), and even when it
  // won, JS cannot cancel a native scroll — the list kept scrolling vertically
  // under the swipe. activeOffsetX/failOffsetY arbitrate on the native side:
  // 10px of horizontal travel claims the touch AND cancels the scroll
  // recognizer (scroll locks); 15px of vertical travel first fails the pan and
  // scrolling proceeds untouched. While undetermined (a stationary press)
  // gesture-handler does not consume touches, so the inner TouchableOpacity's
  // tap and long-press still fire; on activation it cancels them, so a swipe
  // cannot misfire a tap. Callbacks hop to the JS thread (runOnJS) because they
  // drive an RN Animated value — arbitration stays native regardless.
  const panGesture = useMemo(() => {
    if (!gestureHandler) return null;
    return gestureHandler.Gesture.Pan()
      .activeOffsetX([-10, 10])
      .failOffsetY([-15, 15])
      .onStart(() => { didSwipe.current = true; })
      .onUpdate((e: any) => translateX.setValue(e.translationX))
      .onEnd((e: any) => settle(e.translationX, e.velocityX))
      .onFinalize((_e: any, success: boolean) => {
        // Cancelled mid-swipe (e.g. a system gesture took over) — onEnd never
        // ran. Guarded on didSwipe so the finalize that follows every failed
        // non-swipe touch (taps, scrolls) doesn't spawn no-op springs.
        if (!success && didSwipe.current) {
          springBack();
          requestAnimationFrame(() => { didSwipe.current = false; });
        }
      })
      .runOnJS(true);
  }, [settle, springBack, translateX]);

  // Fallback for binaries whose native build lacks gesture-handler (see
  // lib/gestureHandler.tsx): the old JS PanResponder. Worse arbitration, but
  // the feature stays functional. PanResponder vx is px/ms; settle takes px/s.
  const responder = useRef(
    gestureHandler ? null : PanResponder.create({
      onMoveShouldSetPanResponder: (_e, gs) =>
        Math.abs(gs.dx) > 8 && Math.abs(gs.dx) > Math.abs(gs.dy) * 1.5,
      onPanResponderGrant: () => {
        didSwipe.current = true;
      },
      onPanResponderMove: (_e, gs) => {
        translateX.setValue(gs.dx);
      },
      onPanResponderRelease: (_e, gs) => settle(gs.dx, gs.vx * 1000),
      onPanResponderTerminate: () => {
        springBack();
        requestAnimationFrame(() => { didSwipe.current = false; });
      },
    })
  ).current;

  const swipeBehindOpacity = translateX.interpolate({
    inputRange: [-400, -1, 0, 1, 400],
    outputRange: [1, 1, 0, 0, 0],
  });
  const swipeBehindPinOpacity = translateX.interpolate({
    inputRange: [-400, -1, 0, 1, 400],
    outputRange: [0, 0, 0, 1, 1],
  });

  const card = (
    <RNAnimated.View
      style={[styles.conversationItem, { transform: [{ translateX }] }]}
      {...(responder ? responder.panHandlers : {})}
    >
      <SessionItem session={session} onPress={() => { if (!didSwipe.current) onPress(); }} onPin={onPin} onLongPress={onLongPress} />
    </RNAnimated.View>
  );

  return (
    <RNView style={styles.swipeContainer}>
      <RNAnimated.View style={[styles.swipeBehind, { opacity: swipeBehindOpacity }]}>
        <FontAwesome name="archive" size={16} color="#fff" />
        <RNText style={styles.swipeBehindText}>Stash</RNText>
      </RNAnimated.View>
      <RNAnimated.View style={[styles.swipeBehindPin, { opacity: swipeBehindPinOpacity }]}>
        <FontAwesome name="thumb-tack" size={16} color="#fff" />
        <RNText style={styles.swipeBehindText}>{session.is_pinned ? "Unpin" : "Pin"}</RNText>
      </RNAnimated.View>
      {panGesture ? (
        <gestureHandler.GestureDetector gesture={panGesture}>{card}</gestureHandler.GestureDetector>
      ) : card}
    </RNView>
  );
}

export const styles = StyleSheet.create({
  swipeContainer: {
    overflow: 'hidden',
  },
  // Stash is set-aside (agent keeps running) — orange, not destructive red.
  swipeBehind: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    right: 0,
    left: 0,
    backgroundColor: Theme.orange,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    paddingRight: 20,
    gap: 8,
  },
  swipeBehindPin: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    right: 0,
    left: 0,
    backgroundColor: Theme.magenta,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-start',
    paddingLeft: 20,
    gap: 8,
  },
  swipeBehindText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '600',
  },
  conversationItem: {
    backgroundColor: Theme.bg,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Theme.bgHighlight,
  },
  conversationContent: {
    paddingHorizontal: Spacing.lg,
    paddingVertical: 10,
  },
  // Thumb variant: content column + thumbnail side by side.
  contentWithThumb: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  contentColumn: {
    flex: 1,
    minWidth: 0,
  },
  imageThumb: {
    width: 38,
    height: 38,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Theme.bgHighlight,
  },
  thumbZoomOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.92)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  thumbZoomImage: {
    width: '100%',
    height: '85%',
  },
  conversationHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 3,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
    marginRight: Spacing.md,
  },
  iconWithStatus: {
    flexDirection: 'row',
    alignItems: 'center',
    marginRight: Spacing.sm,
  },
  statusDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  conversationTitle: {
    fontSize: 15,
    fontWeight: '500',
    color: Theme.text,
    flex: 1,
  },
  rightMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  statusBadge: {
    fontSize: 10,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.3,
  },
  projectBadge: {
    fontSize: 11,
    fontWeight: '600',
    maxWidth: 130,
    letterSpacing: 0.2,
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 6,
    overflow: 'hidden',
    marginRight: 2,
  },
  timeText: {
    fontSize: 11,
    color: Theme.textMuted0,
    fontWeight: '400',
  },
  // msgs count is sol-orange on web's inbox cards — the one loud meta value.
  messageCount: {
    fontSize: 11,
    color: Theme.orange,
    fontVariant: ['tabular-nums'],
    fontWeight: '400',
  },
  modelBadge: {
    fontSize: 10,
    color: Theme.textDim,
    fontWeight: '500',
    letterSpacing: 0.2,
    maxWidth: 90,
  },
  userMessage: {
    fontSize: 13,
    color: Theme.blue,
    fontWeight: '600',
    marginLeft: 14,
    marginBottom: 2,
    lineHeight: 18,
  },
  userMessageCaret: {
    color: Theme.blue,
    opacity: 0.5,
  },
  summaryText: {
    fontSize: 12,
    color: Theme.textMuted,
    marginLeft: 14,
    marginBottom: 2,
    lineHeight: 17,
  },
  stateRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginLeft: 14,
    marginBottom: 2,
    gap: 5,
  },
  // Violet like the web card: cyan is the active/selection treatment there, and
  // the handoff motif stays one color across platforms.
  assignedPingRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 6,
    marginLeft: 14,
    marginBottom: 4,
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderRadius: 8,
    backgroundColor: Theme.violet + '22',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Theme.violet + '55',
  },
  assignedPingTitle: {
    fontSize: 12,
    fontWeight: '600',
    color: Theme.violet,
    lineHeight: 16,
  },
  assignedPingNote: {
    fontSize: 11,
    color: Theme.textMuted,
    lineHeight: 15,
  },
  assignedPingAck: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    backgroundColor: Theme.violet + '33',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Theme.violet + '66',
  },
  assignedPingAckText: {
    fontSize: 11,
    fontWeight: '600',
    color: Theme.violet,
  },
  statePin: {
    marginTop: 3,
  },
  stateText: {
    flex: 1,
    fontSize: 12,
    color: Theme.textSecondary,
    lineHeight: 17,
  },
  conversationMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    marginLeft: 14,
    marginTop: 2,
    gap: 6,
  },
  authorText: {
    fontSize: 12,
    color: Theme.cyan,
    fontWeight: '600',
  },
  agentBadge: {
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 0.2,
  },
  metaText: {
    fontSize: 12,
    color: Theme.textMuted,
  },
  projectText: {
    fontSize: 12,
    color: Theme.textMuted,
    maxWidth: 100,
  },
  metaSeparator: {
    color: Theme.textMuted0,
    marginHorizontal: 4,
    fontSize: 12,
  },
});
