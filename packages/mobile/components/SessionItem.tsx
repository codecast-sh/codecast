import { StyleSheet, TouchableOpacity, View as RNView, Text as RNText, Animated as RNAnimated } from 'react-native';
import { useRef, useCallback, useEffect } from 'react';
import FontAwesome from '@expo/vector-icons/FontAwesome';
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
};

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
    <TouchableOpacity onPress={onPress} onLongPress={onLongPress} delayLongPress={400} style={styles.conversationContent} activeOpacity={0.6}>
      <RNView style={styles.conversationHeader}>
        <RNView style={styles.titleRow}>
          <StatusDot session={session} />
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
  const panStartX = useRef(0);
  const dismissed = useRef(false);

  const handleTouchStart = useCallback((e: any) => {
    panStartX.current = e.nativeEvent.pageX;
    dismissed.current = false;
  }, []);

  const handleTouchMove = useCallback((e: any) => {
    const dx = e.nativeEvent.pageX - panStartX.current;
    if (dx < 0) translateX.setValue(dx);
    if (dx > 0) translateX.setValue(dx);
  }, [translateX]);

  const handleTouchEnd = useCallback(() => {
    const currentValue = (translateX as any).__getValue();
    if (currentValue < -100) {
      dismissed.current = true;
      RNAnimated.timing(translateX, {
        toValue: -400,
        duration: 200,
        useNativeDriver: true,
      }).start(() => onDismiss());
    } else if (currentValue > 80 && onPin) {
      RNAnimated.spring(translateX, {
        toValue: 0,
        useNativeDriver: true,
        tension: 100,
        friction: 10,
      }).start(() => onPin());
    } else {
      RNAnimated.spring(translateX, {
        toValue: 0,
        useNativeDriver: true,
        tension: 100,
        friction: 10,
      }).start();
    }
  }, [translateX, onDismiss, onPin]);

  return (
    <RNView style={styles.swipeContainer}>
      <RNView style={styles.swipeBehind}>
        <FontAwesome name="archive" size={16} color="#fff" />
        <RNText style={styles.swipeBehindText}>Dismiss</RNText>
      </RNView>
      <RNView style={styles.swipeBehindPin}>
        <FontAwesome name="thumb-tack" size={16} color="#fff" />
        <RNText style={styles.swipeBehindText}>{session.is_pinned ? "Unpin" : "Pin"}</RNText>
      </RNView>
      <RNAnimated.View
        style={[styles.conversationItem, { transform: [{ translateX }] }]}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
      >
        <SessionItem session={session} onPress={onPress} onPin={onPin} onLongPress={onLongPress} />
      </RNAnimated.View>
    </RNView>
  );
}

export const styles = StyleSheet.create({
  swipeContainer: {
    overflow: 'hidden',
  },
  swipeBehind: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    right: 0,
    left: 0,
    backgroundColor: Theme.red,
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
  statusDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    marginRight: Spacing.sm,
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
  userMessage: {
    fontSize: 13,
    color: Theme.blue,
    fontWeight: '600',
    marginLeft: 15,
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
    marginLeft: 15,
    marginBottom: 2,
    lineHeight: 17,
  },
  conversationMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    marginLeft: 15,
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
