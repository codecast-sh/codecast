import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useActiveTeamFeature } from '@/lib/teamFeatures';
import {
  StyleSheet, FlatList, TouchableOpacity, View as RNView,
  KeyboardAvoidingView, Platform, AppState, Alert, Animated,
} from 'react-native';
import { Text as RNText } from '@/components/Themed';
import * as Haptics from 'expo-haptics';
import { copyToClipboard } from '@/lib/clipboard';
import { setChatFocus, clearChatFocus } from '@/lib/chatFocus';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter, Stack, useFocusEffect } from 'expo-router';
import { useMutation } from 'convex/react';
import { api } from '@codecast/convex/convex/_generated/api';
import { useInboxStore, selectChannelReadMarker } from '@codecast/web/store/inboxStore';
import { useChannelMessages, useChannelMessagesSync, useChatRail, useSupersededChannelId } from '@codecast/web/hooks/useChatSync';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import { Theme, Spacing, themedStyles, useTheme } from '@/constants/Theme';
import { authorGroupKey, buildChatTimeline, dmOtherIds, memberHandle } from '@codecast/shared/chat';
import { channelHuddleMemberIds, chatRoomKey } from '@codecast/shared/contracts';
import { HuddleButton } from '@/components/calls/SessionHuddleButton';
import { MessageRow, DayDivider, NewDivider, ChatAvatar, fromChatView, type MobileChatMessage } from '@/components/chat/MessageRow';
import { type MentionCandidate } from '@/components/chat/MentionStrip';
import { useSessionIdentityLookup } from '@/components/identity';
import { ChatComposerBar } from '@/components/chat/ChatComposerBar';
import { MessageActionsSheet, type MessageAction } from '@/components/chat/MessageActionsSheet';
import { ImageViewer } from '@/components/chat/ImageViewer';
import { TypingRow } from '@/components/chat/TypingRow';
import type { ChatAttachmentArg } from '@/components/chat/chatUpload';

// One channel. An inverted FlatList (the only scroll model that keeps a chat
// pinned to the newest message on mobile without fighting the keyboard), the
// shared timeline rules for grouping and the unread rule, and a composer with
// optimistic sends: the row appears the moment you tap send, dims while in
// flight, and turns loudly red if the server refuses it.
//
// READS ARE HONEST. The read mark advances only while this screen is focused
// AND the app is foregrounded — the same presence rule the web page enforces.
// A push that merely mounts this screen in the background must never eat the
// unread state the person came to see.

export default function ChatChannelScreen() {
  const Theme = useTheme();
  const { id, m: targetParam } = useLocalSearchParams<{ id: string; m?: string }>();
  // A DM opened this tick has a stub id; once the server row lands the stub
  // is gone and its forwarding address is the real room.
  const superseded = useSupersededChannelId(id);
  const channelId = (superseded ?? id) as string;
  const router = useRouter();

  // LOCAL FIRST. Everything this screen draws is read from the store, which
  // is persisted: the channel's cached page, its reactions, the roster and
  // the rail paint on the first frame. useChannelMessagesSync is only the
  // feeder (live newest page, older pages on demand), and every gesture is a
  // store action that paints before the server hears of it.
  const currentUser = useInboxStore((s) => s.currentUser) as any;
  const viewerId = currentUser?._id ? String(currentUser._id) : '';

  // Chat is a per-team opt-in; a deep link into an off team's channel must
  // not subscribe (the server refuses). Unknown (cold) still feeds: the
  // feeder never throws, and the cached page is already on screen.
  const chatOn = useActiveTeamFeature("chat");
  const feed = useChannelMessagesSync(chatOn === false ? undefined : channelId);
  const views = useChannelMessages(channelId, feed.floor);
  const channel = useInboxStore((s) => s.chatChannels[channelId]) as any;
  const railRow = useChatRail().find((c) => c.id === channelId);
  const teamMembers = useInboxStore((s) => s.teamMembers) as any[];
  const memberById = useMemo(() => {
    const map = new Map<string, any>();
    for (const m of teamMembers ?? []) if (m) map.set(String(m._id), m);
    return map;
  }, [teamMembers]);

  // Completion candidates carry the SAME handles the server resolves
  // (memberHandle) — a handle the strip offers is a handle a send will honour.
  const mentionCandidates = useMemo<MentionCandidate[]>(() => {
    const out: MentionCandidate[] = [];
    for (const m of teamMembers ?? []) {
      if (!m) continue;
      const handle = memberHandle(m as any);
      if (!handle) continue;
      out.push({
        id: String(m._id),
        handle,
        name: m.name || handle,
        avatarUrl: (m as any).github_avatar_url || (m as any).image || undefined,
        isAgent: (m as any).is_bot,
      });
    }
    return out;
  }, [teamMembers]);

  // The gate for rendered mentions: exactly the handles the strip offers and
  // the server resolves. One vocabulary end to end.
  const knownHandles = useMemo(
    () => new Set(mentionCandidates.map((c) => c.handle.toLowerCase())),
    [mentionCandidates],
  );

  const [sheetTarget, setSheetTarget] = useState<MobileChatMessage | null>(null);
  const [editing, setEditing] = useState<{ messageId: string; content: string } | null>(null);
  const [viewerUri, setViewerUri] = useState<string | null>(null);
  const [highlightId, setHighlightId] = useState<string | null>(null);

  const stopAnchor = useMutation(api.chat.stopAnchorReply);

  // The unread rule renders against the read mark AS IT WAS when the screen
  // opened. The live mark advances while you read — computing against it would
  // erase your place mid-scroll. Frozen once the room resolves (the cached rail
  // usually holds it on the first frame).
  const entryReadAtRef = useRef<{ channelId: string; at: number | undefined } | null>(null);
  if (railRow && entryReadAtRef.current?.channelId !== channelId) {
    entryReadAtRef.current = { channelId, at: railRow.lastReadAt ?? 0 };
  }

  // A coarse clock: drives the thinking row's elapsed seconds without
  // re-rendering the list more than once a second, and only while needed.
  const [now, setNow] = useState(() => Date.now());
  const anyThinking = views.some(
    (m) => m.agentStatus === 'thinking' || m.agentStatus === 'streaming'
      || m.threadAgentStatus === 'thinking' || m.threadAgentStatus === 'streaming',
  );
  useEffect(() => {
    if (!anyThinking) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [anyThinking]);

  // ── Honest reading ────────────────────────────────────────────────────────
  // Focused screen + foregrounded app = the person is looking. Only then does
  // the newest message advance their mark (and silence their phone). The
  // mark is the newest row in the ROOM, replies included, so a badge a thread
  // reply raised clears too (web's rule).
  const focusedRef = useRef(false);
  const appActiveRef = useRef(AppState.currentState === 'active');
  const newestId = views.at(-1)?.id;
  const markIfPresent = useCallback(() => {
    if (!focusedRef.current || !appActiveRef.current) return;
    const state = useInboxStore.getState();
    const marker = selectChannelReadMarker(state as any, channelId);
    if (marker) state.markChannelRead(channelId, marker._id);
  }, [channelId]);
  useFocusEffect(
    useCallback(() => {
      focusedRef.current = true;
      setChatFocus({ channelId: String(channelId) });
      markIfPresent();
      return () => {
        focusedRef.current = false;
        clearChatFocus();
      };
    }, [markIfPresent, channelId]),
  );
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      appActiveRef.current = s === 'active';
      if (s === 'active') markIfPresent();
    });
    return () => sub.remove();
  }, [markIfPresent]);
  useEffect(() => { markIfPresent(); }, [newestId, markIfPresent]);

  // Sends paint in this tick (the store's send action writes the row and
  // journals the mutation); a refused send turns the row red with Retry.
  const onSend = useCallback((content: string, attachments: ChatAttachmentArg[]) => {
    useInboxStore.getState().sendChatMessage(channelId, content, {
      attachments: attachments.length ? (attachments as any) : undefined,
    });
  }, [channelId]);

  const onSubmitEdit = useCallback((messageId: string, content: string) => {
    useInboxStore.getState().editChatMessage(messageId, content);
  }, []);

  const onRetrySend = useCallback((rowId: string) => {
    useInboxStore.getState().retryChatSend(rowId);
  }, []);

  const toggleReaction = useCallback((messageId: string, emoji: string) => {
    useInboxStore.getState().toggleChatReaction(messageId, emoji);
  }, []);

  const loadingOlder = feed.isLoadingOlder;
  const loadOlder = useCallback(() => {
    if (feed.hasMoreAbove) feed.loadOlder();
  }, [feed]);

  const identityFor = useSessionIdentityLookup();
  const chatMessages = useInboxStore.getState().chatMessages;

  // The shared views, folded through the SAME timeline rules the web uses.
  const rows = useMemo(() => {
    const all = views.map((v) => fromChatView(v, chatMessages[v.id], identityFor));
    return buildChatTimeline(
      all.map((msg) => ({
        id: msg.id,
        authorId: msg.author.id,
        groupKey: authorGroupKey(msg.author),
        createdAt: msg.createdAt,
        pendingAgent: msg.agentStatus === 'thinking' || msg.agentStatus === 'streaming',
        deleted: !!msg.deletedAt,
        view: msg,
      })),
      { now, lastReadAt: entryReadAtRef.current?.at, viewerId },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [views, identityFor, now, viewerId]);

  // Inverted list: index 0 renders at the bottom, so the rows reverse.
  const inverted = useMemo(() => [...rows].reverse(), [rows]);

  // ── Deep-link target (?m=<messageId>) ─────────────────────────────────────
  // A push or a web permalink names a message. A reply forwards to its thread;
  // a channel row scrolls into view and flashes. Bounded search: the pages the
  // store holds plus up to three older ones — past that the link degrades to
  // "the channel".
  const listRef = useRef<FlatList>(null);
  const targetTriesRef = useRef(0);
  const doneTargetRef = useRef<string | null>(null);
  useEffect(() => {
    const target = typeof targetParam === 'string' ? targetParam : undefined;
    if (!target || doneTargetRef.current === target) return;
    // The store first: a cached or prefetched row answers without a page.
    const row = useInboxStore.getState().chatMessages[target] as any;
    if (row?.thread_root_id) {
      doneTargetRef.current = target;
      router.replace({
        pathname: '/chat/thread/[id]',
        params: { id: String(row.thread_root_id), channel: String(channelId), m: target },
      } as never);
      return;
    }
    const index = inverted.findIndex((it: any) => it.kind === 'message' && it.message?.id === target);
    if (index >= 0) {
      doneTargetRef.current = target;
      setHighlightId(target);
      // The inverted list already opens at the newest line. Centering a
      // notification that named that line is a scroll away from the bottom
      // and back — skip it. A permalink into history still jumps.
      if (index > 2) {
        setTimeout(() => listRef.current?.scrollToIndex({ index, viewPosition: 0.5, animated: true }), 250);
      }
      setTimeout(() => setHighlightId(null), 3200);
      return;
    }
    if (feed.loading) return;
    if (targetTriesRef.current < 3 && feed.hasMoreAbove && !loadingOlder) {
      targetTriesRef.current += 1;
      loadOlder();
    } else if (!loadingOlder) {
      // Give up quietly: the person is in the right room, which is the point.
      doneTargetRef.current = target;
    }
  }, [targetParam, inverted, feed.loading, feed.hasMoreAbove, loadOlder, loadingOlder, router, channelId]);

  // ── Scroll pill ───────────────────────────────────────────────────────────
  // Away from the newest message, a pill offers the way back — and counts what
  // arrived while you were up in history.
  const [awayFromBottom, setAwayFromBottom] = useState(false);
  const missedBaseRef = useRef<string | undefined>(undefined);
  const [missed, setMissed] = useState(0);
  useEffect(() => {
    if (!awayFromBottom) { setMissed(0); missedBaseRef.current = newestId ? String(newestId) : undefined; return; }
    if (!newestId) return;
    if (missedBaseRef.current !== String(newestId)) setMissed((n) => n + 1);
    missedBaseRef.current = String(newestId);
  }, [awayFromBottom, newestId]);
  const onScroll = useCallback((e: any) => {
    const y = e.nativeEvent.contentOffset.y;
    setAwayFromBottom(y > 480);
  }, []);
  const jumpToNow = useCallback(() => {
    listRef.current?.scrollToOffset({ offset: 0, animated: true });
  }, []);

  // ── Long-press sheet ──────────────────────────────────────────────────────
  const onLongPress = useCallback((message: MobileChatMessage) => {
    if (message.pending || message.failed || message.deletedAt) return;
    if (Platform.OS === 'ios') void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setSheetTarget(message);
  }, []);

  // Object form + cast: the typed-route union regenerates only when Metro runs.
  const pushThread = useCallback((rootId: string) => {
    router.push({
      pathname: '/chat/thread/[id]',
      params: { id: rootId, channel: String(channelId) },
    } as never);
  }, [router, channelId]);

  const onSheetAction = useCallback((action: MessageAction) => {
    const message = sheetTarget;
    if (!message) return;
    if (action.kind === 'react') {
      toggleReaction(message.id, action.emoji);
    } else if (action.kind === 'reply') {
      pushThread(message.id);
    } else if (action.kind === 'copy') {
      copyToClipboard(message.content);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } else if (action.kind === 'edit') {
      setEditing({ messageId: message.id, content: message.content });
    } else if (action.kind === 'delete') {
      Alert.alert('Delete message?', 'It will show as deleted for everyone.', [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete', style: 'destructive', onPress: () => useInboxStore.getState().deleteChatMessage(message.id) },
      ]);
    }
  }, [sheetTarget, toggleReaction, pushThread]);

  const renderItem = useCallback(({ item }: { item: (typeof rows)[number] }) => {
    if (item.kind === 'day') return <DayDivider label={item.label} />;
    if (item.kind === 'new') return <NewDivider />;
    const view = (item.message as any).view as MobileChatMessage;
    return (
      <RNView style={view.id === highlightId ? styles.highlight : undefined}>
        <MessageRow
          message={view}
          grouped={item.grouped}
          now={now}
          knownMentionHandles={knownHandles}
          onOpenThread={pushThread}
          onLongPress={onLongPress}
          onToggleReaction={toggleReaction}
          onStopAgent={(mid) => void stopAnchor({ message_id: mid as any })}
          onRetrySend={onRetrySend}
          onOpenImage={setViewerUri}
        />
      </RNView>
    );
  }, [now, highlightId, knownHandles, pushThread, onLongPress, toggleReaction, stopAnchor, onRetrySend]);

  // ── Header identity ───────────────────────────────────────────────────────
  const isDm = channel?.kind === 'dm';
  const dmOthers = useMemo(
    () => (isDm ? dmOtherIds(channel?.dm_key, viewerId) : []),
    [isDm, channel?.dm_key, viewerId],
  );
  const counterpart = dmOthers.length === 1 ? memberById.get(dmOthers[0]) : undefined;
  const roomName = (() => {
    if (!isDm) return channel?.name ?? 'channel';
    if (dmOthers.length === 0) return 'Direct message';
    const names = dmOthers.map((uid) => {
      const m = memberById.get(uid);
      return m?.name || m?.github_username || 'Teammate';
    });
    return dmOthers.length > 1 ? names.map((n) => n.split(/\s+/)[0]).join(', ') : names[0];
  })();
  const presence = counterpart?.presence_state as string | undefined;
  const presenceColor =
    presence === 'active' ? Theme.green : presence === 'idle' ? Theme.accent : Theme.textMuted0;
  const presenceLabel =
    presence === 'active' ? 'Active now' : presence === 'idle' ? 'Idle' : presence === 'away' ? 'Away' : 'Offline';

  const nameOf = useCallback((uid: string) => {
    const m = memberById.get(uid);
    return m?.name?.split(/\s+/)[0] || m?.github_username || '';
  }, [memberById]);

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <Stack.Screen options={{ headerShown: false }} />
      <RNView style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={10} style={styles.back}>
          <FontAwesome name="chevron-left" size={16} color={Theme.textMuted} />
        </TouchableOpacity>
        {isDm && counterpart ? (
          <ChatAvatar
            author={{
              id: String(counterpart._id),
              name: roomName,
              avatarUrl: counterpart.github_avatar_url || counterpart.image,
              isAgent: counterpart.is_bot,
            }}
            size={22}
          />
        ) : (
          <FontAwesome
            name={isDm ? 'user' : channel?.is_private || channel?.kind === 'private' ? 'lock' : 'hashtag'}
            size={13}
            color={Theme.textMuted0}
          />
        )}
        <RNView style={styles.headMain}>
          <RNText style={styles.title} numberOfLines={1}>{roomName}</RNText>
          {isDm && counterpart ? (
            <RNView style={styles.presenceRow}>
              <RNView style={[styles.presenceDot, { backgroundColor: presenceColor }]} />
              <RNText style={styles.presenceText}>{presenceLabel}</RNText>
            </RNView>
          ) : channel?.topic ? (
            <RNText style={styles.topic} numberOfLines={1}>{channel.topic}</RNText>
          ) : null}
        </RNView>
        {channel && channel.kind !== 'community' && (
          <HuddleButton
            roomKey={chatRoomKey({
              id: channelId,
              kind: channel.kind,
              otherIds: dmOthers,
              viewerId,
              teammateIds: [...memberById.keys()],
            })}
            teamId={channel.team_id ? String(channel.team_id) : null}
            ring={isDm ? dmOthers : undefined}
            channelMemberCount={channelHuddleMemberIds(channel.kind, railRow?.memberIds, teamMembers)?.length}
            anchorTitle={isDm ? (dmOthers.length > 1 ? `with ${roomName}` : undefined) : `#${channel.name}`}
          />
        )}
      </RNView>

      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={0}
      >
        <RNView style={styles.listWrap}>
          <FlatList
            ref={listRef}
            inverted
            data={inverted}
            keyExtractor={(item) => item.key}
            renderItem={renderItem}
            onEndReached={loadOlder}
            onEndReachedThreshold={0.4}
            onScroll={onScroll}
            scrollEventThrottle={120}
            onScrollToIndexFailed={() => {}}
            ListFooterComponent={
              loadingOlder ? (
                <RNText style={styles.loadingOlder}>Loading earlier messages…</RNText>
              ) : null
            }
            ListEmptyComponent={
              // A cold cache waits for the first page; a room the rail attests
              // is empty, or one the server has answered for, says so at once.
              feed.loading && !railRow?.knownEmpty ? null : (
                <RNView style={styles.emptyWrap}>
                  {/* Fabric's inverted list leaves empty/footer components
                      untransformed — no counter-flip (verified on device). */}
                  <RNView>
                    <RNText style={styles.emptyTitle}>{isDm ? roomName : `#${channel?.name ?? 'channel'}`} is quiet</RNText>
                    <RNText style={styles.emptySub}>Say something to start it off.</RNText>
                  </RNView>
                </RNView>
              )
            }
            contentContainerStyle={inverted.length === 0 ? styles.emptyList : undefined}
            keyboardDismissMode="interactive"
            keyboardShouldPersistTaps="always"
          />
          {awayFromBottom && (
            <TouchableOpacity style={styles.jumpPill} onPress={jumpToNow} activeOpacity={0.85}>
              <FontAwesome name="chevron-down" size={11} color={Theme.bg} />
              {missed > 0 && <RNText style={styles.jumpCount}>{missed > 99 ? '99+' : missed}</RNText>}
            </TouchableOpacity>
          )}
        </RNView>

        <TypingRow channelId={String(channelId)} viewerId={viewerId} nameOf={nameOf} />
        <ChatComposerBar
          channelId={String(channelId)}
          placeholder={isDm ? `Message ${roomName}` : `Message #${channel?.name ?? ''}`}
          mentionCandidates={mentionCandidates}
          editing={editing}
          onCancelEdit={() => setEditing(null)}
          onSubmitEdit={onSubmitEdit}
          onSend={onSend}
        />
      </KeyboardAvoidingView>

      <MessageActionsSheet
        message={sheetTarget}
        own={sheetTarget?.author.id === viewerId}
        canReply
        onAction={onSheetAction}
        onClose={() => setSheetTarget(null)}
      />
      <ImageViewer uri={viewerUri} onClose={() => setViewerUri(null)} />
    </SafeAreaView>
  );
}

const styles = themedStyles((Theme) => StyleSheet.create({
  container: { flex: 1, backgroundColor: Theme.bg },
  flex: { flex: 1 },
  listWrap: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: Spacing.md,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Theme.border + '55',
  },
  back: { paddingRight: 4 },
  headMain: { flex: 1, minWidth: 0 },
  title: { fontSize: 15, fontWeight: '600', color: Theme.text },
  topic: { fontSize: 11, color: Theme.textMuted0 },
  presenceRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 1 },
  presenceDot: { width: 6, height: 6, borderRadius: 3 },
  presenceText: { fontSize: 10.5, color: Theme.textMuted0 },
  loadingOlder: {
    textAlign: 'center',
    fontSize: 11,
    color: Theme.textMuted0,
    paddingVertical: 8,
  },
  emptyWrap: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  emptyList: { flexGrow: 1 },
  emptyTitle: { fontSize: 14, fontWeight: '600', color: Theme.textSecondary, textAlign: 'center' },
  emptySub: { fontSize: 12, color: Theme.textMuted0, textAlign: 'center', marginTop: 4 },
  highlight: { backgroundColor: Theme.accent + '1E' },
  jumpPill: {
    position: 'absolute',
    right: 14,
    bottom: 12,
    minWidth: 34,
    height: 34,
    borderRadius: 17,
    paddingHorizontal: 10,
    backgroundColor: Theme.blue,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    shadowColor: '#000',
    shadowOpacity: 0.25,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 4,
  },
  jumpCount: { fontSize: 11, fontWeight: '700', color: Theme.bg },
}));
