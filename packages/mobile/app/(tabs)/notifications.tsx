import { StyleSheet, FlatList, RefreshControl, TouchableOpacity, View as RNView, Text as RNText } from 'react-native';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import { useQuery } from 'convex/react';
import { api } from '@codecast/convex/convex/_generated/api';
import { useState } from 'react';
import { useRouter } from 'expo-router';
import type { Id } from '@codecast/convex/convex/_generated/dataModel';
import { Theme, Spacing } from '@/constants/Theme';

type Comment = {
  _id: Id<"comments">;
  conversation_id: Id<"conversations">;
  user_id: Id<"users">;
  content: string;
  created_at: number;
};

type CommentWithUser = Comment & {
  user_name?: string;
  user_email?: string;
  conversation_title?: string;
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

type NotificationItemProps = {
  comment: CommentWithUser;
  onPress: () => void;
};

function NotificationItem({ comment, onPress }: NotificationItemProps) {
  const userName = comment.user_name || comment.user_email?.split('@')[0] || "Unknown";
  const conversationTitle = comment.conversation_title || "Untitled conversation";

  return (
    <TouchableOpacity onPress={onPress} style={styles.notificationCard} activeOpacity={0.7}>
      <RNView style={styles.notificationAvatar}>
        <RNText style={styles.notificationAvatarText}>
          {userName[0]?.toUpperCase() || "?"}
        </RNText>
      </RNView>
      <RNView style={styles.notificationContent}>
        <RNView style={styles.notificationHeader}>
          <RNText style={styles.notificationUserName}>{userName}</RNText>
          <RNText style={styles.notificationTime}>
            {formatRelativeTime(comment.created_at)}
          </RNText>
        </RNView>
        <RNText style={styles.notificationContext} numberOfLines={1}>
          commented on {conversationTitle}
        </RNText>
        <RNText style={styles.notificationText} numberOfLines={2}>
          {comment.content}
        </RNText>
      </RNView>
    </TouchableOpacity>
  );
}

export default function NotificationsScreen() {
  const [refreshing, setRefreshing] = useState(false);
  const router = useRouter();

  const currentUser = useQuery(api.users.getCurrentUser);
  const myConversations = useQuery(
    api.conversations.listConversations,
    currentUser ? { filter: "my", limit: 100 } : "skip"
  );

  const onRefresh = async () => {
    setRefreshing(true);
    setTimeout(() => setRefreshing(false), 1000);
  };

  const conversationIds = myConversations?.conversations.map((c: any) => c._id) || [];

  const renderItem = ({ item }: { item: CommentWithUser }) => (
    <NotificationItem
      comment={item}
      onPress={() => router.push(`/session/${item.conversation_id}`)}
    />
  );

  const renderEmpty = () => (
    <RNView style={styles.emptyContainer}>
      <RNView style={styles.emptyIcon}>
        <FontAwesome name="bell-o" size={28} color={Theme.textMuted0} />
      </RNView>
      <RNText style={styles.emptyTitle}>No notifications</RNText>
      <RNText style={styles.emptyText}>
        Comments on your conversations{'\n'}will appear here.
      </RNText>
    </RNView>
  );

  return (
    <RNView style={styles.container}>
      <FlatList
        data={[]}
        renderItem={renderItem}
        keyExtractor={(item) => item._id}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={Theme.textMuted}
          />
        }
        ListEmptyComponent={renderEmpty}
        contentContainerStyle={styles.emptyList}
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
  notificationCard: {
    flexDirection: 'row',
    padding: Spacing.lg,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Theme.bgHighlight,
    backgroundColor: Theme.bg,
  },
  notificationAvatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: Theme.bgHighlight,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: Spacing.md,
  },
  notificationAvatarText: {
    fontSize: 16,
    fontWeight: '600',
    color: Theme.text,
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
  notificationUserName: {
    fontSize: 15,
    fontWeight: '600',
    color: Theme.text,
  },
  notificationTime: {
    fontSize: 12,
    color: Theme.textMuted0,
  },
  notificationContext: {
    fontSize: 13,
    color: Theme.textMuted,
    marginBottom: 4,
  },
  notificationText: {
    fontSize: 14,
    color: Theme.textSecondary,
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
