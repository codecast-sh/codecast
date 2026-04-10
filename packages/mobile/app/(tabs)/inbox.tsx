import { StyleSheet, FlatList, RefreshControl, TouchableOpacity, TextInput, View as RNView, Text as RNText, Modal, Alert, ScrollView, KeyboardAvoidingView, Platform, ActivityIndicator, Image, ActionSheetIOS } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useMutation } from 'convex/react';
import { api } from '@codecast/convex/convex/_generated/api';
import type { Id } from '@codecast/convex/convex/_generated/dataModel';
import { useState, useCallback, useRef, useMemo, useEffect } from 'react';
import { useRouter } from 'expo-router';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import { Theme, Spacing } from '@/constants/Theme';
import {
  SessionData, SwipeableSessionItem, cleanTitle, agentLabel, agentColor,
  formatRelativeTime, projectName, styles as sessionStyles,
} from '@/components/SessionItem';
import { useInboxStore, type InboxSession, categorizeSessions } from '@codecast/web/store/inboxStore';
import { useSyncInboxSessions } from '@/hooks/useSyncInboxSessions';
import { SessionListSkeleton } from '@/components/SkeletonLoader';
import { useQuery } from 'convex/react';

function DismissedItem({ session, onPress }: { session: SessionData; onPress: () => void }) {
  const project = projectName(session);
  const agent = agentLabel(session.agent_type ?? "");

  return (
    <TouchableOpacity
      onPress={onPress}
      style={styles.dismissedItem}
      activeOpacity={0.6}
    >
      <RNView style={sessionStyles.conversationHeader}>
        <RNView style={sessionStyles.titleRow}>
          <FontAwesome name="archive" size={10} color={Theme.textMuted0} style={{ marginRight: 6 }} />
          <RNText style={styles.dismissedTitle} numberOfLines={1}>
            {cleanTitle(session.title)}
          </RNText>
        </RNView>
        <RNText style={sessionStyles.messageCount}>{session.message_count}</RNText>
      </RNView>
      <RNView style={sessionStyles.conversationMeta}>
        {agent ? (
          <>
            <RNText style={[sessionStyles.agentBadge, { color: agentColor(session.agent_type ?? "") }]}>
              {agent}
            </RNText>
            <RNText style={sessionStyles.metaSeparator}>·</RNText>
          </>
        ) : null}
        <RNText style={sessionStyles.metaText}>{formatRelativeTime(session.updated_at)}</RNText>
        {project && (
          <>
            <RNText style={sessionStyles.metaSeparator}>·</RNText>
            <RNText style={sessionStyles.projectText} numberOfLines={1}>{project}</RNText>
          </>
        )}
      </RNView>
    </TouchableOpacity>
  );
}

type AgentType = "claude" | "codex" | "gemini";

const agentLogoSources = {
  claude: require('@/assets/images/agents/claude.png'),
  codex: require('@/assets/images/agents/codex.png'),
  gemini: require('@/assets/images/agents/gemini.png'),
};

function AgentLogo({ type, size = 20, bgColor }: { type: AgentType; size?: number; bgColor: string }) {
  const iconSize = size * 0.85;
  return (
    <RNView style={{ width: size, height: size, borderRadius: size * 0.2, backgroundColor: bgColor, alignItems: 'center', justifyContent: 'center' }}>
      <Image source={agentLogoSources[type]} style={{ width: iconSize, height: iconSize }} resizeMode="contain" />
    </RNView>
  );
}

function NewSessionModal({ visible, onClose, onSessionCreated }: { visible: boolean; onClose: () => void; onSessionCreated: (conversationId: string) => void }) {
  const [agentType, setAgentType] = useState<AgentType>("claude");
  const [projectPath, setProjectPath] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const startSession = useMutation(api.users.startSession);
  const recentProjects = useQuery(api.users.getRecentProjectPaths, { limit: 6 });

  useEffect(() => {
    if (visible && !projectPath && recentProjects?.length) {
      setProjectPath(recentProjects[0].path);
    }
  }, [visible, recentProjects]);

  const handleSubmit = async () => {
    setSubmitting(true);
    try {
      const result = await startSession({
        agent_type: agentType,
        project_path: projectPath || undefined,
      });
      onClose();
      setProjectPath("");
      onSessionCreated(result.conversation_id);
    } catch (err) {
      Alert.alert("Error", err instanceof Error ? err.message : "Failed to start session");
    } finally {
      setSubmitting(false);
    }
  };

  const agents: { type: AgentType; label: string; color: string; bgColor: string }[] = [
    { type: "claude", label: "Claude", color: Theme.orange, bgColor: "#b58900" },
    { type: "codex", label: "Codex", color: Theme.green, bgColor: "#0f0f0f" },
    { type: "gemini", label: "Gemini", color: Theme.blue, bgColor: "#1a73e8" },
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
                <AgentLogo type={a.type} size={20} bgColor={agentType === a.type ? a.bgColor : Theme.textMuted0} />
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
          {recentProjects && recentProjects.length > 0 && (
            <RNView style={modalStyles.recentRow}>
              {recentProjects.slice(0, 4).map((p) => (
                <TouchableOpacity
                  key={p.path}
                  style={[modalStyles.recentChip, projectPath === p.path && { borderColor: Theme.accent, backgroundColor: Theme.accent + "20" }]}
                  onPress={() => setProjectPath(p.path)}
                  activeOpacity={0.7}
                >
                  <RNText style={[modalStyles.recentChipText, projectPath === p.path && { color: Theme.accent }]} numberOfLines={1}>
                    {p.path.split("/").pop()}
                  </RNText>
                </TouchableOpacity>
              ))}
            </RNView>
          )}
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
    flexDirection: "row",
    gap: 6,
    justifyContent: "center",
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
      <RNView style={styles.conversationMeta}>
        <RNText style={styles.metaText}>{formatRelativeTime(result.updatedAt)}</RNText>
        <RNText style={styles.metaSeparator}>·</RNText>
        <RNText style={styles.metaText}>{result.messageCount} msgs</RNText>
        {!result.isOwn && (
          <>
            <RNText style={styles.metaSeparator}>·</RNText>
            <RNText style={styles.metaText}>{result.authorName}</RNText>
          </>
        )}
      </RNView>
    </TouchableOpacity>
  );
}

export default function InboxScreen() {
  const [showNewSession, setShowNewSession] = useState(false);
  const [showDismissed, setShowDismissed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [userOnly, setUserOnly] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const router = useRouter();
  const isSearching = debouncedQuery.length >= 2;

  useSyncInboxSessions();

  const sessions = useInboxStore((s) => s.sessions);
  const dismissedSessionsMap = useInboxStore((s) => s.dismissedSessions);
  const stashSession = useInboxStore((s) => s.stashSession);
  const unstashSession = useInboxStore((s) => s.unstashSession);
  const pinSession = useInboxStore((s) => s.pinSession);
  const deferSession = useInboxStore((s) => s.deferSession);
  const killSession = useMutation(api.conversations.killSession);

  const sessionsWithQueuedMessages = useInboxStore((s) => s.sessionsWithQueuedMessages);
  const { sorted: sortedAll, pinned, newSessions, needsInput, working } = useMemo(
    () => categorizeSessions(sessions, sessionsWithQueuedMessages),
    [sessions, sessionsWithQueuedMessages],
  );
  const activeSessions = useMemo(() => sortedAll.filter((s) => !s.is_deferred), [sortedAll]);
  const dismissedSessions = useMemo(() => Object.values(dismissedSessionsMap), [dismissedSessionsMap]);

  const searchResults = useQuery(
    api.conversations.searchConversations,
    isSearching ? { query: debouncedQuery, limit: 30, userOnly } : "skip"
  );

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

  const handleDismiss = useCallback((conversationId: string) => {
    stashSession(conversationId);
  }, [stashSession]);

  const handleDefer = useCallback((conversationId: string) => {
    deferSession(conversationId);
  }, [deferSession]);


  const handleUndismiss = useCallback((conversationId: string) => {
    unstashSession(conversationId);
  }, [unstashSession]);

  const handlePin = useCallback((conversationId: string) => {
    pinSession(conversationId);
  }, [pinSession]);

  const handleSessionLongPress = useCallback((session: InboxSession) => {
    const options = [
      session.is_pinned ? 'Unpin' : 'Pin',
      'Defer',
      'Dismiss',
      'Kill Agent',
      'Cancel',
    ];
    const destructiveButtonIndex = 3;
    const cancelButtonIndex = 4;

    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        { options, cancelButtonIndex, destructiveButtonIndex, title: cleanTitle(session.title) },
        (index) => {
          if (index === 0) handlePin(session._id);
          else if (index === 1) deferSession(session._id);
          else if (index === 2) handleDismiss(session._id);
          else if (index === 3) {
            Alert.alert('Kill Agent', 'Stop this agent session?', [
              { text: 'Cancel', style: 'cancel' },
              { text: 'Kill', style: 'destructive', onPress: () => killSession({ conversation_id: session._id as Id<"conversations"> }) },
            ]);
          }
        },
      );
    } else {
      Alert.alert(cleanTitle(session.title), undefined, [
        { text: session.is_pinned ? 'Unpin' : 'Pin', onPress: () => handlePin(session._id) },
        { text: 'Defer', onPress: () => deferSession(session._id) },
        { text: 'Dismiss', onPress: () => handleDismiss(session._id) },
        { text: 'Kill Agent', style: 'destructive', onPress: () => {
          Alert.alert('Kill Agent', 'Stop this agent session?', [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Kill', style: 'destructive', onPress: () => killSession({ conversation_id: session._id as Id<"conversations"> }) },
          ]);
        }},
        { text: 'Cancel', style: 'cancel' },
      ]);
    }
  }, [handlePin, handleDismiss, deferSession, killSession]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    setTimeout(() => setRefreshing(false), 1000);
  }, []);

  const renderSessionItem = useCallback((s: InboxSession) => (
    <SwipeableSessionItem
      key={s._id}
      session={s as SessionData}
      onPress={() => router.push(`/session/${s._id}`)}
      onDismiss={() => handleDismiss(s._id)}
      onPin={() => handlePin(s._id)}
      onLongPress={() => handleSessionLongPress(s)}
    />
  ), [router, handleDismiss, handlePin, handleSessionLongPress]);

  const renderSection = useCallback((label: string, items: InboxSession[], color?: string) => {
    if (items.length === 0) return null;
    return (
      <RNView key={label}>
        <RNView style={styles.sectionHeader}>
          <RNText style={[styles.sectionTitle, color ? { color } : undefined]}>{label} ({items.length})</RNText>
        </RNView>
        {items.map(renderSessionItem)}
      </RNView>
    );
  }, [renderSessionItem]);

  const listData = useMemo(() => {
    const sections: React.ReactNode[] = [];
    if (Object.keys(sessions).length === 0) {
      return [<SessionListSkeleton key="skeleton" />];
    }
    if (activeSessions.length === 0) {
      return [(
        <RNView key="empty" style={styles.emptyInbox}>
          <FontAwesome name="inbox" size={32} color={Theme.textMuted0} />
          <RNText style={styles.emptyText}>Inbox zero</RNText>
          <RNText style={styles.emptySubtext}>All sessions dismissed or idle</RNText>
        </RNView>
      )];
    }
    sections.push(renderSection("Pinned", pinned, Theme.magenta));
    sections.push(renderSection("New", newSessions));
    sections.push(renderSection("Needs Input", needsInput, Theme.accent));
    sections.push(renderSection("Working", working, Theme.greenBright));
    return sections.filter(Boolean);
  }, [activeSessions, sessions, pinned, working, needsInput, newSessions, renderSection]);

  const ListFooter = useMemo(() => (
    <RNView>
      <TouchableOpacity
        style={styles.dismissedToggle}
        onPress={() => setShowDismissed(prev => !prev)}
        activeOpacity={0.7}
      >
        <FontAwesome name={showDismissed ? "chevron-up" : "chevron-down"} size={11} color={Theme.textMuted0} />
        <RNText style={styles.dismissedToggleText}>
          {showDismissed ? "Hide dismissed" : "Show dismissed"}
        </RNText>
      </TouchableOpacity>

      {showDismissed && (
        <RNView style={styles.dismissedSection}>
          {dismissedSessions.length === 0 ? (
            <RNText style={styles.dismissedEmpty}>No dismissed sessions</RNText>
          ) : (
            dismissedSessions.map(s => (
              <DismissedItem
                key={s._id}
                session={s as SessionData}
                onPress={() => handleUndismiss(s._id)}
              />
            ))
          )}
        </RNView>
      )}
      <RNView style={{ height: 80 }} />
    </RNView>
  ), [showDismissed, dismissedSessions, router, handleUndismiss]);

  const searchResultsList = useMemo(() => {
    if (!searchResults) return [];
    return 'results' in searchResults ? searchResults.results : (searchResults as SearchResult[]);
  }, [searchResults]);

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <RNView style={styles.header}>
        <RNText style={styles.headerTitle}>Inbox</RNText>
        {activeSessions.length > 0 && !isSearching && (
          <RNView style={styles.countBadge}>
            <RNText style={styles.countBadgeText}>{activeSessions.length}</RNText>
          </RNView>
        )}
      </RNView>

      <RNView style={styles.searchContainer}>
        <RNView style={styles.searchInputRow}>
          <FontAwesome name="search" size={14} color={Theme.textMuted0} style={{ marginRight: 8 }} />
          <TextInput
            style={styles.searchInput}
            value={searchQuery}
            onChangeText={handleSearchChange}
            placeholder="Search all conversations..."
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
        {isSearching && (
          <TouchableOpacity
            style={[styles.userOnlyToggle, userOnly && styles.userOnlyToggleActive]}
            onPress={() => setUserOnly(prev => !prev)}
            activeOpacity={0.7}
          >
            <RNText style={[styles.userOnlyText, userOnly && styles.userOnlyTextActive]}>
              User messages only
            </RNText>
          </TouchableOpacity>
        )}
      </RNView>

      {isSearching ? (
        <FlatList
          data={searchResultsList}
          renderItem={({ item }) => (
            <SearchResultItem
              result={item}
              onPress={() => router.push(`/session/${item.conversationId}`)}
            />
          )}
          keyExtractor={(item) => item.conversationId}
          contentContainerStyle={searchResultsList.length === 0 ? styles.emptyList : styles.listContent}
          ListEmptyComponent={
            searchResults === undefined ? (
              <RNView style={styles.emptyInbox}>
                <ActivityIndicator size="small" color={Theme.textMuted} />
              </RNView>
            ) : (
              <RNView style={styles.emptyInbox}>
                <RNText style={styles.emptyText}>No results for "{debouncedQuery}"</RNText>
              </RNView>
            )
          }
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        />
      ) : (
        <ScrollView
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={Theme.textMuted}
            />
          }
          contentContainerStyle={activeSessions.length === 0 ? styles.emptyList : styles.listContent}
          showsVerticalScrollIndicator={false}
        >
          {listData}
          {ListFooter}
        </ScrollView>
      )}

      <NewSessionModal
        visible={showNewSession}
        onClose={() => setShowNewSession(false)}
        onSessionCreated={(conversationId) => {
          router.push(`/session/${conversationId}`);
        }}
      />

      <RNView style={styles.fabContainer} pointerEvents="box-none">
        <TouchableOpacity
          style={styles.fab}
          onPress={() => setShowNewSession(true)}
          activeOpacity={0.8}
        >
          <FontAwesome name="plus" size={18} color="#fff" />
        </TouchableOpacity>
      </RNView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Theme.bg,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.lg,
    paddingTop: Spacing.md,
    paddingBottom: Spacing.xs,
    backgroundColor: Theme.bgAlt,
    gap: 8,
  },
  headerTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: Theme.text,
  },
  countBadge: {
    backgroundColor: Theme.accent,
    borderRadius: 10,
    paddingHorizontal: 8,
    paddingVertical: 2,
    minWidth: 22,
    alignItems: 'center',
  },
  countBadgeText: {
    fontSize: 12,
    fontWeight: '700',
    color: Theme.bg,
  },
  listContent: {
    paddingBottom: Spacing.xl,
  },
  emptyList: {
    flexGrow: 1,
  },
  emptyInbox: {
    alignItems: 'center',
    paddingVertical: 60,
    gap: 8,
  },
  emptyText: {
    fontSize: 17,
    fontWeight: '600',
    color: Theme.textMuted,
  },
  emptySubtext: {
    fontSize: 14,
    color: Theme.textMuted0,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.sm,
    backgroundColor: Theme.bgAlt,
  },
  sectionTitle: {
    fontSize: 12,
    fontWeight: '600',
    color: Theme.textMuted0,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  dismissedToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 14,
    borderTopWidth: 1,
    borderTopColor: Theme.bgHighlight,
    marginTop: Spacing.sm,
  },
  dismissedToggleText: {
    fontSize: 13,
    color: Theme.textMuted0,
    fontWeight: '500',
  },
  dismissedSection: {
    backgroundColor: Theme.bgAlt,
  },
  dismissedEmpty: {
    fontSize: 13,
    color: Theme.textMuted0,
    textAlign: 'center',
    paddingVertical: 20,
  },
  dismissedItem: {
    paddingHorizontal: Spacing.lg,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Theme.borderLight,
    opacity: 0.7,
  },
  dismissedTitle: {
    fontSize: 14,
    fontWeight: '400',
    color: Theme.textMuted,
    flex: 1,
  },
  searchContainer: {
    backgroundColor: Theme.bgAlt,
    paddingHorizontal: Spacing.md,
    paddingTop: Spacing.xs,
    paddingBottom: Spacing.xs,
  },
  searchInputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Theme.bg,
    borderRadius: 10,
    paddingHorizontal: Spacing.md,
    height: 34,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Theme.borderLight,
  },
  searchInput: {
    flex: 1,
    fontSize: 15,
    color: Theme.text,
    paddingVertical: 0,
  },
  userOnlyToggle: {
    alignSelf: 'flex-start',
    marginTop: 6,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Theme.borderLight,
  },
  userOnlyToggleActive: {
    backgroundColor: Theme.accent + '20',
    borderColor: Theme.accent,
  },
  userOnlyText: {
    fontSize: 12,
    color: Theme.textMuted,
    fontWeight: '500',
  },
  userOnlyTextActive: {
    color: Theme.accent,
  },
  searchResultItem: {
    paddingHorizontal: Spacing.lg,
    paddingVertical: 12,
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
    marginBottom: 4,
  },
  conversationMeta: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  metaText: {
    fontSize: 12,
    color: Theme.textMuted,
  },
  metaSeparator: {
    color: Theme.textMuted0,
    marginHorizontal: 4,
    fontSize: 12,
  },
  fabContainer: {
    position: 'absolute',
    bottom: 24,
    right: 20,
    zIndex: 100,
    elevation: 100,
  },
  fab: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: Theme.accent,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.25,
    shadowRadius: 6,
    elevation: 6,
  },
});
