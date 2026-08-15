import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  StyleSheet, FlatList, TouchableOpacity, View as RNView,
  KeyboardAvoidingView, Platform, ActionSheetIOS, Clipboard,
} from 'react-native';
import { Text as RNText, TextInput as ThemedTextInput } from '@/components/Themed';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter, Stack } from 'expo-router';
import { useQuery, useMutation, useConvex } from 'convex/react';
import { api } from '@codecast/convex/convex/_generated/api';
import type { Id } from '@codecast/convex/convex/_generated/dataModel';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import { Theme, Spacing } from '@/constants/Theme';
import { buildChatTimeline } from '@codecast/shared/chat';
import { MessageRow, DayDivider, NewDivider, type MobileChatMessage } from '@/components/chat/MessageRow';
import { dmOtherIds } from '@codecast/shared/chat';
import { MentionStrip, type MentionCandidate } from '@/components/chat/MentionStrip';
import { memberHandle } from '@codecast/shared/chat';

// One channel. An inverted FlatList (the only scroll model that keeps a chat
// pinned to the newest message on mobile without fighting the keyboard), the
// shared timeline rules for grouping and the unread rule, and a composer with
// optimistic sends: the row appears the moment you tap send, dims while in
// flight, and turns loudly red if the server refuses it.

const QUICK_REACTIONS = ['👍', '🎉', '👀', '❤️', '😂', '🚀'];

type PendingSend = {
  clientId: string;
  content: string;
  createdAt: number;
  threadRootId?: string;
  failed?: boolean;
};

export default function ChatChannelScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const channelId = id as Id<'chat_channels'>;
  const router = useRouter();
  const convex = useConvex();

  const currentUser = useQuery(api.users.getCurrentUser);
  const viewerId = currentUser?._id ? String(currentUser._id) : '';

  // Channel meta + roster come from queries this screen's tab already warmed.
  const channelData = useQuery(api.chat.listChannels, {});
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
  const head = useQuery(api.chat.listMessages, { channel_id: channelId, limit: 60 });
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
  const [draft, setDraft] = useState('');

  const sendMessage = useMutation(api.chat.sendMessage);
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

  // Reading the channel: mark on open and again whenever the newest message
  // changes while the screen is up (the inverted list keeps it in view).
  const newestId = (head?.messages as any[] | undefined)?.at(-1)?._id;
  useEffect(() => {
    if (!newestId) return;
    markRead({ channel_id: channelId, last_read_message_id: newestId }).catch(() => {});
  }, [channelId, newestId, markRead]);

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
        ...(entry.threadRootId ? { thread_root_id: entry.threadRootId as any } : {}),
      });
    } catch {
      // The row turns red and offers Retry — a message must never look sent
      // when it was not, and must never silently vanish.
      setPending((prev) => prev.map((p) => (p.clientId === entry.clientId ? { ...p, failed: true } : p)));
    }
  }, [channelId, sendMessage]);

  const onSend = useCallback(() => {
    const content = draft.trim();
    if (!content) return;
    const entry: PendingSend = {
      clientId: `mob-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      content,
      createdAt: Date.now(),
    };
    setDraft('');
    setPending((prev) => [...prev, entry]);
    void doSend(entry);
  }, [draft, doSend]);

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

  const toView = useCallback((m: any): MobileChatMessage => {
    const member = memberById.get(String(m.user_id));
    const thread = threadByRoot.get(String(m._id));
    return {
      id: String(m._id),
      author: {
        id: String(m.user_id),
        name: member?.name || authorById.get(String(m.user_id))?.name
          || (m.author_kind === 'agent' ? 'Anchor' : 'Teammate'),
        avatarUrl: member?.github_avatar_url || member?.image || undefined,
        isAgent: m.author_kind === 'agent' || member?.is_bot,
      },
      content: m.content,
      createdAt: m.created_at,
      editedAt: m.edited_at,
      deletedAt: m.deleted_at,
      mentionsMe: (m.mentions ?? []).some((id: any) => String(id) === viewerId) || m.mention_scope === 'here',
      agentStatus: m.agent_status,
      agentDeadlineAt: m.agent_deadline_at,
      attachments: m.attachments?.length ? m.attachments : undefined,
      reactions: reactionsByMessage.get(String(m._id)),
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
      pending: !p.failed,
      failed: p.failed,
    }));
    const all = [...serverRows, ...pendingRows];
    return buildChatTimeline(
      all.map((m) => ({
        id: m.id,
        authorId: m.author.id,
        createdAt: m.createdAt,
        pendingAgent: m.agentStatus === 'thinking' || m.agentStatus === 'streaming',
        deleted: !!m.deletedAt,
        view: m,
      })),
      { now, lastReadAt: entryReadAtRef.current, viewerId },
    );
  }, [older, head?.messages, pending, toView, now, viewerId, currentUser]);

  // Inverted list: index 0 renders at the bottom, so the rows reverse.
  const inverted = useMemo(() => [...rows].reverse(), [rows]);

  // Object form + cast: the typed-route union regenerates only when Metro runs.
  const pushThread = useCallback((rootId: string) => {
    router.push({
      pathname: '/chat/thread/[id]',
      params: { id: rootId, channel: String(channelId) },
    } as never);
  }, [router, channelId]);

  const onLongPress = useCallback((message: MobileChatMessage) => {
    if (message.pending || message.failed || message.deletedAt) return;
    const own = message.author.id === viewerId;
    const options = [...QUICK_REACTIONS, 'Reply in thread', 'Copy text', ...(own ? ['Delete'] : []), 'Cancel'];
    ActionSheetIOS.showActionSheetWithOptions(
      {
        options,
        cancelButtonIndex: options.length - 1,
        destructiveButtonIndex: own ? options.length - 2 : undefined,
      },
      (index) => {
        if (index < QUICK_REACTIONS.length) {
          void toggleReaction({ message_id: message.id as any, emoji: QUICK_REACTIONS[index] });
        } else if (options[index] === 'Reply in thread') {
          pushThread(message.id);
        } else if (options[index] === 'Copy text') {
          Clipboard.setString(message.content);
        } else if (options[index] === 'Delete') {
          void deleteMessage({ message_id: message.id as any });
        }
      },
    );
  }, [viewerId, toggleReaction, router, channelId, deleteMessage]);

  const renderItem = useCallback(({ item }: { item: (typeof rows)[number] }) => {
    if (item.kind === 'day') return <DayDivider label={item.label} />;
    if (item.kind === 'new') return <NewDivider />;
    const view = (item.message as any).view as MobileChatMessage;
    return (
      <MessageRow
        message={view}
        grouped={item.grouped}
        now={now}
        knownMentionHandles={knownHandles}
        onOpenThread={pushThread}
        onLongPress={onLongPress}
        onToggleReaction={(id, emoji) => void toggleReaction({ message_id: id as any, emoji })}
        onStopAgent={(id) => void stopAnchor({ message_id: id as any })}
        onRetrySend={onRetrySend}
      />
    );
  }, [now, router, channelId, onLongPress, toggleReaction, stopAnchor, onRetrySend]);

  const isDm = channel?.kind === 'dm';
  const roomName = (() => {
    if (!isDm) return channel?.name ?? 'channel';
    const others = dmOtherIds(channel?.dm_key, viewerId);
    if (others.length === 0) return 'Direct message';
    const names = others.map((id) => {
      const m = memberById.get(id);
      return m?.name || m?.github_username || 'Teammate';
    });
    return others.length > 1 ? names.map((n) => n.split(/\s+/)[0]).join(', ') : names[0];
  })();

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <Stack.Screen options={{ headerShown: false }} />
      <RNView style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={10} style={styles.back}>
          <FontAwesome name="chevron-left" size={16} color={Theme.textMuted} />
        </TouchableOpacity>
        <FontAwesome
          name={isDm ? 'user' : channel?.is_private || channel?.kind === 'private' ? 'lock' : 'hashtag'}
          size={13}
          color={Theme.textMuted0}
        />
        <RNText style={styles.title} numberOfLines={1}>{roomName}</RNText>
        {!!channel?.topic && (
          <RNText style={styles.topic} numberOfLines={1}>{channel.topic}</RNText>
        )}
      </RNView>

      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={0}
      >
        <FlatList
          inverted
          data={inverted}
          keyExtractor={(item) => item.key}
          renderItem={renderItem}
          onEndReached={loadOlder}
          onEndReachedThreshold={0.4}
          ListFooterComponent={
            loadingOlder ? (
              <RNText style={styles.loadingOlder}>Loading earlier messages…</RNText>
            ) : null
          }
          ListEmptyComponent={
            head === undefined ? null : (
              <RNView style={styles.emptyWrap}>
                {/* The list is inverted, so un-invert the empty state. */}
                <RNView style={{ transform: [{ scaleY: -1 }] }}>
                  <RNText style={styles.emptyTitle}>{isDm ? roomName : `#${channel?.name ?? 'channel'}`} is quiet</RNText>
                  <RNText style={styles.emptySub}>Say something to start it off.</RNText>
                </RNView>
              </RNView>
            )
          }
          contentContainerStyle={inverted.length === 0 ? styles.emptyList : undefined}
          keyboardDismissMode="interactive"
        />

        <MentionStrip draft={draft} members={mentionCandidates} onPick={setDraft} />
        <RNView style={styles.composer}>
          <ThemedTextInput
            style={styles.input}
            placeholder={isDm ? `Message ${roomName}` : `Message #${channel?.name ?? ''}`}
            placeholderTextColor={Theme.textMuted0}
            value={draft}
            onChangeText={setDraft}
            multiline
            submitBehavior="newline"
          />
          <TouchableOpacity
            style={[styles.send, !draft.trim() && styles.sendDisabled]}
            onPress={onSend}
            disabled={!draft.trim()}
            hitSlop={8}
          >
            <FontAwesome name="arrow-up" size={14} color={draft.trim() ? Theme.bg : Theme.textMuted0} />
          </TouchableOpacity>
        </RNView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Theme.bg },
  flex: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: Spacing.md,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Theme.border + '55',
  },
  back: { paddingRight: 6 },
  title: { fontSize: 15, fontWeight: '600', color: Theme.text, flexShrink: 1 },
  topic: { flex: 1, fontSize: 11, color: Theme.textMuted0, marginLeft: 6 },
  loadingOlder: {
    textAlign: 'center',
    fontSize: 11,
    color: Theme.textMuted0,
    paddingVertical: 8,
    transform: [{ scaleY: -1 }],
  },
  emptyWrap: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  emptyList: { flexGrow: 1 },
  emptyTitle: { fontSize: 14, fontWeight: '600', color: Theme.textSecondary, textAlign: 'center' },
  emptySub: { fontSize: 12, color: Theme.textMuted0, textAlign: 'center', marginTop: 4 },
  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
    paddingHorizontal: Spacing.md,
    paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Theme.border + '55',
  },
  input: {
    flex: 1,
    minHeight: 36,
    maxHeight: 120,
    borderWidth: 1,
    borderColor: Theme.border + '66',
    borderRadius: 9,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 13.5,
    color: Theme.text,
    backgroundColor: Theme.bgAlt + '55',
  },
  send: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: Theme.blue,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 2,
  },
  sendDisabled: { backgroundColor: Theme.bgHighlight },
});
