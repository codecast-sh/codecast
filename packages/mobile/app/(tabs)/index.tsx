import { StyleSheet, FlatList, RefreshControl, TouchableOpacity, TextInput, View as RNView, Text as RNText, SectionList, Modal, Alert, ScrollView, KeyboardAvoidingView, Platform } from 'react-native';
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

type AgentType = "claude" | "codex" | "gemini";

function NewSessionModal({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const [agentType, setAgentType] = useState<AgentType>("claude");
  const [projectPath, setProjectPath] = useState("");
  const [prompt, setPrompt] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const startSession = useMutation(api.users.startSession);
  const recentProjects = useQuery(api.users.getRecentProjectPaths, { limit: 6 });

  const handleSubmit = async () => {
    setSubmitting(true);
    try {
      await startSession({
        agent_type: agentType,
        project_path: projectPath || undefined,
        prompt: prompt || undefined,
      });
      Alert.alert("Session started", `${agentType} session is launching on your machine.`);
      onClose();
      setPrompt("");
      setProjectPath("");
    } catch (err) {
      Alert.alert("Error", err instanceof Error ? err.message : "Failed to start session");
    } finally {
      setSubmitting(false);
    }
  };

  const agents: { type: AgentType; label: string; color: string }[] = [
    { type: "claude", label: "Claude", color: Theme.orange },
    { type: "codex", label: "Codex", color: Theme.green },
    { type: "gemini", label: "Gemini", color: Theme.blue },
  ];

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <KeyboardAvoidingView style={modalStyles.container} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <RNView style={modalStyles.header}>
          <RNText style={modalStyles.title}>New Session</RNText>
          <TouchableOpacity onPress={onClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
            <FontAwesome name="times" size={20} color={Theme.textMuted} />
          </TouchableOpacity>
        </RNView>

        <ScrollView style={modalStyles.body} keyboardShouldPersistTaps="handled">
          <RNText style={modalStyles.label}>Agent</RNText>
          <RNView style={modalStyles.agentRow}>
            {agents.map((a) => (
              <TouchableOpacity
                key={a.type}
                style={[modalStyles.agentBtn, agentType === a.type && { borderColor: a.color, backgroundColor: a.color + "20" }]}
                onPress={() => setAgentType(a.type)}
                activeOpacity={0.7}
              >
                <RNText style={[modalStyles.agentBtnText, agentType === a.type && { color: a.color }]}>
                  {a.label}
                </RNText>
              </TouchableOpacity>
            ))}
          </RNView>

          <RNText style={modalStyles.label}>Project directory</RNText>
          <TextInput
            style={modalStyles.input}
            value={projectPath}
            onChangeText={setProjectPath}
            placeholder="~/src/my-project"
            placeholderTextColor={Theme.textMuted0}
            autoCorrect={false}
            autoCapitalize="none"
          />
          {recentProjects && recentProjects.length > 0 && !projectPath && (
            <RNView style={modalStyles.recentRow}>
              {recentProjects.slice(0, 4).map((p) => (
                <TouchableOpacity
                  key={p.path}
                  style={modalStyles.recentChip}
                  onPress={() => setProjectPath(p.path)}
                  activeOpacity={0.7}
                >
                  <RNText style={modalStyles.recentChipText} numberOfLines={1}>
                    {p.path.split("/").pop()}
                  </RNText>
                </TouchableOpacity>
              ))}
            </RNView>
          )}

          <RNText style={modalStyles.label}>Initial prompt (optional)</RNText>
          <TextInput
            style={[modalStyles.input, { height: 80, textAlignVertical: "top" }]}
            value={prompt}
            onChangeText={setPrompt}
            placeholder="What should the agent work on?"
            placeholderTextColor={Theme.textMuted0}
            multiline
            autoCorrect={false}
          />
        </ScrollView>

        <RNView style={modalStyles.footer}>
          <TouchableOpacity style={modalStyles.cancelBtn} onPress={onClose} activeOpacity={0.7}>
            <RNText style={modalStyles.cancelBtnText}>Cancel</RNText>
          </TouchableOpacity>
          <TouchableOpacity
            style={[modalStyles.submitBtn, submitting && { opacity: 0.5 }]}
            onPress={handleSubmit}
            disabled={submitting}
            activeOpacity={0.7}
          >
            <RNText style={modalStyles.submitBtnText}>{submitting ? "Starting..." : "Start Session"}</RNText>
          </TouchableOpacity>
        </RNView>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const modalStyles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Theme.bg },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: Spacing.lg,
    paddingTop: Spacing.lg,
    paddingBottom: Spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Theme.borderLight,
  },
  title: { fontSize: 18, fontWeight: "600", color: Theme.text },
  body: { flex: 1, paddingHorizontal: Spacing.lg, paddingTop: Spacing.md },
  label: { fontSize: 13, fontWeight: "600", color: Theme.textMuted, marginBottom: 6, marginTop: Spacing.md },
  agentRow: { flexDirection: "row", gap: 10 },
  agentBtn: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1.5,
    borderColor: Theme.borderLight,
    alignItems: "center",
  },
  agentBtnText: { fontSize: 14, fontWeight: "600", color: Theme.textMuted },
  input: {
    backgroundColor: Theme.bgAlt,
    borderRadius: 10,
    paddingHorizontal: Spacing.md,
    paddingVertical: 10,
    fontSize: 15,
    color: Theme.text,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Theme.borderLight,
  },
  recentRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 8 },
  recentChip: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 8,
    backgroundColor: Theme.bgAlt,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Theme.borderLight,
    maxWidth: 140,
  },
  recentChipText: { fontSize: 12, color: Theme.textMuted, fontWeight: "500" },
  footer: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: 10,
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Theme.borderLight,
  },
  cancelBtn: { paddingHorizontal: 16, paddingVertical: 10 },
  cancelBtnText: { fontSize: 15, color: Theme.textMuted },
  submitBtn: {
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: Theme.accent,
  },
  submitBtnText: { fontSize: 15, fontWeight: "600", color: Theme.bg },
});

export default function SessionsScreen() {
  const [filter, setFilter] = useState<"my" | "team">("my");
  const [refreshing, setRefreshing] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [showFavorites, setShowFavorites] = useState(true);
  const [showNewSession, setShowNewSession] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const router = useRouter();

  const isSearching = debouncedQuery.length >= 2;

  const result = useQuery(api.conversations.listConversations, {
    filter,
    limit: 12,
    include_message_previews: false,
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

      <NewSessionModal visible={showNewSession} onClose={() => setShowNewSession(false)} />

      <TouchableOpacity
        style={styles.fab}
        onPress={() => setShowNewSession(true)}
        activeOpacity={0.8}
      >
        <FontAwesome name="plus" size={20} color={Theme.bg} />
      </TouchableOpacity>
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
  fab: {
    position: 'absolute',
    bottom: 24,
    right: 20,
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: Theme.accent,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 6,
    elevation: 8,
  },
});
