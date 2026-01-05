import { StyleSheet, FlatList, RefreshControl, TouchableOpacity, View as RNView, Text as RNText } from 'react-native';
import { useQuery } from 'convex/react';
import { api } from '@codecast/convex/convex/_generated/api';
import { useState } from 'react';
import { useRouter } from 'expo-router';
import { Theme, Spacing, FontSize, BorderRadius } from '@/constants/Theme';

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
  if (diffMinutes < 60) return `${diffMinutes}m`;
  if (diffHours < 24) return `${diffHours}h`;
  if (diffDays < 7) return `${diffDays}d`;

  const date = new Date(timestamp);
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

type ConversationItemProps = {
  conversation: Conversation;
  onPress: () => void;
};

function ConversationItem({ conversation, onPress }: ConversationItemProps) {
  return (
    <TouchableOpacity
      onPress={onPress}
      style={styles.conversationItem}
      activeOpacity={0.6}
    >
      <RNView style={styles.conversationContent}>
        <RNView style={styles.conversationHeader}>
          <RNView style={styles.titleRow}>
            <RNView style={conversation.is_active ? styles.activeDot : styles.inactiveDot} />
            <RNText style={styles.conversationTitle} numberOfLines={1}>
              {conversation.title}
            </RNText>
          </RNView>
          <RNText style={styles.messageCount}>
            {conversation.message_count}
          </RNText>
        </RNView>

        <RNView style={styles.conversationMeta}>
          <RNText style={styles.metaText}>
            {formatRelativeTime(conversation.updated_at)}
          </RNText>
          {!conversation.is_own && (
            <>
              <RNText style={styles.metaSeparator}>·</RNText>
              <RNText style={styles.authorText}>{conversation.author_name}</RNText>
            </>
          )}
        </RNView>
      </RNView>
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
    <RNView style={styles.emptyContainer}>
      <RNText style={styles.emptyText}>
        {filter === "my"
          ? "No conversations yet.\nYour synced sessions will appear here."
          : "No team conversations yet.\nInvite team members to start sharing."}
      </RNText>
    </RNView>
  );

  return (
    <RNView style={styles.container}>
      <RNView style={styles.tabs}>
        <TouchableOpacity
          style={[styles.tab, filter === "my" && styles.tabActive]}
          onPress={() => setFilter("my")}
          activeOpacity={0.7}
        >
          <RNText style={[styles.tabText, filter === "my" && styles.tabTextActive]}>
            Sessions
          </RNText>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.tab, filter === "team" && styles.tabActive]}
          onPress={() => setFilter("team")}
          activeOpacity={0.7}
        >
          <RNText style={[styles.tabText, filter === "team" && styles.tabTextActive]}>
            Team
          </RNText>
        </TouchableOpacity>
      </RNView>

      <FlatList
        data={conversations}
        renderItem={renderItem}
        keyExtractor={(item) => item._id}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={Theme.textMuted}
          />
        }
        ListEmptyComponent={result === undefined ? null : renderEmpty}
        contentContainerStyle={conversations.length === 0 ? styles.emptyList : styles.listContent}
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
  tabs: {
    flexDirection: 'row',
    backgroundColor: Theme.bgAlt,
    borderBottomWidth: 1,
    borderBottomColor: Theme.borderLight,
  },
  tab: {
    flex: 1,
    paddingVertical: 14,
    alignItems: 'center',
    borderBottomWidth: 2,
    borderBottomColor: 'transparent',
  },
  tabActive: {
    borderBottomColor: Theme.text,
  },
  tabText: {
    fontSize: 15,
    color: Theme.textMuted,
    fontWeight: '500',
  },
  tabTextActive: {
    color: Theme.text,
    fontWeight: '600',
  },
  listContent: {
    paddingBottom: Spacing.xl,
  },
  conversationItem: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Theme.bgHighlight,
    backgroundColor: Theme.bg,
  },
  conversationContent: {
    paddingHorizontal: Spacing.lg,
    paddingVertical: 14,
  },
  conversationHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 6,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
    marginRight: Spacing.md,
  },
  activeDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: Theme.greenBright,
    marginRight: Spacing.sm,
  },
  inactiveDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: 'transparent',
    marginRight: Spacing.sm,
  },
  conversationTitle: {
    fontSize: 15,
    fontWeight: '500',
    color: Theme.text,
    flex: 1,
    letterSpacing: -0.2,
  },
  messageCount: {
    fontSize: 11,
    color: Theme.textMuted0,
    fontVariant: ['tabular-nums'],
    fontWeight: '400',
  },
  conversationMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    marginLeft: 14,
  },
  metaText: {
    fontSize: 13,
    color: Theme.textDim,
  },
  authorText: {
    fontSize: 13,
    color: Theme.textMuted,
  },
  metaSeparator: {
    color: Theme.textMuted0,
    marginHorizontal: 6,
    fontSize: 13,
  },
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: Spacing.xxxl,
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
