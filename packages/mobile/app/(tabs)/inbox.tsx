import { StyleSheet, RefreshControl, TouchableOpacity, View as RNView, Alert, ScrollView, Platform, ActionSheetIOS } from 'react-native';
import { probeRender, PERF_PROBE } from '@/lib/perfProbe';
import { TextInput, Text as RNText } from '@/components/Themed';
import { SafeAreaView } from 'react-native-safe-area-context';
import { api } from '@codecast/convex/convex/_generated/api';
import { Component, type ReactNode, useState, useCallback, useRef, useMemo, useEffect, startTransition } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import { Theme, Spacing, themedStyles, useTheme, useActiveScheme } from '@/constants/Theme';
import {
  SessionData, SwipeableSessionItem, InboxRowEnvProvider, sessionTitle, agentLabel, agentColor,
  formatRelativeTime, projectName, projectColor, styles as sessionStyles,
} from '@/components/SessionItem';
import {
  useInboxStore, type InboxSession, type BucketItem,
  chipMatchesSession, getProjectName, resolveInboxViewMode, flatViewSessions, convBucketMap,
  groupSessionsForLabelView, groupSessionsByPlan, sortLabels,
  sessionUnreadMap, sessionUnreadWakeSig, sectionHeaderCount,
  hostedOnlyInbox, hostedStatusSections, pendingSendIdsOf, HOSTED_UNFOLDABLE_SECTIONS,
} from '@codecast/web/store/inboxStore';
import { awaitingOkIds } from '@codecast/web/lib/decisionQueue';
import { hostedRowTitle } from '@codecast/web/lib/hostedRowTitle';
import { hostedStopsSig, splitHostedStops } from '@codecast/web/lib/hostedNotice';
import { sameNameSuffixes } from '@codecast/web/lib/sameNameSuffix';
import { useHostedMode, useModeWords, useSurface } from '@codecast/web/lib/surfaces';
import { AssistantIntro } from '@/components/hosted/AssistantStart';
import { pageTitleFace } from '@/constants/fonts';
import { partitionTriggerInbox, type TaskRow } from '@codecast/web/components/triggerTasks';
import { DecisionsBadge } from '@/components/decisions/DecisionsBadge';
import { useDecisionQueue } from '@codecast/web/hooks/useDecisionQueue';
import { useTriggers } from '@codecast/web/hooks/useSyncTriggers';
import { SearchResults } from '@/components/search/SearchResults';
import { labelHexColor } from '@/lib/labelColors';
import { SessionListSkeleton } from '@/components/SkeletonLoader';
import { TriggerDock } from '@/components/TriggerDock';
import { useQuery } from 'convex/react';
import { mobileCreateErrorMessage, mobileCreateFailureDisposition } from '@/lib/durableCreatePolicy';
import { bootMark } from '@/lib/bootProfile';
import { setInboxDrawerOpen } from '@/lib/inboxDrawer';
import { useInboxPlacement } from '@/hooks/useInboxPlacement';
import Feather from '@expo/vector-icons/Feather';
import * as Haptics from 'expo-haptics';
import { openCompose } from '@/lib/compose';
import { ComposeButton } from '@/components/session/ComposeButton';
import { InboxLensBar } from '@/components/inbox/InboxLensBar';
import { AreaBar } from '@/components/nav/AreaBar';

/** How a hosted inbox section draws: its same-name suffixes, whether it
 *  waits on the person (the accent dot), and whether it never folds. */
type HostedSectionOpts = { suffixes?: ReadonlyMap<string, string>; attention?: boolean; fixed?: boolean };

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
  const Theme = useTheme();
  // Hosted mode keeps the row to its title and time (lib/surfaces).
  const internals = useSurface('inbox.rowInternals');
  const project = useSurface('gitChips') ? projectName(session) : null;
  const agent = internals ? agentLabel(session.agent_type ?? "") : "";

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
          {variant === "stashed" && session.inbox_stashed_at && session.inbox_stash_hidden ? (
            // Stash and hide: trigger wakes don't bring it back (web's EyeOff mark).
            <FontAwesome name="eye-slash" size={10} color={Theme.textMuted0} style={{ marginRight: 6 }} />
          ) : null}
          <RNText style={styles.dismissedTitle} numberOfLines={1}>
            {sessionTitle(session)}
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
        {internals && (
          <>
            <RNText style={sessionStyles.metaSeparator}>·</RNText>
            <RNText style={sessionStyles.metaText}>{session.message_count} msgs</RNText>
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

export default function InboxScreen() {
  return <InboxView />;
}

// Rows that fill a phone screen with some to spare, mounted with the list.
const FIRST_PAINT_ROWS = 14;

/** The inbox list. The tab shows it whole; a conversation's slide-out panel
 *  shows it as `panel`, where a row opens in place of the conversation
 *  (`onOpenSession`) and `currentId`'s row is marked as the one on screen. */
export function InboxView({ panel = false, currentId, onOpenSession, onExit }: {
  panel?: boolean;
  currentId?: string;
  onOpenSession?: (conversationId: string, messageId?: string) => void;
  /** The panel's title leaves for the inbox tab. */
  onExit?: () => void;
} = {}) {
  if (PERF_PROBE) probeRender('InboxView');
  const Theme = useTheme();
  // Both list memos below bake palette values into React nodes.
  const scheme = useActiveScheme();
  // A starter tapped in the empty inbox opens the sheet with its words typed in.
  const openNewSession = openCompose;
  const words = useModeWords();
  const hostedMode = useHostedMode();
  // Hosted mode: no CLI to install, and no project chips.
  const installCli = useSurface('empty.installCli');
  const [showStashed, setShowStashed] = useState(false);
  const [showKilled, setShowKilled] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  // Search stays folded away until asked for: it opens from its icon or by
  // pulling the list down past its first row. Labels, projects and the view
  // lens live in the slide-out panel (components/inbox/InboxDrawer).
  const [searchOpen, setSearchOpen] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const router = useRouter();
  // Another tab can open the sheet with words typed in (`?ask=`): the empty
  // Routines list's examples do. The param is dropped once read, so the same
  // example works again.
  const ask = useLocalSearchParams<{ ask?: string }>().ask;
  useEffect(() => {
    if (!ask) return;
    openNewSession(ask);
    router.setParams({ ask: undefined });
  }, [ask, openNewSession, router]);
  const isSearching = searchQuery.trim().length >= 2;
  const openSession = useCallback((conversationId: string, messageId?: string) => {
    if (onOpenSession) onOpenSession(conversationId, messageId);
    else router.push(`/session/${conversationId}${messageId ? `?message=${messageId}` : ''}`);
  }, [onOpenSession, router]);

  // The rows as the shared chokepoint places them (hooks/useInboxPlacement):
  // the same computation the slide-out panel's counts and web run. The body
  // reads the raw sessions map off the store at render, gated by sessionsSig.
  const { placed, sessionsSig, pendingSendSig, coarseNow, currentSessionId, sessionsWithQueuedMessages } = useInboxPlacement();
  const inboxPainted = useRef(false);
  useEffect(() => {
    if (inboxPainted.current) return;
    const n = Object.keys(useInboxStore.getState().sessions).length;
    if (n === 0) return;
    inboxPainted.current = true;
    bootMark("inbox-rows", { n });
  }, [sessionsSig]);
  // Unread has its own signature: sessionsWakeSig deliberately omits
  // updated_at, which is exactly the number the read model compares against.
  const unreadSig = useInboxStore((s) => sessionUnreadWakeSig(s));
  // The Assistant scope (lib/assistantScope): in hosted mode the inbox holds
  // the assistant's conversations and folds them into the web rail's words
  // (hostedStatusSections), stops in their own "Couldn't finish".
  const hostedOnly = useInboxStore((s) => hostedOnlyInbox(s.clientState?.ui ?? {}));
  const awaitingSig = useInboxStore((s) => (hostedOnly ? [...awaitingOkIds(s.sessionDecisions)].sort().join(',') : ''));
  const stopsSig = useInboxStore((s) => (hostedOnly ? hostedStopsSig(s.sessions, s.messages) : ''));
  const sessions = useInboxStore.getState().sessions;
  // First-payload state of the live sessions subscription (set by
  // useSyncInboxSessions). Distinguishes "still loading" from "account has no
  // sessions" — a brand-new account (e.g. App Review's demo login) otherwise
  // sits on the skeleton list forever. Pair with clientStateInitialized so a
  // kill-and-reopen that still has the SQLite cache never looks like a cold
  // load: splash stays up until this is true, and the list then paints from
  // disk even if the live subscription hasn't connected yet.
  const sessionsFirstLoad = useInboxStore((s) => s.liveLoading.sessions);
  const hydrated = useInboxStore((s) => s.clientStateInitialized);
  const stashSession = useInboxStore((s) => s.stashSession);
  const restoreSession = useInboxStore((s) => s.restoreSession);
  const pinSession = useInboxStore((s) => s.pinSession);
  // Store actions, not the raw convex mutation: the hide data-transition is
  // what triggers the server-side agent teardown, and the store's optimistic
  // move + reconcile keep the row's bucket honest (same path as web).
  const killSession = useInboxStore((s) => s.killSession);
  const killSessions = useInboxStore((s) => s.killSessions);
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
  // Scalars off clientState, never the whole singleton — it churns on every
  // draft keystroke synced from any device. inbox_manual_order is an array, so
  // its wake rides a stringified key (ref may flip without content change).
  const viewMode = useInboxStore((s) => resolveInboxViewMode(s.clientState?.ui));
  const showSubagents = useInboxStore((s) => s.clientState?.ui?.show_subagents ?? true);
  const manualOrderKey = useInboxStore((s) => JSON.stringify(s.clientState?.ui?.inbox_manual_order ?? null));
  const bucketByConv = useMemo(() => convBucketMap(bucketAssignments), [bucketAssignments]);

  const { visibleSessions, sorted: sortedAll, subsByParent, questions, pinned, newSessions, needsInput, done, dormant, working, stashed: stashedSessions, dismissed: dismissedOnly, roleSessionsByLead } = placed;
  const activeSessions = useMemo(() => sortedAll.filter((s) => !s.is_deferred), [sortedAll]);
  // The number beside the title, in the attention colour: how much is open.
  // Hosted mode shows no bare number there. Its one mark is the decisions
  // badge ("1 to answer"), and each section's own count says the rest, so
  // the header never shows two numbers for overlapping things.
  const headerCount = hostedMode ? 0 : activeSessions.length;
  // The rows with an open question, which a hosted row says in plain words.
  const questionIds = useMemo(() => new Set(questions.map((s) => String(s._id))), [questions]);
  // What each of those rows asks: the row's quiet line is the open question
  // itself (lane.ts conversationSubline), the oldest when it holds several.
  const decisionQueue = useDecisionQueue();
  const askedByConv = useMemo(() => {
    const asked = new Map<string, string>();
    for (const item of [...decisionQueue].sort((a, b) => a.createdAt - b.createdAt)) {
      if (!asked.has(item.conversationId)) asked.set(item.conversationId, item.question);
    }
    return asked;
  }, [decisionQueue]);

  const chipMatches = useCallback((s: InboxSession) =>
    chipMatchesSession(s, {
      projectFilters: activeProjectFilter ? [{ id: activeProjectFilter, path: null, exclude: false }] : undefined,
      bucketFilters: activeBucketFilter ? [{ id: activeBucketFilter, exclude: false }] : undefined,
      bucketByConv,
      hostedOnly,
    }),
    [activeProjectFilter, activeBucketFilter, bucketByConv, hostedOnly]);
  const chipFilter = useCallback((items: InboxSession[]) => {
    if (!activeProjectFilter && !activeBucketFilter && !hostedOnly) return items;
    return items.filter(chipMatches);
  }, [activeProjectFilter, activeBucketFilter, hostedOnly, chipMatches]);

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

  const closeSearch = useCallback(() => {
    clearSearch();
    setSearchOpen(false);
  }, [clearSearch]);

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
    Alert.alert(words.kill, words.killAsk, [
      { text: 'Cancel', style: 'cancel' },
      { text: words.killConfirm, style: 'destructive', onPress: () => killSession(conversationId) },
    ]);
  }, [killSession, words]);

  const confirmKillAllStashed = useCallback((ids: string[]) => {
    Alert.alert(words.killAllStashed, `${words.killAllAsk} (${ids.length})`, [
      { text: 'Cancel', style: 'cancel' },
      { text: words.killConfirm, style: 'destructive', onPress: () => killSessions(ids) },
    ]);
  }, [killSessions, words]);

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
        const attemptCreate = async () => {
          try {
            await useInboxStore.getState().createBucket(
              { name: trimmed },
              {
                version: 1,
                kind: "assignBucket",
                conversationIds: [session._id],
              },
            );
          } catch (error) {
            if (mobileCreateFailureDisposition(error) === "accepted-pending") {
              Alert.alert(
                'Label queued',
                'The label is saved for delivery and will appear when CodeCast reconnects.',
              );
              return;
            }
            Alert.alert(
              "Couldn't create label",
              mobileCreateErrorMessage("label", error),
              [
                { text: 'Cancel', style: 'cancel' },
                { text: 'Retry', onPress: () => void attemptCreate() },
              ],
            );
          }
        };
        void attemptCreate();
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
    // Same verb as the web card's right-click menu, same store action, so the
    // dot the phone lights is the dot the desktop shows.
    const markUnread = () => useInboxStore.getState().markSessionUnread(session._id);
    const options = [
      session.is_pinned ? 'Unpin' : 'Pin',
      favoriteLabel,
      'Mark unread',
      'Label…',
      words.stash,
      words.kill,
      'Cancel',
    ];
    const destructiveButtonIndex = 5;
    const cancelButtonIndex = 6;

    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        { options, cancelButtonIndex, destructiveButtonIndex, title: sessionTitle(session) },
        (index) => {
          if (index === 0) handlePin(session._id);
          else if (index === 1) toggleFavorite();
          else if (index === 2) markUnread();
          else if (index === 3) openLabelPicker(session);
          else if (index === 4) handleStash(session._id);
          else if (index === 5) confirmKill(session._id);
        },
      );
    } else {
      Alert.alert(sessionTitle(session), undefined, [
        { text: session.is_pinned ? 'Unpin' : 'Pin', onPress: () => handlePin(session._id) },
        { text: favoriteLabel, onPress: toggleFavorite },
        { text: 'Mark unread', onPress: markUnread },
        { text: 'Label…', onPress: () => openLabelPicker(session) },
        { text: words.stash, onPress: () => handleStash(session._id) },
        { text: words.kill, style: 'destructive', onPress: () => confirmKill(session._id) },
        { text: 'Cancel', style: 'cancel' },
      ]);
    }
  }, [handlePin, handleStash, confirmKill, openLabelPicker, words]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    setTimeout(() => setRefreshing(false), 1000);
  }, []);

  // Which rows are lit, derived once per list render from the same shared
  // predicate web uses — the phone and the desktop cannot disagree.
  const unreadByConv = useMemo(
    () => sessionUnreadMap(useInboxStore.getState()),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the signature IS the dep
    [unreadSig],
  );

  // Mounting every row at once (the inbox's first paint, a conversation's
  // panel opening) held the screen for a second or more on a long inbox. The
  // first screenful mounts with the list and the rest in a transition right
  // after, which a tap interrupts. listData hands each section what is left.
  const [rowBudget, setRowBudget] = useState(FIRST_PAINT_ROWS);
  useEffect(() => {
    const frame = requestAnimationFrame(() => startTransition(() => setRowBudget(Infinity)));
    return () => cancelAnimationFrame(frame);
  }, []);
  const rowsLeft = useRef(Infinity);

  // A row's times read in minutes ("2m ago"), so rows re-render once a
  // minute; placement itself re-runs on the finer clock.
  const rowMinute = Math.floor(coarseNow / 60_000);

  // Read here once for every row (components/SessionItem InboxRowEnv).
  const reviveByConv = useInboxStore((s) => s.blockedReviveRequestedAt);

  const openRole = useCallback((roleShortId: string) => router.push(`/org/${roleShortId}`), [router]);

  const renderSessionItem = useCallback((s: InboxSession, titleSuffix?: string) => (
    <SwipeableSessionItem
      key={s._id}
      titleSuffix={titleSuffix}
      session={s as SessionData}
      isUnread={!!unreadByConv[s._id]}
      selected={currentId === s._id}
      onPress={openSession}
      onDismiss={handleStash}
      onLongPress={handleSessionLongPress as (session: SessionData) => void}
      awaiting={questionIds.has(s._id)}
      asked={askedByConv.get(String(s._id))}
      roleSessions={roleSessionsByLead.get(s._id)}
      onOpenRole={openRole}
      clock={rowMinute}
      reviveAt={reviveByConv[s._id]}
    />
  ), [openSession, currentId, handleStash, handleSessionLongPress, openRole, rowMinute, reviveByConv, unreadByConv, roleSessionsByLead, questionIds, askedByConv]);

  // Collapsible section — collapse state lives in the shared store's
  // collapsedSections. Grouped-view sections keep their historical label keys;
  // the label/plan/flat views pass web's keys (bucket_<id>, plan_<key>, all) so
  // collapse state round-trips with desktop.
  // `count` is the chokepoint's section count (flat cards plus members nested
  // under a same-bucket lead) — the header number web, the tally and the CLI
  // agree on; items.length is only the flat cards.
  const renderSection = useCallback((label: string, items: InboxSession[], color?: string, collapseKey?: string, count?: number, hosted?: HostedSectionOpts) => {
    if (items.length === 0) return null;
    const key = collapseKey ?? label;
    // A hosted section that never folds (New) ignores a stored fold.
    const collapsed = !hosted?.fixed && !!collapsedSections?.[key];
    const shown = collapsed ? [] : items.slice(0, Math.max(0, rowsLeft.current));
    rowsLeft.current -= shown.length;
    const rows = collapsed ? null : shown.map((row) => renderSessionItem(row, hosted?.suffixes?.get(String(row._id))));
    // One heading for every lens, in the hosted rail's terms: sentence case
    // in the interface face, muted ink, the count beside it, and a dot that
    // carries the section's colour (hosted mode spends it only on what waits
    // on the person). A fixed section (hosted New) never folds.
    const fixed = !!hosted?.fixed;
    const dot = hosted ? (hosted.attention ? Theme.accent : undefined) : color;
    return (
      <RNView key={key}>
        <TouchableOpacity
          style={styles.sectionHeader}
          onPress={fixed ? undefined : () => { void Haptics.selectionAsync(); toggleCollapsedSection(key); }}
          disabled={fixed}
          activeOpacity={0.6}
          accessibilityRole="header"
          accessibilityState={{ expanded: !collapsed }}
        >
          {dot ? <RNView style={[styles.sectionDot, { backgroundColor: dot }]} /> : null}
          <RNText style={styles.sectionTitle}>{label}</RNText>
          <RNText style={styles.sectionCount}>{count ?? items.length}</RNText>
          {fixed ? null : (
            <Feather name={collapsed ? "chevron-right" : "chevron-down"} size={15} color={Theme.textMuted0} style={{ marginLeft: 'auto' }} />
          )}
        </TouchableOpacity>
        {rows}
      </RNView>
    );
  }, [renderSessionItem, collapsedSections, toggleCollapsedSection]);

  const filteredPinned = useMemo(() => chipFilter(pinned), [chipFilter, pinned]);
  const filteredNew = useMemo(() => chipFilter(newSessions), [chipFilter, newSessions]);
  const filteredNeedsInput = useMemo(() => chipFilter(needsInput), [chipFilter, needsInput]);
  const filteredDone = useMemo(() => chipFilter(done), [chipFilter, done]);
  const filteredDormant = useMemo(() => chipFilter(dormant), [chipFilter, dormant]);
  const filteredWorking = useMemo(() => chipFilter(working), [chipFilter, working]);
  const filteredStashed = useMemo(() => chipFilter(stashedSessions), [chipFilter, stashedSessions]);
  const filteredKilled = useMemo(() => chipFilter(dismissedOnly), [chipFilter, dismissedOnly]);

  // Schedules in the inbox (mirrors GlobalSessionPanel). The same per-user
  // webList the badges/dock subscribe to (Convex dedupes), partitioned into one
  // row per armed schedule plus the set of sessions absorbed behind those rows
  // (resting loop homes + uneventful runs). All membership rules live in
  // partitionTriggerInbox. schedules_seen_at is read as a scalar off clientState
  // (never the whole singleton), same as showSubagents.
  // Store-fed (StoreSyncBridge mounts useSyncTriggers): the schedule rows
  // paint from the cached roster at boot instead of waiting a round-trip.
  const { tasks: scheduleTaskRows, ready: schedulesReady } = useTriggers();
  const scheduleTasks = (schedulesReady || scheduleTaskRows.length > 0 ? scheduleTaskRows : undefined) as TaskRow[] | undefined;
  const schedulesSeenAt = useInboxStore((s) => s.clientState?.ui?.schedules_seen_at ?? 0);
  const schedulePartition = useMemo(
    () => partitionTriggerInbox(scheduleTasks, visibleSessions, {
      sessionsWithQueuedMessages,
      seenAt: schedulesSeenAt,
      focusedId: currentSessionId,
    }),
    [scheduleTasks, visibleSessions, sessionsWithQueuedMessages, schedulesSeenAt, currentSessionId],
  );
  // Trigger absorption is no longer a client pass (sync-convergence C5): an
  // armed inject trigger or a live loop parks its home in DORMANT as data
  // (armed_trigger_kind / loop_state reach the shared classifier inside the
  // chokepoint), identically on web, mobile and the server. QUESTIONS renders
  // ahead of Needs Input — same lift web ships; it was missing here.
  const filteredQuestions = useMemo(() => chipFilter(questions), [chipFilter, questions]);
  const statusNeedsInput = filteredNeedsInput;
  const statusDone = filteredDone;
  const statusDormant = filteredDormant;
  const statusWorking = filteredWorking;

  const listData = useMemo(() => {
    rowsLeft.current = rowBudget;
    const sections: React.ReactNode[] = [];
    if (Object.keys(sessions).length === 0) {
      // Skeletons only for a genuinely cold cache: hydration has landed with
      // no rows AND the live subscription hasn't delivered its first payload
      // (undefined = sync hook not mounted yet). Kill-and-reopen hydrates
      // sessions from SQLite before splash hides, so this branch is not
      // taken. Once the live payload has arrived, an empty collection is a
      // real empty account — not an eternal skeleton.
      if (!hydrated || sessionsFirstLoad !== false) {
        return [<SessionListSkeleton key="skeleton" />];
      }
      if (!installCli) {
        // Hosted mode's first run: nothing to install, so the empty inbox
        // offers the assistant (web HostedEmptyState).
        return [(
          <RNView key="empty" style={[styles.emptyInbox, { paddingHorizontal: Spacing.xl }]}>
            <AssistantIntro onStarter={(text) => openNewSession(text)} />
          </RNView>
        )];
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
      // Everything is handled. Hosted mode says so and offers the next thing
      // to ask (the same starters the first-run inbox shows).
      if (hostedMode) {
        return [(
          <RNView key="empty" style={[styles.emptyInbox, { paddingHorizontal: Spacing.xl }]}>
            <AssistantIntro title={words.inboxClearTitle} lede={words.inboxAllClear} onStarter={(text) => openNewSession(text)} />
          </RNView>
        )];
      }
      return [(
        <RNView key="empty" style={styles.emptyInbox}>
          <FontAwesome name="inbox" size={32} color={Theme.textMuted0} />
          <RNText style={styles.emptyText}>{words.inboxClearTitle}</RNText>
          <RNText style={styles.emptySubtext}>{words.inboxAllClear}</RNText>
        </RNView>
      )];
    }
    // Flat views: one "All" run ordered by the shared comparator — "recent"
    // reshuffles on activity, "time" is a stable creation chronology honoring
    // any manual order dragged on desktop.
    if (viewMode === "recent" || viewMode === "time") {
      const flat = flatViewSessions(sortedAll, subsByParent, {
        mode: viewMode,
        showSubagents,
        focusedId: currentSessionId,
        manualOrder: useInboxStore.getState().clientState?.ui?.inbox_manual_order,
        chipMatches,
      });
      return [renderSection("All", flat, Theme.cyan, "all")].filter(Boolean);
    }
    // Label / plan lenses: pinned stays its own top section (pin is urgency,
    // not theme); the active set regroups by label or plan, with unfiled
    // sessions falling to auto-derived project groups — exactly web's layout.
    if (viewMode === "bucket" || viewMode === "plan") {
      const active = [...filteredQuestions, ...filteredNew, ...statusNeedsInput, ...statusDone, ...filteredDormant, ...statusWorking];
      // The names are the mode's words; the collapse keys stay the developer
    // names, which is what the folded state is stored under on every device.
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
    if (hostedOnly) {
      // The Assistant scope's sections, the web rail's (hostedStatusSections):
      // Your move, then Couldn't finish, Working on it, New, Earlier (or
      // Done), and Drafts. The collapse keys are the web's, so a fold
      // round-trips with the desktop.
      const st = useInboxStore.getState();
      const awaiting = awaitingOkIds(st.sessionDecisions);
      const sending = pendingSendIdsOf(st);
      const { asks, stopped } = splitHostedStops(statusNeedsInput, (id) => st.messages[id]);
      const hostedSections = hostedStatusSections(
        { pinned: filteredPinned, questions: filteredQuestions, needsInput: asks, newSessions: filteredNew, working: statusWorking, done: statusDone, dormant: statusDormant },
        (id) => awaiting.has(id), (id) => sending.has(id), (id) => !!unreadByConv[id],
      );
      // Same-name rows get a muted day or time after the title.
      const suffixes = sameNameSuffixes([...hostedSections.flatMap(([rows]) => rows), ...stopped], (row) => hostedRowTitle(st, row._id), coarseNow);
      const anyNew = hostedSections.some(([rows, k]) => k === 'new_results' && rows.length > 0);
      const opts = (key: string, attention = false): HostedSectionOpts => ({ suffixes, attention, fixed: HOSTED_UNFOLDABLE_SECTIONS.has(key) });
      for (const [rows, key] of hostedSections) {
        if (key === 'needs_input') {
          sections.push(renderSection(words.sectionNeedsInput, rows, undefined, 'Needs Input', undefined, opts(key, true)));
          sections.push(renderSection("Couldn't finish", stopped, undefined, 'hosted_stopped', undefined, opts('hosted_stopped')));
        } else if (key === 'pinned') sections.push(renderSection('Pinned', rows, undefined, 'Pinned', undefined, opts(key)));
        else if (key === 'working') sections.push(renderSection(words.sectionWorking, rows, undefined, 'working', undefined, opts(key)));
        else if (key === 'new_results') sections.push(renderSection('New', rows, undefined, 'new_results', undefined, opts(key)));
        else if (key === 'done') sections.push(renderSection(anyNew ? 'Earlier' : 'Done', rows, undefined, 'done', undefined, opts(key)));
        else sections.push(renderSection('Drafts', rows, undefined, 'drafts', undefined, opts(key)));
      }
      return sections.filter(Boolean);
    }
    // Questions lead: a session that asked you something is your move before
    // anything else, pinned or not — same order as the web panel.
    sections.push(renderSection(words.sectionQuestions, filteredQuestions, Theme.violet, "questions"));
    // The header number is the section COUNT while no chip narrows the list
    // and the nested rows are on screen; shared sectionHeaderCount, so this
    // inbox and the web panel can't drift.
    const countOf = (shown: InboxSession[], full: InboxSession[], n: number) =>
      sectionHeaderCount(shown, full, n, showSubagents);
    sections.push(renderSection("Pinned", filteredPinned, Theme.magenta, undefined, countOf(filteredPinned, pinned, placed.counts.pinned)));
    sections.push(renderSection(words.sectionNew, filteredNew, Theme.blue, "New", countOf(filteredNew, newSessions, placed.counts.newSessions)));
    // Top-down "who acts next": you (Needs Input, Done to review), the agent
    // (Working), a machine (Dormant) — same order as the web panel.
    sections.push(renderSection(words.sectionNeedsInput, statusNeedsInput, Theme.accent, "Needs Input", countOf(statusNeedsInput, needsInput, placed.counts.needsInput)));
    sections.push(renderSection("Done", statusDone, Theme.cyan, undefined, countOf(statusDone, done, placed.counts.done)));
    sections.push(renderSection("Working", statusWorking, Theme.greenBright, undefined, countOf(statusWorking, working, placed.counts.working)));
    sections.push(renderSection(words.sectionDormant, statusDormant, Theme.blue, "Dormant", countOf(statusDormant, dormant, placed.counts.dormant)));
    return sections.filter(Boolean);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sessionsSig gates the sessions map; manualOrderKey gates the getState() manual-order read
  }, [activeSessions, sessionsSig, sessionsFirstLoad, hydrated, filteredQuestions, filteredPinned, statusWorking, statusNeedsInput, statusDone, statusDormant, filteredNew, renderSection, viewMode, sortedAll, subsByParent, showSubagents, manualOrderKey, currentSessionId, chipMatches, buckets, bucketByConv, placed.counts, pinned, newSessions, needsInput, done, dormant, working, scheme, installCli, openNewSession, words, hostedOnly, awaitingSig, stopsSig, pendingSendSig, unreadByConv, coarseNow, rowBudget]);

  // Stashed (agent alive, kill-all) and Killed buckets — the web panel's two
  // hidden sections, collapsed by default behind count toggles.
  const ListFooter = useMemo(() => (
    <RNView>
      <TriggerDock
        rows={schedulePartition.rows}
        unreadCount={schedulePartition.unreadCount}
        nextRunAt={schedulePartition.nextRunAt}
      />
      {/* Hosted mode shows the two folded lists only once something is in
          one, so a first run's intro stands alone. */}
      {(!hostedMode || filteredStashed.length + filteredKilled.length > 0) && (
      <RNView style={styles.hiddenToggleRow}>
        <TouchableOpacity
          style={styles.hiddenToggle}
          onPress={() => setShowStashed(prev => !prev)}
          activeOpacity={0.7}
        >
          <FontAwesome name={showStashed ? "chevron-up" : "chevron-down"} size={11} color={Theme.textMuted0} />
          <RNText style={styles.dismissedToggleText}>{words.stashed} <RNText style={styles.sectionCount}>{filteredStashed.length}</RNText></RNText>
        </TouchableOpacity>
        <RNView style={styles.hiddenToggleDivider} />
        <TouchableOpacity
          style={styles.hiddenToggle}
          onPress={() => setShowKilled(prev => !prev)}
          activeOpacity={0.7}
        >
          <FontAwesome name={showKilled ? "chevron-up" : "chevron-down"} size={11} color={Theme.textMuted0} />
          <RNText style={styles.dismissedToggleText}>{words.killed} <RNText style={styles.sectionCount}>{filteredKilled.length}</RNText></RNText>
        </TouchableOpacity>
      </RNView>
      )}
      {showStashed && filteredStashed.length > 0 && (
        <TouchableOpacity
          onPress={() => confirmKillAllStashed(filteredStashed.map(s => s._id))}
          style={styles.killAllBtn}
          activeOpacity={0.7}
        >
          <RNText style={styles.killAllText}>{words.killAllStashed}</RNText>
        </TouchableOpacity>
      )}
      {showStashed && (
        <RNView style={styles.dismissedSection}>
          {filteredStashed.length === 0 ? (
            <RNText style={styles.dismissedEmpty}>{words.noStashed}</RNText>
          ) : (
            filteredStashed.map(s => (
              <HiddenSessionRow
                key={s._id}
                session={s as SessionData}
                variant="stashed"
                onPress={() => openSession(s._id)}
                onRestore={() => handleRestore(s._id)}
                onKill={() => confirmKill(s._id)}
              />
            ))
          )}
        </RNView>
      )}
      {showKilled && (
        <RNView style={styles.dismissedSection}>
          {filteredKilled.length === 0 ? (
            <RNText style={styles.dismissedEmpty}>{words.noKilled}</RNText>
          ) : (
            filteredKilled.slice(0, 100).map(s => (
              <HiddenSessionRow
                key={s._id}
                session={s as SessionData}
                variant="killed"
                onPress={() => openSession(s._id)}
                onRestore={() => handleRestore(s._id)}
              />
            ))
          )}
          {filteredKilled.length > 100 && (
            <RNText style={styles.dismissedEmpty}>+{filteredKilled.length - 100} more</RNText>
          )}
        </RNView>
      )}
    </RNView>
  ), [schedulePartition, showStashed, showKilled, filteredStashed, filteredKilled, openSession, handleRestore, confirmKill, confirmKillAllStashed, scheme, words, hostedMode]);

  // What the inbox is narrowed to, named in the title: a label or a project
  // picked in the slide-out panel. The clear mark beside it goes back to all.
  const filterBucket = activeBucketFilter ? buckets[activeBucketFilter] : undefined;
  const filterName = filterBucket?.name ?? activeProjectFilter ?? null;
  const filterColor = filterBucket ? labelHexColor(filterBucket.name) : activeProjectFilter ? projectColor(activeProjectFilter) : undefined;
  const clearFilter = useCallback(() => {
    void Haptics.selectionAsync();
    setActiveBucketFilter(null);
    setActiveProjectFilter(null);
  }, [setActiveBucketFilter, setActiveProjectFilter]);
  const shownCount = hostedMode ? 0 : filterName ? chipFilter(activeSessions).length : headerCount;

  // Pull-to-reveal: the list opens scrolled past a search row that sits above
  // its first section, so a short pull shows it and a longer one refreshes.
  const SEARCH_REVEAL_HEIGHT = 44;
  const [listHeight, setListHeight] = useState(0);
  const listRef = useRef<ScrollView>(null);
  // contentOffset applies only at mount, before the list is measured, so a
  // short list would open with the search row showing. Tuck it once the list
  // has a height, and again whenever a new filter replaces the rows.
  useEffect(() => {
    if (listHeight > 0 && !searchOpen) listRef.current?.scrollTo({ y: SEARCH_REVEAL_HEIGHT, animated: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-tuck on measure and on a filter change only
  }, [listHeight > 0, activeProjectFilter, activeBucketFilter]);

  return (
    <InboxRowEnvProvider>
    <SafeAreaView style={styles.container} edges={panel ? ['top', 'bottom', 'left'] : ['top']}>
      <RNView style={styles.header}>
        {panel ? <TouchableOpacity
          style={styles.menuBtn}
          onPress={() => { void Haptics.selectionAsync(); onExit?.(); }}
          activeOpacity={0.6}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 4 }}
          accessibilityRole="button"
          accessibilityLabel="Open the full inbox"
        >
          <Feather name="maximize-2" size={19} color={Theme.text} />
        </TouchableOpacity> : <TouchableOpacity
          style={styles.menuBtn}
          onPress={() => { void Haptics.selectionAsync(); setInboxDrawerOpen(true); }}
          activeOpacity={0.6}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 4 }}
          accessibilityRole="button"
          accessibilityLabel="Projects, labels and views"
        >
          <Feather name="menu" size={21} color={Theme.text} />
        </TouchableOpacity>}
        {filterName ? (
          <RNView style={styles.filterTitle}>
            <RNView style={[styles.filterDot, { backgroundColor: filterColor }]} />
            <RNText style={[styles.headerTitle, styles.headerTitleShrink]} numberOfLines={1} onPress={panel ? onExit : () => setInboxDrawerOpen(true)}>{filterName}</RNText>
            {shownCount > 0 && !isSearching && <RNText style={styles.headerCount}>{shownCount}</RNText>}
            <TouchableOpacity onPress={clearFilter} hitSlop={10} accessibilityLabel="Show all sessions">
              <Feather name="x-circle" size={17} color={Theme.textMuted0} />
            </TouchableOpacity>
          </RNView>
        ) : (
          <>
            <RNText style={styles.headerTitle} onPress={panel ? onExit : undefined}>Inbox</RNText>
            {shownCount > 0 && !isSearching && <RNText style={styles.headerCount}>{shownCount}</RNText>}
          </>
        )}
        {/* Title-side badges (counts that link elsewhere) sit here; the
            panel's narrow header moves them down beside the order. */}
        {!isSearching && !panel && <DecisionsBadge />}
        <RNView style={{ flex: 1 }} />
        {/* Hosted mode has one way into search, the field over the list (as
            the web rail has one under the wordmark). */}
        {!searchOpen && !hostedMode && (
          <TouchableOpacity
            style={styles.headerIconBtn}
            onPress={() => setSearchOpen(true)}
            activeOpacity={0.6}
            hitSlop={{ top: 8, bottom: 8, left: 6, right: 6 }}
            accessibilityLabel="Search conversations"
          >
            <Feather name="search" size={19} color={Theme.text} />
          </TouchableOpacity>
        )}
        <ComposeButton />
      </RNView>

      {!isSearching && (panel ? <InboxLensBar stacked accessory={<DecisionsBadge />} /> : <InboxLensBar />)}

      {(searchOpen || searchQuery.length > 0) && (
        <RNView style={styles.searchContainer}>
          <RNView style={styles.searchBarRow}>
            <RNView style={styles.searchInputRow}>
              <FontAwesome name="search" size={14} color={Theme.textMuted0} style={{ marginRight: 8 }} />
              <TextInput
                style={styles.searchInput}
                value={searchQuery}
                onChangeText={handleSearchChange}
                placeholder={words.searchPagePlaceholder}
                placeholderTextColor={Theme.textMuted0}
                returnKeyType="search"
                autoCorrect={false}
                autoCapitalize="none"
                autoFocus
              />
              {searchQuery.length > 0 && (
                <TouchableOpacity onPress={clearSearch} hitSlop={{ top: 14, bottom: 14, left: 14, right: 14 }}>
                  <FontAwesome name="times-circle" size={16} color={Theme.textMuted0} />
                </TouchableOpacity>
              )}
            </RNView>
            <TouchableOpacity onPress={closeSearch} hitSlop={{ top: 10, bottom: 10, left: 6, right: 10 }}>
              <RNText style={styles.searchCancel}>Cancel</RNText>
            </TouchableOpacity>
          </RNView>
        </RNView>
      )}

      {isSearching ? (
        <SearchErrorBoundary resetKey={debouncedQuery}>
          <SearchResults
            query={searchQuery}
            onOpenSession={openSession}
          />
        </SearchErrorBoundary>
      ) : (
        <ScrollView
          ref={listRef}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={Theme.textMuted}
            />
          }
          onLayout={(e) => setListHeight(e.nativeEvent.layout.height)}
          // At least a screen plus the search row tall, so even a short list
          // opens with the row tucked above it.
          contentContainerStyle={[activeSessions.length === 0 ? styles.emptyList : styles.listContent, { minHeight: listHeight + SEARCH_REVEAL_HEIGHT }]}
          contentOffset={searchOpen ? undefined : { x: 0, y: SEARCH_REVEAL_HEIGHT }}
          showsVerticalScrollIndicator={false}
        >
          {!searchOpen && (
            <TouchableOpacity style={styles.searchReveal} onPress={() => setSearchOpen(true)} activeOpacity={0.7}>
              <FontAwesome name="search" size={13} color={Theme.textMuted0} />
              <RNText style={styles.searchRevealText}>Search all conversations</RNText>
            </TouchableOpacity>
          )}
          {listData}
          {ListFooter}
        </ScrollView>
      )}
      {panel && <AreaBar />}

    </SafeAreaView>
    </InboxRowEnvProvider>
  );
}

const styles = themedStyles((Theme, look) => StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Theme.bg,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.lg,
    paddingTop: Spacing.sm,
    paddingBottom: Spacing.sm,
    backgroundColor: Theme.bg,
    gap: 8,
  },
  headerTitle: {
    ...pageTitleFace(look),
    color: Theme.text,
  },
  headerTitleShrink: {
    flexShrink: 1,
  },
  // The open count beside the title: a quiet figure, so the eye goes to the
  // rows that wait rather than the total.
  headerCount: {
    fontSize: 15,
    fontWeight: '500',
    color: Theme.textMuted0,
    fontVariant: ['tabular-nums'],
  },
  menuBtn: {
    width: 32,
    height: 32,
    marginLeft: -6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  filterTitle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    flexShrink: 1,
  },
  filterDot: {
    width: 9,
    height: 9,
    borderRadius: 5,
  },
  headerIconBtn: {
    width: 34,
    height: 30,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerIconBtnActive: {
    backgroundColor: Theme.bg,
  },
  searchBarRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  searchCancel: {
    fontSize: 14,
    color: Theme.blue,
  },
  // The family look draws it as the web rail's search field: a bordered
  // field, left-aligned, in the same 44pt the pull-down reveal hides.
  searchReveal: look === 'family' ? {
    height: 34,
    marginVertical: 5,
    marginHorizontal: Spacing.md,
    paddingHorizontal: 11,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderRadius: 9,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Theme.border,
    backgroundColor: Theme.bgAlt,
  } : {
    height: 44,
    marginHorizontal: Spacing.md,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  searchRevealText: {
    fontSize: 14,
    color: Theme.textMuted0,
  },
  listContent: {
    paddingBottom: Spacing.lg,
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
    gap: 8,
    paddingHorizontal: Spacing.lg,
    paddingTop: 18,
    paddingBottom: 6,
    backgroundColor: Theme.bg,
  },
  sectionDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
  },
  sectionTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: Theme.textMuted,
  },
  sectionCount: {
    fontSize: 13,
    color: Theme.textMuted0,
    fontVariant: ['tabular-nums'],
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
  hiddenToggleDivider: {
    width: StyleSheet.hairlineWidth,
    height: 18,
    backgroundColor: Theme.borderLight,
  },
  killAllBtn: {
    alignSelf: 'center',
    paddingHorizontal: 12,
    paddingVertical: 5,
    marginBottom: Spacing.sm,
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
    flex: 1,
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
}));
