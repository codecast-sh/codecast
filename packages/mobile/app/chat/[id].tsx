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
import { useQuery, useMutation, useConvex } from 'convex/react';
import { api } from '@codecast/convex/convex/_generated/api';
import type { Id } from '@codecast/convex/convex/_generated/dataModel';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import { Theme, Spacing } from '@/constants/Theme';
import { buildChatTimeline, dmOtherIds, memberHandle } from '@codecast/shared/chat';
import { chatRoomKey } from '@codecast/shared/contracts';
import { HuddleButton } from '@/components/calls/SessionHuddleButton';
import { MessageRow, DayDivider, NewDivider, ChatAvatar, type MobileChatMessage } from '@/components/chat/MessageRow';
import { type MentionCandidate } from '@/components/chat/MentionStrip';
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

type PendingSend = {
  clientId: string;
  content: string;
  createdAt: number;
  threadRootId?: string;
  attachments?: ChatAttachmentArg[];
  failed?: boolean;
};

export default function ChatChannelScreen() {
  const { id, m: targetParam } = useLocalSearchParams<{ id: string; m?: string }>();
  const channelId = id as Id<'chat_channels'>;
  const router = useRouter();
  const convex = useConvex();

  const currentUser = useQuery(api.users.getCurrentUser);
  const viewerId = currentUser?._id ? String(currentUser._id) : '';

  // Chat is a per-team opt-in; a deep link into an off team's channel must
  // not subscribe (the server refuses, and a thrown query drops the screen).
  const chatOn = useActiveTeamFeature("chat");
  // Channel meta + roster come from queries this screen's tab already warmed.
  const channelData = useQuery(api.chat.listChannels, chatOn ? {} : 'skip');
  const channel = useMemo(
    () => (channelData?.channels as any[] | undefined)?.find((c) => String(c._id) === String(channelId)),
    [channelData, channelId],
  );
  const teamMembers = useQuery(
    api.teams.getTeamMembers,
    channel ? { team_id: channel.team_id } : 'skip',
  );
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

  // Head page stays live via the subscription; older pages accumulate below it.
  const head = useQuery(api.chat.listMessages, chatOn ? { channel_id: channelId, limit: 60 } : 'skip');
  // Names for authors the roster no longer carries (departed members): the
  // query's own authors map, so old messages never degrade to "Teammate".
  const authorById = useMemo(() => {
    const map = new Map<string, any>();
    for (const a of ((head?.authors as any[]) ?? [])) map.set(String(a._id), a);
    return map;
  }, [head?.authors]);

  const [older, setOlder] = useState<any[]>([]);
  const [olderCursor, setOlderCursor] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);

  const [pending, setPending] = useState<PendingSend[]>([]);
  const [sheetTarget, setSheetTarget] = useState<MobileChatMessage | null>(null);
  const [editing, setEditing] = useState<{ messageId: string; content: string } | null>(null);
  const [viewerUri, setViewerUri] = useState<string | null>(null);
  const [highlightId, setHighlightId] = useState<string | null>(null);

  const sendMessage = useMutation(api.chat.sendMessage);
  const editMessage = useMutation(api.chat.editMessage);
  const markRead = useMutation(api.chat.markRead);
  const toggleReaction = useMutation(api.chat.toggleReaction);
  const stopAnchor = useMutation(api.chat.stopAnchorReply);
  const deleteMessage = useMutation(api.chat.deleteMessage);

  // The unread rule renders against the read mark AS IT WAS when the screen
  // opened. The live mark advances while you read — computing against it would
  // erase your place mid-scroll.
  const entryReadAtRef = useRef<number | undefined>(undefined);
  const readsReady = channelData !== undefined;
  if (entryReadAtRef.current === undefined && readsReady) {
    const read = (channelData?.reads as any[] | undefined)?.find(
      (r) => String(r.channel_id) === String(channelId),
    );
    entryReadAtRef.current = read?.last_read_at ?? 0;
  }

  // A coarse clock: drives the thinking row's elapsed seconds without
  // re-rendering the list more than once a second, and only while needed.
  const [now, setNow] = useState(() => Date.now());
  const anyThinking = (head?.messages as any[] | undefined)?.some(
    (m) => m.agent_status === 'thinking' || m.agent_status === 'streaming',
  ) || (head?.threads as any[] | undefined)?.some(
    (t) => t.agent_status === 'thinking' || t.agent_status === 'streaming',
  );
  useEffect(() => {
    if (!anyThinking) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [anyThinking]);

  // ── Honest reading ────────────────────────────────────────────────────────
  // Focused screen + foregrounded app = the person is looking. Only then does
  // the newest message advance their mark (and silence their phone).
  const focusedRef = useRef(false);
  const appActiveRef = useRef(AppState.currentState === 'active');
  const newestId = (head?.messages as any[] | undefined)?.at(-1)?._id;
  const newestIdRef = useRef<string | undefined>(undefined);
  newestIdRef.current = newestId ? String(newestId) : undefined;
  const markIfPresent = useCallback(() => {
    if (!focusedRef.current || !appActiveRef.current || !newestIdRef.current) return;
    markRead({ channel_id: channelId, last_read_message_id: newestIdRef.current as any }).catch(() => {});
  }, [channelId, markRead]);
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

  // Sends that echoed back from the server leave the pending list.
  const echoedClientIds = useMemo(() => {
    const set = new Set<string>();
    for (const m of (head?.messages as any[]) ?? []) if (m.client_id) set.add(m.client_id);
    return set;
  }, [head?.messages]);
  useEffect(() => {
    if (echoedClientIds.size === 0) return;
    setPending((prev) => prev.filter((p) => !echoedClientIds.has(p.clientId)));
  }, [echoedClientIds]);

  const doSend = useCallback(async (entry: PendingSend) => {
    try {
      await sendMessage({
        channel_id: channelId,
        content: entry.content,
        client_id: entry.clientId,
        ...(entry.attachments?.length ? { attachments: entry.attachments as any } : {}),
        ...(entry.threadRootId ? { thread_root_id: entry.threadRootId as any } : {}),
      });
    } catch {
      // The row turns red and offers Retry — a message must never look sent
      // when it was not, and must never silently vanish.
      setPending((prev) => prev.map((p) => (p.clientId === entry.clientId ? { ...p, failed: true } : p)));
    }
  }, [channelId, sendMessage]);

  const onSend = useCallback((content: string, attachments: ChatAttachmentArg[]) => {
    const entry: PendingSend = {
      clientId: `mob-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      content,
      createdAt: Date.now(),
      attachments: attachments.length ? attachments : undefined,
    };
    setPending((prev) => [...prev, entry]);
    void doSend(entry);
  }, [doSend]);

  const onSubmitEdit = useCallback((messageId: string, content: string) => {
    void editMessage({ message_id: messageId as any, content }).catch(() => {
      Alert.alert('Edit failed', 'The message kept its previous text.');
    });
  }, [editMessage]);

  const onRetrySend = useCallback((id: string) => {
    setPending((prev) => prev.map((p) => (`pend-${p.clientId}` === id ? { ...p, failed: false } : p)));
    const entry = pending.find((p) => `pend-${p.clientId}` === id);
    if (entry) void doSend({ ...entry, failed: false });
  }, [pending, doSend]);

  const loadOlder = useCallback(async () => {
    if (loadingOlder || !head || !head.has_more) return;
    setLoadingOlder(true);
    try {
      const page = await convex.query(api.chat.listMessages, {
        channel_id: channelId,
        limit: 60,
        cursor: (olderCursor ?? head.next_cursor) as any,
      });
      setOlder((prev) => [...(page.messages as any[]), ...prev]);
      setOlderCursor(page.next_cursor);
    } finally {
      setLoadingOlder(false);
    }
  }, [convex, channelId, head, olderCursor, loadingOlder]);

  // Reaction rows aggregate per message: emoji → count + whether mine.
  const reactionsByMessage = useMemo(() => {
    const map = new Map<string, { emoji: string; count: number; mine: boolean }[]>();
    for (const r of ((head?.reactions as any[]) ?? [])) {
      const key = String(r.message_id);
      const list = map.get(key) ?? [];
      const existing = list.find((x) => x.emoji === r.emoji);
      if (existing) {
        existing.count += 1;
        existing.mine = existing.mine || String(r.user_id) === viewerId;
      } else {
        list.push({ emoji: r.emoji, count: 1, mine: String(r.user_id) === viewerId });
      }
      map.set(key, list);
    }
    return map;
  }, [head?.reactions, viewerId]);

  const threadByRoot = useMemo(() => {
    const map = new Map<string, any>();
    for (const t of ((head?.threads as any[]) ?? [])) map.set(String(t.root_id), t);
    return map;
  }, [head?.threads]);

  const toView = useCallback((msg: any): MobileChatMessage => {
    const member = memberById.get(String(msg.user_id));
    const thread = threadByRoot.get(String(msg._id));
    return {
      id: String(msg._id),
      author: {
        id: String(msg.user_id),
        name: member?.name || authorById.get(String(msg.user_id))?.name
          || (msg.author_kind === 'agent' ? 'Anchor' : 'Teammate'),
        avatarUrl: member?.github_avatar_url || member?.image || undefined,
        isAgent: msg.author_kind === 'agent' || member?.is_bot,
      },
      content: msg.content,
      createdAt: msg.created_at,
      editedAt: msg.edited_at,
      deletedAt: msg.deleted_at,
      mentionsMe: (msg.mentions ?? []).some((x: any) => String(x) === viewerId) || msg.mention_scope === 'here',
      agentStatus: msg.agent_status,
      agentDeadlineAt: msg.agent_deadline_at,
      attachments: msg.attachments?.length ? msg.attachments : undefined,
      reactions: reactionsByMessage.get(String(msg._id)),
      thread: thread
        ? {
            replyCount: thread.reply_count,
            replyCapped: thread.reply_capped,
            lastReplyAt: thread.last_reply_at,
            agentStatus: thread.agent_status,
          }
        : undefined,
    };
  }, [memberById, authorById, viewerId, reactionsByMessage, threadByRoot]);

  // Older pages + live head + optimistic sends, ascending, folded through the
  // SAME timeline rules the web uses.
  const rows = useMemo(() => {
    const serverRows = [...older, ...((head?.messages as any[]) ?? [])].map(toView);
    const pendingRows: MobileChatMessage[] = pending.map((p) => ({
      id: `pend-${p.clientId}`,
      author: {
        id: viewerId,
        name: currentUser?.name || 'You',
        avatarUrl: (currentUser as any)?.github_avatar_url || (currentUser as any)?.image,
      },
      content: p.content,
      createdAt: p.createdAt,
      attachments: p.attachments?.map((a) => ({ storage_id: a.storage_id })),
      pending: !p.failed,
      failed: p.failed,
    }));
    const all = [...serverRows, ...pendingRows];
    return buildChatTimeline(
      all.map((msg) => ({
        id: msg.id,
        authorId: msg.author.id,
        createdAt: msg.createdAt,
        pendingAgent: msg.agentStatus === 'thinking' || msg.agentStatus === 'streaming',
        deleted: !!msg.deletedAt,
        view: msg,
      })),
      { now, lastReadAt: entryReadAtRef.current, viewerId },
    );
  }, [older, head?.messages, pending, toView, now, viewerId, currentUser]);

  // Inverted list: index 0 renders at the bottom, so the rows reverse.
  const inverted = useMemo(() => [...rows].reverse(), [rows]);

  // ── Deep-link target (?m=<messageId>) ─────────────────────────────────────
  // A push or a web permalink names a message. A reply forwards to its thread;
  // a channel row scrolls into view and flashes. Bounded search: the head page
  // plus up to three older pages — past that the link degrades to "the channel".
  const listRef = useRef<FlatList>(null);
  const targetTriesRef = useRef(0);
  const doneTargetRef = useRef<string | null>(null);
  useEffect(() => {
    const target = typeof targetParam === 'string' ? targetParam : undefined;
    if (!target || doneTargetRef.current === target || !head) return;
    const inHead = [...older, ...((head.messages as any[]) ?? [])].find((r) => String(r._id) === target);
    if (inHead?.thread_root_id) {
      doneTargetRef.current = target;
      router.replace({
        pathname: '/chat/thread/[id]',
        params: { id: String(inHead.thread_root_id), channel: String(channelId), m: target },
      } as never);
      return;
    }
    if (inHead) {
      doneTargetRef.current = target;
      const index = inverted.findIndex((it: any) => it.kind === 'message' && it.message?.id === target);
      if (index >= 0) {
        setHighlightId(target);
        setTimeout(() => listRef.current?.scrollToIndex({ index, viewPosition: 0.5, animated: true }), 250);
        setTimeout(() => setHighlightId(null), 3200);
      }
      return;
    }
    if (targetTriesRef.current < 3 && head.has_more && !loadingOlder) {
      targetTriesRef.current += 1;
      void loadOlder();
    } else {
      // Give up quietly: the person is in the right room, which is the point.
      doneTargetRef.current = target;
    }
  }, [targetParam, head, older, inverted, loadOlder, loadingOlder, router, channelId]);

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
      void toggleReaction({ message_id: message.id as any, emoji: action.emoji });
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
        { text: 'Delete', style: 'destructive', onPress: () => void deleteMessage({ message_id: message.id as any }) },
      ]);
    }
  }, [sheetTarget, toggleReaction, pushThread, deleteMessage]);

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
          onToggleReaction={(mid, emoji) => void toggleReaction({ message_id: mid as any, emoji })}
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
        {/* Every room can huddle: a DM or group thread rings its people, a
            channel is an open door (same keys web's chips use). */}
        {channel && (
          <HuddleButton
            roomKey={chatRoomKey({
              id: String(channel._id),
              kind: channel.kind,
              otherIds: dmOthers,
              viewerId,
              teammateIds: [...memberById.keys()],
            })}
            teamId={channel.team_id ? String(channel.team_id) : null}
            ring={isDm ? dmOthers : undefined}
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
              head === undefined ? null : (
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

const styles = StyleSheet.create({
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
});
