import { StyleSheet, FlatList, RefreshControl, TouchableOpacity, View as RNView, Text as RNText, Image } from 'react-native';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import { useQuery, useMutation } from 'convex/react';
import { api } from '@codecast/convex/convex/_generated/api';
import { useState } from 'react';
import { useRouter } from 'expo-router';
import type { Id } from '@codecast/convex/convex/_generated/dataModel';
import { Theme, Spacing } from '@/constants/Theme';

type Notification = {
  _id: Id<"notifications">;
  type: "mention" | "comment_reply" | "conversation_comment" | "team_invite" | "session_idle" | "permission_request" | "session_error" | "team_session_start" | "task_completed" | "task_failed";
  message: string;
  read: boolean;
  created_at: number;
  conversation_id?: Id<"conversations">;
  actor: {
    _id: Id<"users">;
    name?: string;
    github_username?: string;
    github_avatar_url?: string;
  } | null;
  conversation: {
    title?: string;
    project_path?: string;
    agent_type?: string;
  } | null;
};

function formatRelativeTime(timestamp: number): string {
  const now = Date.now();
  const diffMs = now - timestamp;
  const diffMinutes = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMinutes < 1) return "just now";
  if (diffMinutes < 60) return `${diffMinutes}m`;
  if (diffHours < 24) return `${diffHours}h`;
  if (diffDays < 7) return `${diffDays}d`;

  const date = new Date(timestamp);
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function notificationIcon(type: string): { name: React.ComponentProps<typeof FontAwesome>['name']; color: string } {
  switch (type) {
    case "mention": return { name: "at", color: Theme.blue };
    case "comment_reply": return { name: "reply", color: Theme.violet };
    case "conversation_comment": return { name: "comment", color: Theme.accent };
    case "team_invite": return { name: "users", color: Theme.greenBright };
    case "session_idle": return { name: "pause", color: Theme.accent };
    case "permission_request": return { name: "shield", color: "#f59e0b" };
    case "session_error": return { name: "exclamation-triangle", color: Theme.red };
    case "team_session_start": return { name: "play-circle", color: Theme.blue };
    case "task_completed": return { name: "check-circle", color: Theme.greenBright };
    case "task_failed": return { name: "exclamation-circle", color: Theme.red };
    default: return { name: "bell", color: Theme.textMuted };
  }
}

function agentTypeLabel(type?: string) {
  switch (type) {
    case "claude_code": return "Claude Code";
    case "codex": return "Codex";
    case "cursor": return "Cursor";
    case "gemini": return "Gemini";
    default: return null;
  }
}

function NotificationItem({ notification, onPress, onMarkRead }: {
  notification: Notification;
  onPress: () => void;
  onMarkRead: () => void;
}) {
  const selfTypes = ["session_idle", "permission_request", "session_error", "task_completed", "task_failed"];
  const isSelf = selfTypes.includes(notification.type);
  const actorName = isSelf
    ? (notification.type === "session_idle" ? "Claude done"
      : notification.type === "permission_request" ? "Permission needed"
      : notification.type === "task_completed" ? "Task completed"
      : notification.type === "task_failed" ? "Task failed"
      : "Session error")
    : (notification.actor?.name || notification.actor?.github_username || "Someone");
  const icon = notificationIcon(notification.type);
  const avatarUrl = notification.actor?.github_avatar_url;
  const conv = notification.conversation;
  const contextLine = conv?.title
    || conv?.project_path?.split("/").pop()
    || null;
  const agentLabel = agentTypeLabel(conv?.agent_type);

  return (
    <TouchableOpacity
      onPress={onPress}
      style={[styles.notificationCard, !notification.read && styles.notificationUnread]}
      activeOpacity={0.7}
    >
      <RNView style={styles.avatarContainer}>
        {avatarUrl ? (
          <Image source={{ uri: avatarUrl }} style={styles.avatar} />
        ) : (
          <RNView style={styles.avatarFallback}>
            <FontAwesome name={icon.name} size={18} color={icon.color} />
          </RNView>
        )}
        {avatarUrl && (
          <RNView style={[styles.iconBadge, { backgroundColor: icon.color }]}>
            <FontAwesome name={icon.name} size={8} color="#fff" />
          </RNView>
        )}
      </RNView>
      <RNView style={styles.notificationContent}>
        <RNView style={styles.notificationHeader}>
          <RNText style={styles.notificationActorName} numberOfLines={1}>{actorName}</RNText>
          <RNText style={styles.notificationTime}>
            {formatRelativeTime(notification.created_at)}
          </RNText>
        </RNView>
        {contextLine && (
          <RNView style={styles.contextRow}>
            {agentLabel && (
              <RNText style={styles.agentBadge}>{agentLabel}</RNText>
            )}
            <RNText style={styles.contextText} numberOfLines={1}>{contextLine}</RNText>
          </RNView>
        )}
        <RNText style={styles.notificationMessage} numberOfLines={6}>
          {notification.message}
        </RNText>
      </RNView>
      {!notification.read && (
        <RNView style={styles.unreadDot} />
      )}
    </TouchableOpacity>
  );
}

export default function NotificationsScreen() {
  const [refreshing, setRefreshing] = useState(false);
  const router = useRouter();

  const notifications = useQuery(api.notifications.list) as Notification[] | undefined;
  const unreadCount = useQuery(api.notifications.getUnreadCount);
  const markAsRead = useMutation(api.notifications.markAsRead);
  const markAllAsRead = useMutation(api.notifications.markAllAsRead);

  const onRefresh = async () => {
    setRefreshing(true);
    setTimeout(() => setRefreshing(false), 1000);
  };

  const handlePress = async (notification: Notification) => {
    if (!notification.read) {
      await markAsRead({ notificationId: notification._id });
    }
    if (notification.conversation_id) {
      router.push(`/session/${notification.conversation_id}`);
    }
  };

  const handleMarkRead = async (notification: Notification) => {
    if (!notification.read) {
      await markAsRead({ notificationId: notification._id });
    }
  };

  const renderItem = ({ item }: { item: Notification }) => (
    <NotificationItem
      notification={item}
      onPress={() => handlePress(item)}
      onMarkRead={() => handleMarkRead(item)}
    />
  );

  const renderEmpty = () => (
    <RNView style={styles.emptyContainer}>
      <RNView style={styles.emptyIcon}>
        <FontAwesome name="bell-o" size={28} color={Theme.textMuted0} />
      </RNView>
      <RNText style={styles.emptyTitle}>No notifications</RNText>
      <RNText style={styles.emptyText}>
        Mentions, comments, and team invites{'\n'}will appear here.
      </RNText>
    </RNView>
  );

  const hasUnread = (unreadCount ?? 0) > 0;

  return (
    <RNView style={styles.container}>
      {hasUnread && (
        <TouchableOpacity
          style={styles.markAllButton}
          onPress={() => markAllAsRead({})}
          activeOpacity={0.7}
        >
          <RNText style={styles.markAllText}>Mark all as read</RNText>
        </TouchableOpacity>
      )}
      <FlatList
        data={notifications ?? []}
        renderItem={renderItem}
        keyExtractor={(item) => item._id}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={Theme.textMuted}
          />
        }
        ListEmptyComponent={notifications === undefined ? null : renderEmpty}
        contentContainerStyle={(notifications?.length ?? 0) === 0 ? styles.emptyList : styles.listContent}
        showsVerticalScrollIndicator={false}
      />
    </RNView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Theme.bg,
  },
  markAllButton: {
    backgroundColor: Theme.bgAlt,
    paddingVertical: 10,
    paddingHorizontal: Spacing.lg,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Theme.borderLight,
    alignItems: 'flex-end',
  },
  markAllText: {
    fontSize: 13,
    color: Theme.accent,
    fontWeight: '600',
  },
  listContent: {
    paddingBottom: Spacing.xl,
  },
  notificationCard: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingHorizontal: Spacing.md,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Theme.bgHighlight,
    backgroundColor: Theme.bg,
  },
  notificationUnread: {
    backgroundColor: `${Theme.accent}08`,
  },
  avatarContainer: {
    width: 42,
    height: 42,
    marginRight: Spacing.md,
    marginTop: 2,
  },
  avatar: {
    width: 42,
    height: 42,
    borderRadius: 21,
  },
  avatarFallback: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: Theme.bgAlt,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconBadge: {
    position: 'absolute',
    bottom: -2,
    right: -2,
    width: 18,
    height: 18,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: Theme.bg,
  },
  notificationContent: {
    flex: 1,
  },
  notificationHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 2,
  },
  notificationActorName: {
    fontSize: 15,
    fontWeight: '600',
    color: Theme.text,
    flex: 1,
    marginRight: Spacing.sm,
  },
  notificationTime: {
    fontSize: 12,
    color: Theme.textMuted0,
  },
  contextRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 4,
  },
  agentBadge: {
    fontSize: 11,
    color: Theme.accent,
    fontWeight: '600',
    marginRight: 6,
  },
  contextText: {
    fontSize: 12,
    color: Theme.textMuted0,
    flex: 1,
  },
  notificationMessage: {
    fontSize: 14,
    color: Theme.textMuted,
    lineHeight: 20,
  },
  unreadDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: Theme.accent,
    marginLeft: Spacing.sm,
    marginTop: 6,
  },
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: Spacing.xxxl,
  },
  emptyIcon: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: Theme.bgAlt,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: Spacing.lg,
  },
  emptyTitle: {
    fontSize: 17,
    fontWeight: '600',
    color: Theme.text,
    marginBottom: Spacing.sm,
  },
  emptyText: {
    fontSize: 15,
    color: Theme.textMuted,
    textAlign: 'center',
    lineHeight: 22,
  },
  emptyList: {
    flex: 1,
  },
});
