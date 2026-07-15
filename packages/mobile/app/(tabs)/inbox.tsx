import { StyleSheet, FlatList, RefreshControl, TouchableOpacity, TextInput, View as RNView, Text as RNText, Modal, Alert, ScrollView, KeyboardAvoidingView, Platform, ActivityIndicator, Image, ActionSheetIOS } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { api } from '@codecast/convex/convex/_generated/api';
import { Component, type ReactNode, useState, useCallback, useRef, useMemo, useEffect } from 'react';
import { useRouter } from 'expo-router';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import { Theme, Spacing } from '@/constants/Theme';
import {
  SessionData, SwipeableSessionItem, cleanTitle, agentLabel, agentColor,
  formatRelativeTime, projectName, styles as sessionStyles,
} from '@/components/SessionItem';
import {
  useInboxStore, type InboxSession, type InboxViewMode, type BucketItem, categorizeSessions, partitionOldSessions, sessionsWithPendingSend,
  chipMatchesSession, getProjectName, resolveInboxViewMode, flatViewSessions, convBucketMap,
  groupSessionsForLabelView, groupSessionsByPlan, sortLabels, computeChipCounts,
} from '@codecast/web/store/inboxStore';
import { useSyncBuckets } from '@codecast/web/hooks/useSyncBuckets';
import { labelHexColor } from '@/lib/labelColors';
import { useSyncInboxSessions } from '@/hooks/useSyncInboxSessions';
import { SessionListSkeleton } from '@/components/SkeletonLoader';
import { useQuery } from 'convex/react';

// Stashed/Killed bucket row — the web SessionCard's hidden variants. Tap opens
// the session; explicit buttons restore (both) and kill (stashed only — a
// killed session's agent is already torn down).
function HiddenSessionRow({ session, variant, onPress, onRestore, onKill }: {
  session: SessionData;
  variant: "stashed" | "killed";
  onPress: () => void;
  onRestore: () => void;
  onKill?: () => void;
}) {
  const project = projectName(session);
  const agent = agentLabel(session.agent_type ?? "");

  return (
    <TouchableOpacity onPress={onPress} style={styles.dismissedItem} activeOpacity={0.6}>
      <RNView style={sessionStyles.conversationHeader}>
        <RNView style={sessionStyles.titleRow}>
          <FontAwesome
            name={variant === "stashed" ? "archive" : "times-circle"}
            size={10}
            color={Theme.textMuted0}
            style={{ marginRight: 6 }}
          />
          <RNText style={styles.dismissedTitle} numberOfLines={1}>
            {cleanTitle(session.title)}
          </RNText>
        </RNView>
        <RNView style={styles.hiddenRowActions}>
          <TouchableOpacity onPress={onRestore} hitSlop={{ top: 10, bottom: 10, left: 8, right: 8 }} activeOpacity={0.6}>
            <FontAwesome name="level-up" size={13} color={Theme.cyan} />
          </TouchableOpacity>
          {onKill && (
            <TouchableOpacity onPress={onKill} hitSlop={{ top: 10, bottom: 10, left: 8, right: 8 }} activeOpacity={0.6}>
              <FontAwesome name="times" size={13} color={Theme.red} />
            </TouchableOpacity>
          )}
        </RNView>
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
        <RNText style={sessionStyles.metaSeparator}>·</RNText>
        <RNText style={sessionStyles.metaText}>{session.message_count} msgs</RNText>
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
  const recentProjects = useQuery(api.users.getRecentProjectPaths, visible ? { limit: 6 } : "skip");

  useEffect(() => {
    if (visible && !projectPath && recentProjects?.length) {
      setProjectPath(recentProjects[0].path);
    }
  }, [visible, recentProjects]);

  // Optimistic create — mirrors web ComposeView. Seeds a local stub session and
  // navigates to it synchronously; the real server create rides the store outbox
  // and rekeys stub → real id in the background. No await, no spinner: the modal
  // dismisses and the session screen renders instantly. The session screen
  // resolves the stub local-first (useConversationMessages gates on isConvexId).
  const handleSubmit = () => {
    const store = useInboxStore.getState();
    const agent_type = agentType === "claude" ? "claude_code" : agentType;
    const path = projectPath.trim() || undefined;
    const { stubId } = store.beginOptimisticSession({
      agentType: agent_type,
      projectPath: path,
      gitRoot: path,
      create: (stubId) =>
        store.createSession({
          agent_type,
          project_path: path,
          git_root: path,
          session_id: stubId,
        }),
    });
    onClose();
    setProjectPath("");
    onSessionCreated(stubId);
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
          <TouchableOpacity onPress={onClose} hitSlop={{ top: 14, bottom: 14, left: 14, right: 14 }}>
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
            style={modalStyles.submitBtn}
            onPress={handleSubmit}
            activeOpacity={0.7}
          >
            <RNText style={modalStyles.submitBtnText}>Start Session</RNText>
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

// A thrown Convex query error (e.g. searchConversations timing out on a
// multi-word query) must cost the user the RESULTS LIST, not the whole inbox —
// web survives this, so the phone must too. The boundary re-arms whenever the
// query changes so the next keystroke retries cleanly.
class SearchErrorBoundary extends Component<{ resetKey: string; children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidUpdate(prev: { resetKey: string }) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null });
  }
  render() {
    if (this.state.error) {
      return (
        <RNView style={styles.emptyInbox}>
          <FontAwesome name="exclamation-triangle" size={22} color={Theme.textMuted0} />
          <RNText style={styles.emptyText}>Search failed</RNText>
          <RNText style={styles.emptySubtext}>Try a shorter or simpler query</RNText>
        </RNView>
      );
    }
    return this.props.children;
  }
}

// Owns the search subscription so a server error surfaces inside the boundary
// above instead of unmounting InboxScreen.
function SearchResultsList({ query, userOnly, onOpen }: { query: string; userOnly: boolean; onOpen: (conversationId: string) => void }) {
  const searchResults = useQuery(api.conversations.searchConversations, { query, limit: 30, userOnly });
  const searchResultsList = useMemo(() => {
    if (!searchResults) return [];
    return 'results' in searchResults ? searchResults.results : (searchResults as SearchResult[]);
  }, [searchResults]);
  return (
    <FlatList
      data={searchResultsList}
      renderItem={({ item }) => (
        <SearchResultItem result={item} onPress={() => onOpen(item.conversationId)} />
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
            <RNText style={styles.emptyText}>No results for "{query}"</RNText>
          </RNView>
        )
      }
      showsVerticalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
    />
  );
}

export default function InboxScreen() {
  const [showNewSession, setShowNewSession] = useState(false);
  const [showStashed, setShowStashed] = useState(false);
  const [showKilled, setShowKilled] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [userOnly, setUserOnly] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const router = useRouter();
  const isSearching = debouncedQuery.length >= 2;

  useSyncInboxSessions();
  useSyncBuckets();

  const sessions = useInboxStore((s) => s.sessions);
  // First-payload state of the live sessions subscription (set by
  // useSyncInboxSessions). Distinguishes "still loading" from "account has no
  // sessions" — a brand-new account (e.g. App Review's demo login) otherwise
  // sits on the skeleton list forever.
  const sessionsFirstLoad = useInboxStore((s) => s.liveLoading.sessions);
  const stashSession = useInboxStore((s) => s.stashSession);
  const restoreSession = useInboxStore((s) => s.restoreSession);
  const pinSession = useInboxStore((s) => s.pinSession);
  // Store actions, not the raw convex mutation: the hide data-transition is
  // what triggers the server-side agent teardown, and the store's optimistic
  // move + reconcile keep the row's bucket honest (same path as web).
  const killSession = useInboxStore((s) => s.killSession);
  const killSessions = useInboxStore((s) => s.killSessions);
  const currentSessionId = useInboxStore((s) => s.currentSessionId);
  const pendingMessages = useInboxStore((s) => s.pendingMessages);
  const pendingSessionCreates = useInboxStore((s) => s.pendingSessionCreates);
  const collapsedSections = useInboxStore((s) => s.collapsedSections);
  const toggleCollapsedSection = useInboxStore((s) => s.toggleCollapsedSection);
  const activeProjectFilter = useInboxStore((s) => s.activeProjectFilter);
  const setActiveProjectFilter = useInboxStore((s) => s.setActiveProjectFilter);
  // Labels ("buckets") + the view-mode preference — all shared web-store state,
  // so filing and filtering stay consistent across phone and desktop.
  const buckets = useInboxStore((s) => s.buckets);
  const bucketAssignments = useInboxStore((s) => s.bucketAssignments);
  const activeBucketFilter = useInboxStore((s) => s.activeBucketFilter);
  const setActiveBucketFilter = useInboxStore((s) => s.setActiveBucketFilter);
  const setInboxViewMode = useInboxStore((s) => s.setInboxViewMode);
  const clientState = useInboxStore((s) => s.clientState);
  const viewMode = resolveInboxViewMode(clientState?.ui);
  const bucketByConv = useMemo(() => convBucketMap(bucketAssignments), [bucketAssignments]);
  const visibleBuckets = useMemo(() => sortLabels(buckets), [buckets]);

  const sessionsWithQueuedMessages = useInboxStore((s) => s.sessionsWithQueuedMessages);
  const liveInboxIds = useInboxStore((s) => s.liveInboxIds);
  // Hide "old" rows exactly like web (GlobalSessionPanel): the never-prune cache
  // holds every session ever synced (including teammates' threads opened from the
  // feed), but only rows the live inbox subscription still returns are actionable.
  // Same EPHEMERAL flag web reads (store.showOldSessions, off every boot) so the
  // phone and desktop render one identical authoritative set by default.
  const showOld = useInboxStore((s) => s.showOldSessions);
  const { visibleSessions } = useMemo(
    () => partitionOldSessions(sessions, liveInboxIds, showOld, currentSessionId),
    [sessions, liveInboxIds, showOld, currentSessionId],
  );
  // Full-args categorize (matches web): pendingSendIds keeps optimistic sends
  // in Working, and opts make isEngagedBlank work so the New section actually
  // surfaces freshly created blank sessions.
  const { sorted: sortedAll, subsByParent, pinned, newSessions, needsInput, working, stashed: stashedSessions, dismissed: dismissedOnly } = useMemo(
    () => categorizeSessions(visibleSessions, sessionsWithQueuedMessages, sessionsWithPendingSend(pendingMessages), {
      currentSessionId,
      pendingCreateIds: new Set(Object.keys(pendingSessionCreates)),
    }),
    [visibleSessions, sessionsWithQueuedMessages, pendingMessages, currentSessionId, pendingSessionCreates],
  );
  const activeSessions = useMemo(() => sortedAll.filter((s) => !s.is_deferred), [sortedAll]);

  // Label + project chip counts — same source as web's LabelChipsRow / palette
  // view switcher (computeChipCounts), so the two clients can't disagree about
  // what each chip contains.
  const { bucketCounts, projectCounts } = useMemo(
    () => computeChipCounts(sortedAll, bucketByConv),
    [sortedAll, bucketByConv],
  );
  // Zero-count labels stay out of the row unless actively filtered — mirror of
  // web's rule (there they retreat to the +N popover; the phone just hides them).
  const labelChips = useMemo(
    () => visibleBuckets.filter((b) => (bucketCounts[b._id] || 0) > 0 || activeBucketFilter === b._id),
    [visibleBuckets, bucketCounts, activeBucketFilter],
  );

  const chipMatches = useCallback((s: InboxSession) =>
    chipMatchesSession(s, { projectFilter: activeProjectFilter, bucketFilter: activeBucketFilter, bucketByConv }),
    [activeProjectFilter, activeBucketFilter, bucketByConv]);
  const chipFilter = useCallback((items: InboxSession[]) => {
    if (!activeProjectFilter && !activeBucketFilter) return items;
    return items.filter(chipMatches);
  }, [activeProjectFilter, activeBucketFilter, chipMatches]);

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

  const handleStash = useCallback((conversationId: string) => {
    stashSession(conversationId);
  }, [stashSession]);

  const handleRestore = useCallback((conversationId: string) => {
    restoreSession(conversationId);
  }, [restoreSession]);

  const handlePin = useCallback((conversationId: string) => {
    pinSession(conversationId);
  }, [pinSession]);

  const confirmKill = useCallback((conversationId: string) => {
    Alert.alert('Kill Session', 'Stop the agent and move this session to Killed?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Kill', style: 'destructive', onPress: () => killSession(conversationId) },
    ]);
  }, [killSession]);

  const confirmKillAllStashed = useCallback((ids: string[]) => {
    Alert.alert('Kill All Stashed', `Stop ${ids.length} stashed session${ids.length === 1 ? '' : 's'}?`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Kill All', style: 'destructive', onPress: () => killSessions(ids) },
    ]);
  }, [killSessions]);

  // Label filing — the web session-card context menu's "label" half. Picks from
  // existing labels (tap the current one to unfile), creates on the fly (iOS
  // Alert.prompt), all through the shared store's optimistic actions.
  const openLabelPicker = useCallback((session: InboxSession) => {
    const store = useInboxStore.getState();
    const labels = sortLabels(store.buckets);
    const current = convBucketMap(store.bucketAssignments)[session._id];
    const pick = (bucket: BucketItem) =>
      store.assignSessionToBucket(session._id, bucket._id === current ? null : bucket._id);
    const createAndAssign = () => {
      if (Platform.OS !== 'ios') return;
      Alert.prompt('New Label', undefined, (name) => {
        const trimmed = name?.trim();
        if (!trimmed) return;
        store.createBucket({ name: trimmed }).then((r: any) => {
          if (r?._id) useInboxStore.getState().assignSessionToBucket(session._id, r._id);
        });
      });
    };
    if (Platform.OS === 'ios') {
      const names = labels.map((b) => (b._id === current ? `✓ ${b.name}` : b.name));
      const options = [...names, 'New Label…', 'Cancel'];
      ActionSheetIOS.showActionSheetWithOptions(
        { options, cancelButtonIndex: options.length - 1, title: 'Label' },
        (index) => {
          if (index < labels.length) pick(labels[index]);
          else if (index === labels.length) createAndAssign();
        },
      );
    } else {
      Alert.alert('Label', undefined, [
        ...labels.map((b) => ({ text: b._id === current ? `✓ ${b.name}` : b.name, onPress: () => pick(b) })),
        { text: 'Cancel', style: 'cancel' as const },
      ]);
    }
  }, []);

  const handleSessionLongPress = useCallback((session: InboxSession) => {
    const favoriteLabel = session.is_favorite ? 'Unfavorite' : 'Favorite';
    const toggleFavorite = () => useInboxStore.getState().toggleFavorite(session._id);
    const options = [
      session.is_pinned ? 'Unpin' : 'Pin',
      favoriteLabel,
      'Label…',
      'Stash',
      'Kill Session',
      'Cancel',
    ];
    const destructiveButtonIndex = 4;
    const cancelButtonIndex = 5;

    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        { options, cancelButtonIndex, destructiveButtonIndex, title: cleanTitle(session.title) },
        (index) => {
          if (index === 0) handlePin(session._id);
          else if (index === 1) toggleFavorite();
          else if (index === 2) openLabelPicker(session);
          else if (index === 3) handleStash(session._id);
          else if (index === 4) confirmKill(session._id);
        },
      );
    } else {
      Alert.alert(cleanTitle(session.title), undefined, [
        { text: session.is_pinned ? 'Unpin' : 'Pin', onPress: () => handlePin(session._id) },
        { text: favoriteLabel, onPress: toggleFavorite },
        { text: 'Label…', onPress: () => openLabelPicker(session) },
        { text: 'Stash', onPress: () => handleStash(session._id) },
        { text: 'Kill Session', style: 'destructive', onPress: () => confirmKill(session._id) },
        { text: 'Cancel', style: 'cancel' },
      ]);
    }
  }, [handlePin, handleStash, confirmKill, openLabelPicker]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    setTimeout(() => setRefreshing(false), 1000);
  }, []);

  const renderSessionItem = useCallback((s: InboxSession) => (
    <SwipeableSessionItem
      key={s._id}
      session={s as SessionData}
      onPress={() => router.push(`/session/${s._id}`)}
      onDismiss={() => handleStash(s._id)}
      onPin={() => handlePin(s._id)}
      onLongPress={() => handleSessionLongPress(s)}
    />
  ), [router, handleStash, handlePin, handleSessionLongPress]);

  // Collapsible section — collapse state lives in the shared store's
  // collapsedSections. Grouped-view sections keep their historical label keys;
  // the label/plan/flat views pass web's keys (bucket_<id>, plan_<key>, all) so
  // collapse state round-trips with desktop.
  const renderSection = useCallback((label: string, items: InboxSession[], color?: string, collapseKey?: string) => {
    if (items.length === 0) return null;
    const key = collapseKey ?? label;
    const collapsed = !!collapsedSections?.[key];
    return (
      <RNView key={key}>
        <TouchableOpacity style={styles.sectionHeader} onPress={() => toggleCollapsedSection(key)} activeOpacity={0.7}>
          <FontAwesome name={collapsed ? "chevron-right" : "chevron-down"} size={9} color={Theme.textMuted0} />
          <RNText style={[styles.sectionTitle, color ? { color } : undefined]}>{label} ({items.length})</RNText>
        </TouchableOpacity>
        {!collapsed && items.map(renderSessionItem)}
      </RNView>
    );
  }, [renderSessionItem, collapsedSections, toggleCollapsedSection]);

  const filteredPinned = useMemo(() => chipFilter(pinned), [chipFilter, pinned]);
  const filteredNew = useMemo(() => chipFilter(newSessions), [chipFilter, newSessions]);
  const filteredNeedsInput = useMemo(() => chipFilter(needsInput), [chipFilter, needsInput]);
  const filteredWorking = useMemo(() => chipFilter(working), [chipFilter, working]);
  const filteredStashed = useMemo(() => chipFilter(stashedSessions), [chipFilter, stashedSessions]);
  const filteredKilled = useMemo(() => chipFilter(dismissedOnly), [chipFilter, dismissedOnly]);

  const listData = useMemo(() => {
    const sections: React.ReactNode[] = [];
    if (Object.keys(sessions).length === 0) {
      // Skeletons only while the live subscription hasn't delivered its first
      // payload (undefined = sync hook not mounted yet). Once it has, an empty
      // collection means a genuinely session-less account — show a real empty
      // state, not an eternal skeleton.
      if (sessionsFirstLoad !== false) {
        return [<SessionListSkeleton key="skeleton" />];
      }
      return [(
        <RNView key="empty" style={styles.emptyInbox}>
          <FontAwesome name="inbox" size={32} color={Theme.textMuted0} />
          <RNText style={styles.emptyText}>No sessions yet</RNText>
          <RNText style={styles.emptySubtext}>Sessions you run with the codecast CLI will appear here</RNText>
        </RNView>
      )];
    }
    if (activeSessions.length === 0) {
      return [(
        <RNView key="empty" style={styles.emptyInbox}>
          <FontAwesome name="inbox" size={32} color={Theme.textMuted0} />
          <RNText style={styles.emptyText}>Inbox zero</RNText>
          <RNText style={styles.emptySubtext}>All sessions stashed, killed, or idle</RNText>
        </RNView>
      )];
    }
    // Flat views: one "All" run ordered by the shared comparator — "recent"
    // reshuffles on activity, "time" is a stable creation chronology honoring
    // any manual order dragged on desktop.
    if (viewMode === "recent" || viewMode === "time") {
      const flat = flatViewSessions(sortedAll, subsByParent, {
        mode: viewMode,
        showSubagents: clientState?.ui?.show_subagents ?? true,
        focusedId: currentSessionId,
        manualOrder: clientState?.ui?.inbox_manual_order,
        chipMatches,
      });
      return [renderSection("All", flat, Theme.cyan, "all")].filter(Boolean);
    }
    // Label / plan lenses: pinned stays its own top section (pin is urgency,
    // not theme); the active set regroups by label or plan, with unfiled
    // sessions falling to auto-derived project groups — exactly web's layout.
    if (viewMode === "bucket" || viewMode === "plan") {
      const active = [...filteredNew, ...filteredNeedsInput, ...filteredWorking];
      sections.push(renderSection("Pinned", filteredPinned, Theme.magenta));
      if (viewMode === "bucket") {
        const { labelGroups, projectGroups } = groupSessionsForLabelView(active, buckets, bucketByConv);
        for (const { bucket, items } of labelGroups)
          sections.push(renderSection(bucket.name, items, labelHexColor(bucket.name), `bucket_${bucket._id}`));
        for (const { name, items } of projectGroups)
          sections.push(renderSection(name, items, name === "other" ? Theme.textMuted0 : labelHexColor(name), `bucketproj_${name}`));
      } else {
        const { planGroups, projectGroups } = groupSessionsByPlan(active);
        for (const { key, label, items } of planGroups)
          sections.push(renderSection(label, items, "#2dd4bf", `plan_${key}`));
        for (const { name, items } of projectGroups)
          sections.push(renderSection(name, items, name === "other" ? Theme.textMuted0 : labelHexColor(name), `planproj_${name}`));
      }
      return sections.filter(Boolean);
    }
    sections.push(renderSection("Pinned", filteredPinned, Theme.magenta));
    sections.push(renderSection("New", filteredNew, Theme.blue));
    sections.push(renderSection("Needs Input", filteredNeedsInput, Theme.accent));
    sections.push(renderSection("Working", filteredWorking, Theme.greenBright));
    return sections.filter(Boolean);
  }, [activeSessions, sessions, sessionsFirstLoad, filteredPinned, filteredWorking, filteredNeedsInput, filteredNew, renderSection, viewMode, sortedAll, subsByParent, clientState, currentSessionId, chipMatches, buckets, bucketByConv]);

  // Stashed (agent alive, kill-all) and Killed buckets — the web panel's two
  // hidden sections, collapsed by default behind count toggles.
  const ListFooter = useMemo(() => (
    <RNView>
      <RNView style={styles.hiddenToggleRow}>
        <TouchableOpacity
          style={styles.hiddenToggle}
          onPress={() => setShowStashed(prev => !prev)}
          activeOpacity={0.7}
        >
          <FontAwesome name={showStashed ? "chevron-up" : "chevron-down"} size={11} color={Theme.textMuted0} />
          <RNText style={styles.dismissedToggleText}>Stashed ({filteredStashed.length})</RNText>
        </TouchableOpacity>
        {showStashed && filteredStashed.length > 0 && (
          <TouchableOpacity
            onPress={() => confirmKillAllStashed(filteredStashed.map(s => s._id))}
            style={styles.killAllBtn}
            activeOpacity={0.7}
          >
            <RNText style={styles.killAllText}>Kill all</RNText>
          </TouchableOpacity>
        )}
      </RNView>
      {showStashed && (
        <RNView style={styles.dismissedSection}>
          {filteredStashed.length === 0 ? (
            <RNText style={styles.dismissedEmpty}>No stashed sessions</RNText>
          ) : (
            filteredStashed.map(s => (
              <HiddenSessionRow
                key={s._id}
                session={s as SessionData}
                variant="stashed"
                onPress={() => router.push(`/session/${s._id}`)}
                onRestore={() => handleRestore(s._id)}
                onKill={() => confirmKill(s._id)}
              />
            ))
          )}
        </RNView>
      )}

      <TouchableOpacity
        style={styles.hiddenToggle}
        onPress={() => setShowKilled(prev => !prev)}
        activeOpacity={0.7}
      >
        <FontAwesome name={showKilled ? "chevron-up" : "chevron-down"} size={11} color={Theme.textMuted0} />
        <RNText style={styles.dismissedToggleText}>Killed ({filteredKilled.length})</RNText>
      </TouchableOpacity>
      {showKilled && (
        <RNView style={styles.dismissedSection}>
          {filteredKilled.length === 0 ? (
            <RNText style={styles.dismissedEmpty}>No killed sessions</RNText>
          ) : (
            filteredKilled.slice(0, 100).map(s => (
              <HiddenSessionRow
                key={s._id}
                session={s as SessionData}
                variant="killed"
                onPress={() => router.push(`/session/${s._id}`)}
                onRestore={() => handleRestore(s._id)}
              />
            ))
          )}
          {filteredKilled.length > 100 && (
            <RNText style={styles.dismissedEmpty}>+{filteredKilled.length - 100} more</RNText>
          )}
        </RNView>
      )}
      <RNView style={{ height: 80 }} />
    </RNView>
  ), [showStashed, showKilled, filteredStashed, filteredKilled, router, handleRestore, confirmKill, confirmKillAllStashed]);

  // View switcher — same options, names, and availability rules as web's
  // GlobalSessionPanel dropdown: label view appears once a label exists, plan
  // view once any session carries a plan. The choice writes the shared
  // inbox_view_mode client pref, so phone and desktop stay on the same lens.
  const hasPlanSessions = useMemo(() => activeSessions.some((x) => !!(x as any).active_plan), [activeSessions]);
  const viewModeOptions = useMemo(() => ([
    { key: "grouped", label: "By status", icon: "list-ul" },
    { key: "recent", label: "By updated", icon: "flash" },
    { key: "time", label: "By created", icon: "clock-o" },
    ...(visibleBuckets.length > 0 ? [{ key: "bucket", label: "By label", icon: "tag" }] : []),
    ...(hasPlanSessions ? [{ key: "plan", label: "By plan", icon: "sitemap" }] : []),
  ] as Array<{ key: InboxViewMode; label: string; icon: any }>), [visibleBuckets.length, hasPlanSessions]);
  const currentViewOption = viewModeOptions.find((o) => o.key === viewMode) ?? viewModeOptions[0];

  const openViewModePicker = useCallback(() => {
    if (Platform.OS === 'ios') {
      const options = [...viewModeOptions.map((o) => (o.key === viewMode ? `✓ ${o.label}` : o.label)), 'Cancel'];
      ActionSheetIOS.showActionSheetWithOptions(
        { options, cancelButtonIndex: options.length - 1, title: 'Sort inbox' },
        (index) => {
          if (index < viewModeOptions.length) setInboxViewMode(viewModeOptions[index].key);
        },
      );
    } else {
      Alert.alert('Sort inbox', undefined, [
        ...viewModeOptions.map((o) => ({ text: o.key === viewMode ? `✓ ${o.label}` : o.label, onPress: () => setInboxViewMode(o.key) })),
        { text: 'Cancel', style: 'cancel' as const },
      ]);
    }
  }, [viewModeOptions, viewMode, setInboxViewMode]);

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <RNView style={styles.header}>
        <RNText style={styles.headerTitle}>Inbox</RNText>
        {activeSessions.length > 0 && !isSearching && (
          <RNView style={styles.countBadge}>
            <RNText style={styles.countBadgeText}>{activeSessions.length}</RNText>
          </RNView>
        )}
        <RNView style={{ flex: 1 }} />
        {!isSearching && (
          <TouchableOpacity style={styles.viewModeBtn} onPress={openViewModePicker} activeOpacity={0.7} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <FontAwesome name={currentViewOption.icon} size={11} color={Theme.textMuted} />
            <RNText style={styles.viewModeBtnText}>{currentViewOption.label}</RNText>
            <FontAwesome name="angle-down" size={11} color={Theme.textMuted0} />
          </TouchableOpacity>
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
            <TouchableOpacity onPress={clearSearch} hitSlop={{ top: 14, bottom: 14, left: 14, right: 14 }}>
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

      {!isSearching && (labelChips.length > 0 || projectCounts.length > 1) && (
        <RNView style={styles.chipRowContainer}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}>
            {/* Manual labels lead, auto-derived project chips follow — web's
                LabelChipsRow order. The row is ONE filter: the store clears the
                other axis when either chip kind activates. */}
            {labelChips.map((bucket) => {
              const active = activeBucketFilter === bucket._id;
              const color = labelHexColor(bucket.name);
              return (
                <TouchableOpacity
                  key={bucket._id}
                  style={[styles.projectChip, active && { borderColor: color, backgroundColor: color + '18' }]}
                  onPress={() => setActiveBucketFilter(active ? null : bucket._id)}
                  activeOpacity={0.7}
                >
                  <RNView style={styles.labelChipInner}>
                    <RNView style={[styles.labelChipDot, { backgroundColor: color }]} />
                    <RNText style={[styles.projectChipText, active && { color, fontWeight: '600' }]} numberOfLines={1}>
                      {bucket.name} <RNText style={styles.projectChipCount}>{bucketCounts[bucket._id] || 0}</RNText>
                    </RNText>
                  </RNView>
                </TouchableOpacity>
              );
            })}
            {projectCounts.map(([name, count]) => {
              const active = activeProjectFilter === name;
              return (
                <TouchableOpacity
                  key={name}
                  style={[styles.projectChip, active && styles.projectChipActive]}
                  onPress={() => setActiveProjectFilter(active ? null : name)}
                  activeOpacity={0.7}
                >
                  <RNText style={[styles.projectChipText, active && styles.projectChipTextActive]} numberOfLines={1}>
                    {name} <RNText style={styles.projectChipCount}>{count}</RNText>
                  </RNText>
                </TouchableOpacity>
              );
            })}
          </ScrollView>
        </RNView>
      )}

      {isSearching ? (
        <SearchErrorBoundary resetKey={`${debouncedQuery}|${userOnly}`}>
          <SearchResultsList
            query={debouncedQuery}
            userOnly={userOnly}
            onOpen={(conversationId) => router.push(`/session/${conversationId}`)}
          />
        </SearchErrorBoundary>
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
  viewModeBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 9,
    paddingVertical: 4,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Theme.borderLight,
    backgroundColor: Theme.bg,
  },
  viewModeBtnText: {
    fontSize: 12,
    fontWeight: '500',
    color: Theme.textMuted,
  },
  labelChipInner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  labelChipDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
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
  hiddenToggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderTopWidth: 1,
    borderTopColor: Theme.bgHighlight,
    marginTop: Spacing.sm,
  },
  hiddenToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 14,
    flexGrow: 1,
  },
  killAllBtn: {
    paddingHorizontal: 12,
    paddingVertical: 5,
    marginRight: Spacing.lg,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: Theme.red + '60',
  },
  killAllText: {
    fontSize: 12,
    fontWeight: '600',
    color: Theme.red,
  },
  hiddenRowActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 18,
    paddingLeft: 8,
  },
  chipRowContainer: {
    backgroundColor: Theme.bgAlt,
    paddingBottom: Spacing.xs,
  },
  chipRow: {
    paddingHorizontal: Spacing.md,
    gap: 6,
    flexDirection: 'row',
  },
  projectChip: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Theme.borderLight,
    backgroundColor: Theme.bg,
    maxWidth: 160,
  },
  projectChipActive: {
    borderColor: Theme.cyan,
    backgroundColor: Theme.cyan + '18',
  },
  projectChipText: {
    fontSize: 12,
    color: Theme.textMuted,
    fontWeight: '500',
  },
  projectChipTextActive: {
    color: Theme.cyan,
    fontWeight: '600',
  },
  projectChipCount: {
    fontSize: 11,
    color: Theme.textMuted0,
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
