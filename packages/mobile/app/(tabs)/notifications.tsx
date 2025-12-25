import { StyleSheet, FlatList, RefreshControl, TouchableOpacity } from 'react-native';
import { Text, View } from '@/components/Themed';
import { useQuery } from 'convex/react';
import { api } from '@codecast/convex/convex/_generated/api';
import { useState } from 'react';
import { useRouter } from 'expo-router';
import type { Id } from '@codecast/convex/convex/_generated/dataModel';

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
  if (diffMinutes === 1) return "1 min ago";
  if (diffMinutes < 60) return `${diffMinutes} min ago`;
  if (diffHours === 1) return "1 hr ago";
  if (diffHours < 24) return `${diffHours} hr ago`;
  if (diffDays === 1) return "yesterday";

  const date = new Date(timestamp);
  const thisYear = new Date().getFullYear();
  if (date.getFullYear() === thisYear) {
    return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  }
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

type NotificationItemProps = {
  comment: CommentWithUser;
  onPress: () => void;
};

function NotificationItem({ comment, onPress }: NotificationItemProps) {
  const userName = comment.user_name || comment.user_email || "Unknown";
  const conversationTitle = comment.conversation_title || "Untitled conversation";

  return (
    <TouchableOpacity onPress={onPress} style={styles.notificationCard}>
      <View style={styles.notificationHeader}>
        <View style={styles.notificationAvatar}>
          <Text style={styles.notificationAvatarText}>
            {userName[0]?.toUpperCase() || "?"}
          </Text>
        </View>
        <View style={styles.notificationContent}>
          <View style={styles.notificationMeta}>
            <Text style={styles.notificationUserName}>{userName}</Text>
            <Text style={styles.notificationTime}>
              {formatRelativeTime(comment.created_at)}
            </Text>
          </View>
          <Text style={styles.notificationConversation} numberOfLines={1}>
            commented on {conversationTitle}
          </Text>
          <Text style={styles.notificationText} numberOfLines={2}>
            {comment.content}
          </Text>
        </View>
      </View>
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
    <View style={styles.emptyContainer}>
      <Text style={styles.emptyText}>
        No notifications yet.{'\n'}Comments on your conversations will appear here.
      </Text>
    </View>
  );

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Notifications</Text>
      </View>
      <FlatList
        data={[]}
        renderItem={renderItem}
        keyExtractor={(item) => item._id}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
        }
        ListEmptyComponent={renderEmpty}
        contentContainerStyle={styles.emptyList}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    paddingHorizontal: 16,
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#333',
  },
  headerTitle: {
    fontSize: 20,
    fontWeight: 'bold',
    color: '#fff',
  },
  notificationCard: {
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#222',
    backgroundColor: '#1a1a1a',
  },
  notificationHeader: {
    flexDirection: 'row',
  },
  notificationAvatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#333',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  notificationAvatarText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#fff',
  },
  notificationContent: {
    flex: 1,
  },
  notificationMeta: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },
  notificationUserName: {
    fontSize: 14,
    fontWeight: '600',
    color: '#fff',
  },
  notificationTime: {
    fontSize: 12,
    color: '#666',
  },
  notificationConversation: {
    fontSize: 13,
    color: '#888',
    marginBottom: 4,
  },
  notificationText: {
    fontSize: 14,
    color: '#ddd',
    lineHeight: 20,
  },
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 32,
  },
  emptyText: {
    fontSize: 16,
    color: '#888',
    textAlign: 'center',
    lineHeight: 24,
  },
  emptyList: {
    flex: 1,
  },
});
