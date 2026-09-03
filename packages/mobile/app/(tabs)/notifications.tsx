import { StyleSheet, SectionList, RefreshControl, TouchableOpacity, View as RNView, Image, ScrollView } from 'react-native';
import { Text as RNText } from '@/components/Themed';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import * as Haptics from 'expo-haptics';
import { useQuery, useMutation } from 'convex/react';
import { api } from '@codecast/convex/convex/_generated/api';
import { useLayoutEffect, useMemo, useState } from 'react';
import { useNavigation, useRouter } from 'expo-router';
import type { Id } from '@codecast/convex/convex/_generated/dataModel';
import { Theme, Spacing } from '@/constants/Theme';
import { NotificationListSkeleton } from '@/components/SkeletonLoader';
import { AgentLogoSvg } from '@/components/AgentLogo';
import { openLink } from '@/lib/links';
import { CODECAST_BASE_URL } from '@codecast/shared/entities';
import { cleanNotificationBody } from '@codecast/web/lib/notificationText';
import {
  agentNames,
  sessionLabel,
  sessionTypes,
  socialTypes,
  taskTypes,
  typeColors,
  typeLabels,
} from '@codecast/web/lib/notificationTypes';

type Notification = {
  _id: Id<"notifications">;
  type: string;
  message: string;
  read: boolean;
  created_at: number;
  conversation_id?: Id<"conversations">;
  entity_type?: "task" | "doc" | "plan" | "conversation" | "artifact" | "chat_channel" | "device";
  entity_id?: string;
  chat_message_id?: string;
  link?: string;
  // Anonymous actors (artifact page commenters) carry identity on the row.
  actor_name?: string;
  actor_avatar?: string;
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
  const diffMinutes = Math.floor((now - timestamp) / 60000);
  const diffHours = Math.floor(diffMinutes / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffMinutes < 1) return "just now";
  if (diffMinutes < 60) return `${diffMinutes}m`;
  if (diffHours < 24) return `${diffHours}h`;
  if (diffDays < 7) return `${diffDays}d`;
  return new Date(timestamp).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

// The shared type→color map speaks Tailwind classes; translate to Theme tokens
// so both platforms color a type from the same source of truth.
const classToTheme: Record<string, string> = {
  "text-sol-green": Theme.green,
  "text-red-400": Theme.red,
  "text-sol-orange": Theme.orange,
  "text-sol-blue": Theme.blue,
  "text-sol-cyan": Theme.cyan,
  "text-sol-violet": Theme.violet,
  "text-sol-yellow": Theme.accent,
};

function typeColorNative(type: string): string {
  return classToTheme[typeColors[type] ?? ""] ?? Theme.textMuted;
}

function notificationIcon(type: string): { name: React.ComponentProps<typeof FontAwesome>['name']; color: string } {
  switch (type) {
    case "mention": return { name: "at", color: Theme.blue };
    case "comment_reply": return { name: "reply", color: Theme.violet };
    case "conversation_comment": return { name: "comment", color: Theme.accent };
    case "team_invite": return { name: "users", color: Theme.greenBright };
    case "session_idle": return { name: "check", color: Theme.green };
    case "permission_request": return { name: "shield", color: Theme.orange };
    case "session_error": return { name: "exclamation-triangle", color: Theme.red };
    case "team_session_start": return { name: "play-circle", color: Theme.blue };
    case "task_completed": return { name: "check-circle", color: Theme.greenBright };
    case "task_failed": return { name: "exclamation-circle", color: Theme.red };
    case "task_assigned": return { name: "user-plus", color: Theme.accent };
    case "task_commented":
    case "doc_commented": return { name: "comment-o", color: Theme.cyan };
    case "doc_updated": return { name: "file-text-o", color: Theme.violet };
    case "plan_status_changed":
    case "plan_task_completed": return { name: "list-ol", color: Theme.green };
    case "artifact_commented": return { name: "globe", color: Theme.cyan };
    case "chat_mention": return { name: "at", color: Theme.blue };
    case "chat_reply": return { name: "comments", color: Theme.accent };
    case "chat_here": return { name: "bullhorn", color: Theme.orange };
    case "chat_post": return { name: "hashtag", color: Theme.cyan };
    case "daemon_overloaded": return { name: "hourglass-half", color: Theme.orange };
    default: return { name: "bell", color: Theme.textMuted };
  }
}

function typeLabel(type: string): string {
  return typeLabels[type] || type.replace(/_/g, " ");
}

function NotificationItem({ notification, onPress, onMarkRead }: {
  notification: Notification;
  onPress: () => void;
  onMarkRead: () => void;
}) {
  const icon = notificationIcon(notification.type);
  const actorName = notification.actor?.name || notification.actor?.github_username || notification.actor_name;
  const avatarUrl = notification.actor?.github_avatar_url || notification.actor_avatar;
  const agentType = notification.conversation?.agent_type || "claude_code";
  const isSessionNotif = sessionTypes.has(notification.type) || notification.type === "team_session_start";
  const label = sessionLabel(notification.conversation);

  // The title is what the notification is about — the session, else the person.
  // The event itself is a small colored word, never the headline.
  const typeLbl = typeLabel(notification.type);
  const title = label || actorName || typeLbl;
  const who = actorName || (isSessionNotif ? (agentNames[agentType] || agentType) : null);
  const showWho = !!who && who !== title;
  // Don't echo the type when it already IS the title (a bare task/plan row with
  // no session or actor to name).
  const showType = title !== typeLbl;

  return (
    <TouchableOpacity
      onPress={onPress}
      onLongPress={() => {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
        onMarkRead();
      }}
      style={[styles.notificationCard, !notification.read && styles.notificationUnread]}
      activeOpacity={0.7}
    >
      {!notification.read && <RNView style={styles.unreadBar} />}
      <RNView style={styles.avatarContainer}>
        {avatarUrl ? (
          <Image source={{ uri: avatarUrl }} style={styles.avatar} />
        ) : isSessionNotif ? (
          <AgentLogoSvg agentType={agentType} size={38} />
        ) : (
          <RNView style={styles.avatarFallback}>
            <FontAwesome name={icon.name} size={16} color={icon.color} />
          </RNView>
        )}
        {(avatarUrl || isSessionNotif) && (
          <RNView style={[styles.iconBadge, { backgroundColor: icon.color }]}>
            <FontAwesome name={icon.name} size={8} color="#fff" />
          </RNView>
        )}
      </RNView>
      <RNView style={styles.notificationContent}>
        <RNView style={styles.notificationHeader}>
          <RNText
            style={[styles.notificationTitle, notification.read && styles.notificationTitleRead]}
            numberOfLines={1}
          >
            {title}
          </RNText>
          <RNText style={styles.notificationTime}>
            {formatRelativeTime(notification.created_at)}
          </RNText>
          {!notification.read && <RNView style={styles.unreadDot} />}
        </RNView>
        {(showWho || showType) && (
          <RNView style={styles.metaRow}>
            {showWho && (
              <RNText style={styles.metaWho} numberOfLines={1}>{who}</RNText>
            )}
            {showType && (
              <RNText style={[styles.metaType, { color: typeColorNative(notification.type) }]} numberOfLines={1}>
                {typeLbl}
              </RNText>
            )}
          </RNView>
        )}
        <RNText style={styles.notificationMessage} numberOfLines={3}>
          {cleanNotificationBody(notification.message, 200)}
        </RNText>
      </RNView>
    </TouchableOpacity>
  );
}

type FilterTab = "all" | "unread" | "sessions" | "tasks" | "social";

function matchesTab(n: Notification, tab: FilterTab): boolean {
  if (tab === "unread") return !n.read;
  if (tab === "sessions") return sessionTypes.has(n.type) || n.type === "team_session_start";
  if (tab === "tasks") return taskTypes.has(n.type);
  if (tab === "social") return socialTypes.has(n.type);
  return true;
}

function sectionTitle(ts: number, startOfToday: number): string {
  if (ts >= startOfToday) return "Today";
  if (ts >= startOfToday - 86400000) return "Yesterday";
  if (ts >= startOfToday - 6 * 86400000) return "This week";
  return "Earlier";
}

export default function NotificationsScreen() {
  const [refreshing, setRefreshing] = useState(false);
  const [activeTab, setActiveTab] = useState<FilterTab>("all");
  const router = useRouter();
  const navigation = useNavigation();

  const notifications = useQuery(api.notifications.list) as Notification[] | undefined;
  const markAsRead = useMutation(api.notifications.markAsRead);
  const markAllAsRead = useMutation(api.notifications.markAllAsRead);

  const unreadCount = useMemo(
    () => (notifications ?? []).filter((n) => !n.read).length,
    [notifications]
  );

  // "Read all" lives in the nav header, so the filter row is free for tabs.
  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: () =>
        unreadCount > 0 ? (
          <TouchableOpacity onPress={() => markAllAsRead({})} activeOpacity={0.7} style={styles.headerAction}>
            <RNText style={styles.headerActionText}>Read all</RNText>
          </TouchableOpacity>
        ) : null,
    });
  }, [navigation, unreadCount, markAllAsRead]);

  const sections = useMemo(() => {
    const filtered = (notifications ?? []).filter((n) => matchesTab(n, activeTab));
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const out: { title: string; data: Notification[] }[] = [];
    for (const n of filtered) {
      const title = sectionTitle(n.created_at, startOfToday);
      const last = out[out.length - 1];
      if (last && last.title === title) last.data.push(n);
      else out.push({ title, data: [n] });
    }
    return out;
  }, [notifications, activeTab]);

  const onRefresh = async () => {
    // The list is a live Convex subscription; the gesture just acknowledges.
    setRefreshing(true);
    setTimeout(() => setRefreshing(false), 400);
  };

  const handlePress = (notification: Notification) => {
    // Fire mark-as-read best-effort; don't block navigation on the round-trip.
    if (!notification.read) {
      markAsRead({ notificationId: notification._id }).catch(() => {});
    }
    // A deep link wins (artifact comments open the published page).
    if (notification.link) {
      void openLink(notification.link);
      return;
    }
    // A machine has no screen in the app. The daemon's overload alert opens the
    // devices roster on the web, which is where a person can act on it, and
    // matches where the same notification lands on web.
    if (notification.entity_type === "device") {
      void openLink(`${CODECAST_BASE_URL}/settings/devices`);
      return;
    }
    if (notification.entity_type && notification.entity_id && notification.entity_type !== "conversation") {
      const routes: Record<string, string> = { task: "/task/", doc: "/doc/", plan: "/plan/", chat_channel: "/chat/" };
      const base = routes[notification.entity_type];
      if (base) {
        // A chat notification names the exact message; the screen scrolls to it.
        const suffix = notification.entity_type === "chat_channel" && notification.chat_message_id
          ? `?m=${notification.chat_message_id}`
          : "";
        router.push(`${base}${notification.entity_id}${suffix}` as any);
        return;
      }
    }
    if (notification.conversation_id) {
      router.push(`/session/${notification.conversation_id}`);
    }
  };

  const handleMarkRead = (notification: Notification) => {
    if (!notification.read) {
      markAsRead({ notificationId: notification._id }).catch(() => {});
    }
  };

  const tabs: { key: FilterTab; label: string }[] = [
    { key: "all", label: "All" },
    { key: "unread", label: unreadCount > 0 ? `Unread (${unreadCount})` : "Unread" },
    { key: "sessions", label: "Sessions" },
    { key: "tasks", label: "Tasks" },
    { key: "social", label: "Social" },
  ];

  const renderEmpty = () => (
    <RNView style={styles.emptyContainer}>
      <RNView style={styles.emptyIcon}>
        <FontAwesome name="bell-o" size={28} color={Theme.textMuted0} />
      </RNView>
      <RNText style={styles.emptyTitle}>
        {activeTab === "all" ? "No notifications" : `No ${activeTab === "unread" ? "unread" : activeTab} notifications`}
      </RNText>
      <RNText style={styles.emptyText}>
        Session updates, mentions, comments,{'\n'}and task activity will appear here.
      </RNText>
    </RNView>
  );

  return (
    <RNView style={styles.container}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.filterBar}
        contentContainerStyle={styles.tabsRow}
      >
        {tabs.map((tab) => (
          <TouchableOpacity
            key={tab.key}
            onPress={() => setActiveTab(tab.key)}
            style={[styles.tab, activeTab === tab.key && styles.tabActive]}
            activeOpacity={0.7}
          >
            <RNText style={[styles.tabText, activeTab === tab.key && styles.tabTextActive]}>
              {tab.label}
            </RNText>
          </TouchableOpacity>
        ))}
      </ScrollView>
      <SectionList
        sections={sections}
        renderItem={({ item }) => (
          <NotificationItem
            notification={item}
            onPress={() => handlePress(item)}
            onMarkRead={() => handleMarkRead(item)}
          />
        )}
        renderSectionHeader={({ section }) => (
          <RNView style={styles.sectionHeader}>
            <RNText style={styles.sectionHeaderText}>{section.title}</RNText>
          </RNView>
        )}
        keyExtractor={(item) => item._id}
        stickySectionHeadersEnabled={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={Theme.textMuted}
          />
        }
        ListEmptyComponent={notifications === undefined ? <NotificationListSkeleton /> : renderEmpty()}
        contentContainerStyle={sections.length === 0 ? styles.emptyList : styles.listContent}
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
  filterBar: {
    flexGrow: 0,
    flexShrink: 0,
    backgroundColor: Theme.bg,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Theme.borderLight,
  },
  tabsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.xs,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
  },
  tab: {
    paddingHorizontal: Spacing.md,
    paddingVertical: 6,
    borderRadius: 14,
  },
  tabActive: {
    backgroundColor: Theme.bgHighlight,
  },
  tabText: {
    fontSize: 13,
    color: Theme.textMuted,
  },
  tabTextActive: {
    color: Theme.text,
    fontWeight: '600',
  },
  headerAction: {
    paddingHorizontal: Spacing.md,
    paddingVertical: 6,
  },
  headerActionText: {
    fontSize: 14,
    color: Theme.accent,
    fontWeight: '600',
  },
  sectionHeader: {
    paddingHorizontal: Spacing.md,
    paddingTop: Spacing.lg,
    paddingBottom: Spacing.xs,
    backgroundColor: Theme.bg,
  },
  sectionHeaderText: {
    fontSize: 12,
    fontWeight: '600',
    color: Theme.textMuted0,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  listContent: {
    paddingBottom: Spacing.xl,
  },
  notificationCard: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingHorizontal: Spacing.md,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Theme.bgHighlight,
    backgroundColor: Theme.bg,
  },
  notificationUnread: {
    backgroundColor: `${Theme.accent}0d`,
  },
  unreadBar: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    width: 3,
    backgroundColor: Theme.accent,
  },
  avatarContainer: {
    width: 38,
    height: 38,
    marginRight: Spacing.md,
    marginTop: 2,
  },
  avatar: {
    width: 38,
    height: 38,
    borderRadius: 19,
  },
  avatarFallback: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: Theme.bgAlt,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconBadge: {
    position: 'absolute',
    bottom: -2,
    right: -2,
    width: 16,
    height: 16,
    borderRadius: 8,
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
    alignItems: 'center',
    marginBottom: 1,
  },
  notificationTitle: {
    fontSize: 15,
    fontWeight: '600',
    color: Theme.text,
    flex: 1,
    marginRight: Spacing.sm,
  },
  notificationTitleRead: {
    fontWeight: '500',
    color: Theme.textMuted,
  },
  notificationTime: {
    fontSize: 12,
    color: Theme.textMuted0,
  },
  unreadDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: Theme.accent,
    marginLeft: 6,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 3,
  },
  metaWho: {
    fontSize: 12,
    color: Theme.textMuted,
    fontWeight: '600',
    marginRight: 6,
  },
  metaType: {
    fontSize: 12,
    flexShrink: 1,
  },
  notificationMessage: {
    fontSize: 14,
    color: Theme.textMuted,
    lineHeight: 20,
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
