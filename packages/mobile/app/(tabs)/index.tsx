import { StyleSheet, FlatList, RefreshControl, TouchableOpacity, TextInput, View as RNView, Text as RNText, SectionList } from 'react-native';
import { useQuery, useMutation } from 'convex/react';
import { api } from '@codecast/convex/convex/_generated/api';
import { useState, useCallback, useRef, useMemo } from 'react';
import { useRouter } from 'expo-router';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import { Theme, Spacing } from '@/constants/Theme';
import type { Id } from '@codecast/convex/convex/_generated/dataModel';

type Conversation = {
  _id: string;
  title?: string;
  subtitle?: string | null;
  started_at: number;
  updated_at: number;
  duration_ms?: number;
  message_count?: number;
  is_active: boolean;
  author_name: string;
  is_own: boolean;
  agent_type?: string;
  project_path?: string | null;
};

type SearchResult = {
  conversationId: string;
  title: string;
  matches: Array<{
    messageId: string;
    content: string;
    role: string;
    timestamp: number;
  }>;
  updatedAt: number;
  authorName: string;
  isOwn: boolean;
  messageCount: number;
};

type FavoriteConversation = {
  _id: string;
  title?: string;
  updated_at: number;
  message_count: number;
  agent_type: string;
};

function formatRelativeTime(timestamp: number): string {
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

function formatDuration(ms: number): string {
  if (ms < 60000) return "<1m";
  const minutes = Math.floor(ms / 60000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours < 24) return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

function agentLabel(agentType: string): string {
  switch (agentType) {
    case "claude_code": return "Claude";
    case "codex": return "Codex";
    case "cursor": return "Cursor";
    case "gemini": return "Gemini";
    default: return "";
  }
}

function agentColor(agentType: string): string {
  switch (agentType) {
    case "claude_code": return Theme.orange;
    case "codex": return Theme.green;
    case "cursor": return Theme.violet;
    case "gemini": return Theme.blue;
    default: return Theme.textMuted0;
  }
}

function durationColor(ms: number): string {
  const minutes = ms / 60000;
  if (minutes < 5) return Theme.textMuted0;
  if (minutes < 20) return Theme.textMuted;
  if (minutes < 60) return Theme.orange;
  if (minutes < 120) return Theme.accent;
  return Theme.red;
}

function projectName(path?: string): string | null {
  if (!path) return null;
  const parts = path.split('/');
  return parts[parts.length - 1] || null;
}

function ConversationItem({ conversation, onPress, onLongPress }: {
  conversation: Conversation;
  onPress: () => void;
  onLongPress?: () => void;
}) {
  const project = projectName(conversation.project_path ?? undefined);
  const agent = agentLabel(conversation.agent_type ?? "");
  const durationMs = conversation.duration_ms ?? (conversation.updated_at - conversation.started_at);
  const dColor = durationColor(durationMs);

  return (
    <TouchableOpacity
      onPress={onPress}
      onLongPress={onLongPress}
      style={styles.conversationItem}
      activeOpacity={0.6}
    >
      <RNView style={styles.conversationContent}>
        <RNView style={styles.conversationHeader}>
          <RNView style={styles.titleRow}>
            <RNView style={conversation.is_active ? styles.activeDot : styles.inactiveDot} />
            <RNText style={styles.conversationTitle} numberOfLines={1}>
              {conversation.title || 'Untitled'}
            </RNText>
          </RNView>
          <RNView style={styles.rightMeta}>
            <RNText style={styles.messageCount}>
              {conversation.message_count ?? 0}
            </RNText>
          </RNView>
        </RNView>

        {conversation.subtitle && (
          <RNText style={styles.conversationSubtitle} numberOfLines={2}>
            {conversation.subtitle}
          </RNText>
        )}

        <RNView style={styles.conversationMeta}>
          {agent ? (
            <>
              <RNText style={[styles.agentBadge, { color: agentColor(conversation.agent_type ?? "") }]}>
                {agent}
              </RNText>
              <RNText style={styles.metaSeparator}>·</RNText>
            </>
          ) : null}
          <RNText style={styles.metaText}>
            {formatRelativeTime(conversation.updated_at)}
          </RNText>
          {durationMs > 60000 && (
            <>
              <RNText style={styles.metaSeparator}>·</RNText>
              <RNView style={styles.durationInline}>
                <FontAwesome name="clock-o" size={11} color={dColor} />
                <RNText style={[styles.durationInlineText, { color: dColor }]}>
                  {formatDuration(durationMs)}
                </RNText>
              </RNView>
            </>
          )}
          {project && (
            <>
              <RNText style={styles.metaSeparator}>·</RNText>
              <RNText style={styles.projectText} numberOfLines={1}>{project}</RNText>
            </>
          )}
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

function FavoriteItem({ item, onPress }: { item: FavoriteConversation; onPress: () => void }) {
  return (
    <TouchableOpacity onPress={onPress} style={styles.favoriteChip} activeOpacity={0.7}>
      <FontAwesome name="star" size={10} color={Theme.accent} style={{ marginRight: 5 }} />
      <RNText style={styles.favoriteChipText} numberOfLines={1}>
        {item.title || 'Untitled'}
      </RNText>
    </TouchableOpacity>
  );
}

function SearchResultItem({ result, onPress }: { result: SearchResult; onPress: () => void }) {
  const firstMatch = result.matches[0];
  return (
    <TouchableOpacity onPress={onPress} style={styles.searchResultItem} activeOpacity={0.6}>
      <RNView style={styles.searchResultHeader}>
        <RNText style={styles.searchResultTitle} numberOfLines={1}>{result.title}</RNText>
        <RNText style={styles.searchResultCount}>{result.matches.length} match{result.matches.length !== 1 ? 'es' : ''}</RNText>
      </RNView>
      {firstMatch && (
        <RNText style={styles.searchResultSnippet} numberOfLines={2}>
          {firstMatch.content}
        </RNText>
      )}
      <RNView style={styles.searchResultMeta}>
        <RNText style={styles.metaText}>{formatRelativeTime(result.updatedAt)}</RNText>
        <RNText style={styles.metaSeparator}>·</RNText>
        <RNText style={styles.metaText}>{result.messageCount} msgs</RNText>
        {!result.isOwn && (
          <>
            <RNText style={styles.metaSeparator}>·</RNText>
            <RNText style={styles.authorText}>{result.authorName}</RNText>
          </>
        )}
      </RNView>
    </TouchableOpacity>
  );
}

export default function SessionsScreen() {
  const [filter, setFilter] = useState<"my" | "team">("my");
  const [refreshing, setRefreshing] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [showFavorites, setShowFavorites] = useState(true);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const router = useRouter();

  const isSearching = debouncedQuery.length >= 2;

  const result = useQuery(api.conversations.listConversations, {
    filter,
    limit: 12,
  });

  const searchResults = useQuery(
    api.conversations.searchConversations,
    isSearching ? { query: debouncedQuery, limit: 20 } : "skip"
  );

  const favorites = useQuery(api.conversations.listFavorites);
  const toggleFavorite = useMutation(api.conversations.toggleFavorite);

  const conversations = result?.conversations || [];
  const hasFavorites = favorites && favorites.length > 0;

  const handleSearchChange = useCallback((text: string) => {
    setSearchQuery(text);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setDebouncedQuery(text.trim());
    }, 300);
  }, []);

  const clearSearch = useCallback(() => {
    setSearchQuery('');
    setDebouncedQuery('');
  }, []);

  const handleLongPress = useCallback(async (conversationId: string) => {
    try {
      await toggleFavorite({ conversation_id: conversationId as Id<"conversations"> });
    } catch {}
  }, [toggleFavorite]);

  const onRefresh = async () => {
    setRefreshing(true);
    setTimeout(() => setRefreshing(false), 1000);
  };

  const renderSearchResults = () => {
    if (!searchResults) return null;
    const results = 'results' in searchResults ? searchResults.results : [];
    if (results.length === 0) {
      return (
        <RNView style={styles.emptyContainer}>
          <RNText style={styles.emptyText}>No results for "{debouncedQuery}"</RNText>
        </RNView>
      );
    }
    return (
      <FlatList
        data={results}
        renderItem={({ item }) => (
          <SearchResultItem
            result={item}
            onPress={() => router.push(`/session/${item.conversationId}`)}
          />
        )}
        keyExtractor={(item) => item.conversationId}
        contentContainerStyle={styles.listContent}
        showsVerticalScrollIndicator={false}
      />
    );
  };

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
      <RNView style={styles.searchContainer}>
        <RNView style={styles.searchInputRow}>
          <FontAwesome name="search" size={14} color={Theme.textMuted0} style={styles.searchIcon} />
          <TextInput
            style={styles.searchInput}
            value={searchQuery}
            onChangeText={handleSearchChange}
            placeholder="Search sessions..."
            placeholderTextColor={Theme.textMuted0}
            returnKeyType="search"
            autoCorrect={false}
            autoCapitalize="none"
          />
          {searchQuery.length > 0 && (
            <TouchableOpacity onPress={clearSearch} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
              <FontAwesome name="times-circle" size={16} color={Theme.textMuted0} />
            </TouchableOpacity>
          )}
        </RNView>
      </RNView>

      {isSearching ? (
        renderSearchResults()
      ) : (
        <>
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
            renderItem={({ item }) => (
              <ConversationItem
                conversation={item}
                onPress={() => router.push(`/session/${item._id}`)}
                onLongPress={() => handleLongPress(item._id)}
              />
            )}
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
        </>
      )}
    </RNView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Theme.bg,
  },
  searchContainer: {
    backgroundColor: Theme.bgAlt,
    paddingHorizontal: Spacing.md,
    paddingTop: Spacing.sm,
    paddingBottom: Spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Theme.borderLight,
  },
  searchInputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Theme.bg,
    borderRadius: 10,
    paddingHorizontal: Spacing.md,
    height: 38,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Theme.borderLight,
  },
  searchIcon: {
    marginRight: Spacing.sm,
  },
  searchInput: {
    flex: 1,
    fontSize: 15,
    color: Theme.text,
    paddingVertical: 0,
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
  favoritesSection: {
    backgroundColor: Theme.bgAlt,
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Theme.bgHighlight,
  },
  favoritesHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: Spacing.sm,
    gap: 6,
  },
  favoritesTitle: {
    fontSize: 12,
    fontWeight: '600',
    color: Theme.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  favoritesRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  favoriteChip: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Theme.bg,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Theme.borderLight,
    maxWidth: 180,
  },
  favoriteChipText: {
    fontSize: 13,
    color: Theme.text,
    fontWeight: '500',
    flexShrink: 1,
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
    paddingVertical: 10,
  },
  conversationHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 4,
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
  conversationSubtitle: {
    fontSize: 13,
    color: Theme.textMuted,
    marginLeft: 14,
    marginBottom: 4,
    lineHeight: 18,
  },
  messageCount: {
    fontSize: 11,
    color: Theme.textMuted0,
    fontVariant: ['tabular-nums'],
    fontWeight: '400',
  },
  rightMeta: {
    alignItems: 'flex-end',
    justifyContent: 'center',
    gap: 2,
    marginLeft: Spacing.sm,
  },
  durationText: {
    fontSize: 10,
    color: Theme.textMuted0,
    fontVariant: ['tabular-nums'],
    fontWeight: '400',
  },
  durationInline: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
  },
  durationInlineText: {
    fontSize: 13,
    fontFamily: "SpaceMono",
    fontWeight: "600",
    fontVariant: ["tabular-nums"],
  },
  conversationMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    marginLeft: 14,
  },
  agentBadge: {
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 0.2,
  },
  metaText: {
    fontSize: 13,
    color: Theme.textDim,
  },
  projectText: {
    fontSize: 13,
    color: Theme.textMuted,
    maxWidth: 100,
  },
  authorText: {
    fontSize: 13,
    color: Theme.textMuted,
  },
  metaSeparator: {
    color: Theme.textMuted0,
    marginHorizontal: 5,
    fontSize: 13,
  },
  searchResultItem: {
    paddingHorizontal: Spacing.lg,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Theme.bgHighlight,
    backgroundColor: Theme.bg,
  },
  searchResultHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },
  searchResultTitle: {
    fontSize: 15,
    fontWeight: '500',
    color: Theme.text,
    flex: 1,
    marginRight: Spacing.sm,
  },
  searchResultCount: {
    fontSize: 11,
    color: Theme.accent,
    fontWeight: '600',
  },
  searchResultSnippet: {
    fontSize: 13,
    color: Theme.textMuted,
    lineHeight: 18,
    marginBottom: 6,
  },
  searchResultMeta: {
    flexDirection: 'row',
    alignItems: 'center',
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
