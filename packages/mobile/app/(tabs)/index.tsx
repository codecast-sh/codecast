import { StyleSheet, FlatList, RefreshControl, TouchableOpacity, Dimensions } from 'react-native';
import { Text, View } from '@/components/Themed';
import { useQuery } from 'convex/react';
import { api } from '@codecast/convex/convex/_generated/api';
import { useState } from 'react';
import { useRouter } from 'expo-router';

type Conversation = {
  _id: string;
  title: string;
  subtitle?: string | null;
  started_at: number;
  updated_at: number;
  message_count: number;
  is_active: boolean;
  author_name: string;
  is_own: boolean;
  agent_type: string;
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

type ConversationItemProps = {
  conversation: Conversation;
  onPress: () => void;
};

function ConversationItem({ conversation, onPress }: ConversationItemProps) {
  return (
    <TouchableOpacity onPress={onPress} style={styles.conversationItem}>
      <View style={styles.conversationHeader}>
        <Text style={styles.conversationTitle} numberOfLines={1}>
          {conversation.title}
        </Text>
        {conversation.is_active && (
          <View style={styles.activeBadge}>
            <Text style={styles.activeBadgeText}>ACTIVE</Text>
          </View>
        )}
      </View>

      <View style={styles.conversationMeta}>
        <Text style={styles.metaText}>
          {formatRelativeTime(conversation.updated_at)}
        </Text>
        <Text style={styles.metaSeparator}>•</Text>
        <Text style={styles.metaText}>
          {conversation.message_count} msg{conversation.message_count !== 1 ? 's' : ''}
        </Text>
        {!conversation.is_own && (
          <>
            <Text style={styles.metaSeparator}>•</Text>
            <Text style={styles.metaText}>{conversation.author_name}</Text>
          </>
        )}
      </View>
    </TouchableOpacity>
  );
}

export default function SessionsScreen() {
  const [filter, setFilter] = useState<"my" | "team">("my");
  const [refreshing, setRefreshing] = useState(false);
  const router = useRouter();

  const result = useQuery(api.conversations.listConversations, {
    filter,
    limit: 100,
  });

  const conversations = result?.conversations || [];

  const onRefresh = async () => {
    setRefreshing(true);
    setTimeout(() => setRefreshing(false), 1000);
  };

  const renderItem = ({ item }: { item: Conversation }) => (
    <ConversationItem
      conversation={item}
      onPress={() => router.push(`/session/${item._id}`)}
    />
  );

  const renderEmpty = () => (
    <View style={styles.emptyContainer}>
      <Text style={styles.emptyText}>
        {filter === "my"
          ? "No conversations yet.\nYour synced sessions will appear here."
          : "No team conversations yet.\nInvite team members to start sharing."}
      </Text>
    </View>
  );

  return (
    <View style={styles.container}>
      <View style={styles.tabs}>
        <TouchableOpacity
          style={[styles.tab, filter === "my" && styles.tabActive]}
          onPress={() => setFilter("my")}
        >
          <Text style={[styles.tabText, filter === "my" && styles.tabTextActive]}>
            My Sessions
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.tab, filter === "team" && styles.tabActive]}
          onPress={() => setFilter("team")}
        >
          <Text style={[styles.tabText, filter === "team" && styles.tabTextActive]}>
            Team
          </Text>
        </TouchableOpacity>
      </View>

      <FlatList
        data={conversations}
        renderItem={renderItem}
        keyExtractor={(item) => item._id}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
        }
        ListEmptyComponent={result === undefined ? null : renderEmpty}
        contentContainerStyle={conversations.length === 0 ? styles.emptyList : undefined}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  tabs: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: '#333',
  },
  tab: {
    flex: 1,
    paddingVertical: 16,
    alignItems: 'center',
  },
  tabActive: {
    borderBottomWidth: 2,
    borderBottomColor: '#fff',
  },
  tabText: {
    fontSize: 16,
    color: '#888',
  },
  tabTextActive: {
    color: '#fff',
    fontWeight: '600',
  },
  conversationItem: {
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#222',
  },
  conversationHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 8,
  },
  conversationTitle: {
    fontSize: 16,
    fontWeight: '500',
    flex: 1,
  },
  activeBadge: {
    backgroundColor: '#10b981',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 4,
    marginLeft: 8,
  },
  activeBadgeText: {
    color: '#fff',
    fontSize: 10,
    fontWeight: '700',
  },
  conversationMeta: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  metaText: {
    fontSize: 13,
    color: '#888',
  },
  metaSeparator: {
    color: '#666',
    marginHorizontal: 6,
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
