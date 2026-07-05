import { StyleSheet, TouchableOpacity, View as RNView, Text as RNText, Animated as RNAnimated, PanResponder } from 'react-native';
import { useRef, useCallback, useEffect } from 'react';
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
  session_error?: string;
  author_name?: string | null;
  is_own?: boolean;
  icon?: string;
  icon_color?: string;
  is_favorite?: boolean;
  model?: string | null;
  inbox_stashed_at?: number | null;
  inbox_dismissed_at?: number | null;
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

function PulsingDot({ color }: { color: string }) {
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

  return (
    <TouchableOpacity
      onPress={onPress}
      onLongPress={onLongPress ? () => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); onLongPress(); } : undefined}
      delayLongPress={400}
      style={styles.conversationContent}
      activeOpacity={0.6}
    >
      <RNView style={styles.conversationHeader}>
        <RNView style={styles.titleRow}>
          <RNView style={styles.iconWithStatus}>
            <StatusDot session={session} />
          </RNView>
          {session.is_favorite && (
            <Feather name="star" size={11} color={Theme.accent} style={{ marginRight: 3 }} />
          )}
          {session.is_pinned && (
            <FontAwesome name="thumb-tack" size={10} color={Theme.magenta} style={{ marginRight: 4 }} />
          )}
          <RNText style={[styles.conversationTitle, session.is_pinned && { color: Theme.magenta }]} numberOfLines={1}>
            {cleanTitle(session.title)}
          </RNText>
        </RNView>
        <RNView style={styles.rightMeta}>
          {sLabel && <RNText style={[styles.statusBadge, { color: sColor }]}>{sLabel}</RNText>}
          <RNText style={styles.timeText}>{formatRelativeTime(session.updated_at)}</RNText>
        </RNView>
      </RNView>

      {session.last_user_message && (
        <RNText style={styles.userMessage} numberOfLines={1}>
          <RNText style={styles.userMessageCaret}>&gt; </RNText>
          {session.last_user_message}
        </RNText>
      )}

      {(session.idle_summary || session.subtitle) && (
        <RNText style={styles.summaryText} numberOfLines={2}>
          {session.idle_summary || session.subtitle}
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

  // PanResponder (RN core — NOT gesture-handler) is what fixes the "vertical
  // scroll moves during a horizontal swipe" bug without breaking tap/long-press.
  // onMoveShouldSetPanResponder claims the touch ONLY once the finger has moved
  // clearly horizontally; at that moment the parent ScrollView yields the
  // responder, so it can't scroll. A vertical drag is never claimed (scrolling is
  // untouched), and a stationary press/tap is never claimed (the inner
  // TouchableOpacity still fires onPress/onLongPress). A gesture-handler pan, by
  // contrast, holds the gesture undetermined during a hold and starves long-press.
  const responder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_e, gs) =>
        Math.abs(gs.dx) > 8 && Math.abs(gs.dx) > Math.abs(gs.dy) * 1.5,
      onPanResponderGrant: () => {
        didSwipe.current = true;
      },
      onPanResponderMove: (_e, gs) => {
        translateX.setValue(gs.dx);
      },
      onPanResponderRelease: (_e, gs) => {
        if (gs.dx < -100) {
          // tactile confirm at the commit point — a destructive dismiss reads as
          // accidental without it.
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
          RNAnimated.timing(translateX, {
            toValue: -400,
            duration: 200,
            useNativeDriver: true,
          }).start(() => cb.current.onDismiss());
        } else if (gs.dx > 80 && cb.current.onPin) {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
          springBack(cb.current.onPin);
        } else {
          springBack();
        }
        requestAnimationFrame(() => { didSwipe.current = false; });
      },
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
      <RNAnimated.View
        style={[styles.conversationItem, { transform: [{ translateX }] }]}
        {...responder.panHandlers}
      >
        <SessionItem session={session} onPress={() => { if (!didSwipe.current) onPress(); }} onPin={onPin} onLongPress={onLongPress} />
      </RNAnimated.View>
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
    letterSpacing: -0.2,
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
  messageCount: {
    fontSize: 11,
    color: Theme.textMuted0,
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
