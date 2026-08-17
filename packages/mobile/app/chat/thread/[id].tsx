import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useActiveTeamFeature } from '@/lib/teamFeatures';
import {
  StyleSheet, FlatList, TouchableOpacity, View as RNView,
  KeyboardAvoidingView, Platform, AppState, Alert,
} from 'react-native';
import { Text as RNText } from '@/components/Themed';
import * as Haptics from 'expo-haptics';
import { copyToClipboard } from '@/lib/clipboard';
import { setChatFocus, clearChatFocus } from '@/lib/chatFocus';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter, Stack, useFocusEffect } from 'expo-router';
import { useQuery, useMutation } from 'convex/react';
import { api } from '@codecast/convex/convex/_generated/api';
import type { Id } from '@codecast/convex/convex/_generated/dataModel';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import { Theme, Spacing } from '@/constants/Theme';
import { buildChatTimeline, memberHandle } from '@codecast/shared/chat';
import { MessageRow, type MobileChatMessage } from '@/components/chat/MessageRow';
import { type MentionCandidate } from '@/components/chat/MentionStrip';
import { ChatComposerBar } from '@/components/chat/ChatComposerBar';
import { MessageActionsSheet, type MessageAction } from '@/components/chat/MessageActionsSheet';
import { ImageViewer } from '@/components/chat/ImageViewer';
import { TypingRow } from '@/components/chat/TypingRow';
import type { ChatAttachmentArg } from '@/components/chat/chatUpload';

// One thread: the root as the subject, the replies under it, and a composer
// that says out loud when a plain reply will reach the anchor. That hint comes
// from the SERVER (getThread.anchor.armed, computed by the same rule the send
// path applies) — the one place it can never disagree with what sending does.
//
// Reads are honest here too: the CHANNEL's mark advances to the newest reply,
// but only while this screen is focused and the app is foregrounded.

type PendingSend = {
  clientId: string;
  content: string;
  createdAt: number;
  attachments?: ChatAttachmentArg[];
  failed?: boolean;
};

export default function ChatThreadScreen() {
  const { id, channel: channelParam, m: targetParam } = useLocalSearchParams<{ id: string; channel?: string; m?: string }>();
  const rootId = id as Id<'chat_messages'>;
  const router = useRouter();

  const currentUser = useQuery(api.users.getCurrentUser);
  const viewerId = currentUser?._id ? String(currentUser._id) : '';

  const chatOn = useActiveTeamFeature("chat");
  const thread = useQuery(api.chat.getThread, chatOn ? { root_id: rootId } : 'skip');
  const channelId = (thread?.root?.channel_id ?? channelParam) as Id<'chat_channels'> | undefined;

  const channelData = useQuery(api.chat.listChannels, chatOn ? {} : 'skip');
  const channel = useMemo(
    () => (channelData?.channels as any[] | undefined)?.find(
      (c) => String(c._id) === String(channelId),
    ),
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

  // Names for authors the roster no longer carries (departed members): the
  // query's own authors map, so old messages never degrade to "Teammate".
  const authorById = useMemo(() => {
    const map = new Map<string, any>();
    for (const a of ((thread?.authors as any[]) ?? [])) map.set(String(a._id), a);
    return map;
  }, [thread?.authors]);

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
  const setFollow = useMutation(api.chat.setAnchorFollow);
  const deleteMessage = useMutation(api.chat.deleteMessage);

  const [now, setNow] = useState(() => Date.now());
  const anyThinking = (thread?.replies as any[] | undefined)?.some(
    (m) => m.agent_status === 'thinking' || m.agent_status === 'streaming',
  );
  useEffect(() => {
    if (!anyThinking) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [anyThinking]);

  // ── Honest reading ────────────────────────────────────────────────────────
  // Reading a thread advances the CHANNEL's read mark to the newest reply —
  // without this, a channel whose latest activity lives in threads would badge
  // forever, because the channel view alone can never reach those rows. But
  // only while the person is actually looking (focused + foregrounded).
  const focusedRef = useRef(false);
  const appActiveRef = useRef(AppState.currentState === 'active');
  const newestReplyId = (thread?.replies as any[] | undefined)?.at(-1)?._id;
  const newestReplyRef = useRef<string | undefined>(undefined);
  newestReplyRef.current = newestReplyId ? String(newestReplyId) : undefined;
  const markIfPresent = useCallback(() => {
    if (!focusedRef.current || !appActiveRef.current || !channelId || !newestReplyRef.current) return;
    markRead({ channel_id: channelId, last_read_message_id: newestReplyRef.current as any }).catch(() => {});
  }, [channelId, markRead]);
  useFocusEffect(
    useCallback(() => {
      focusedRef.current = true;
      if (channelId) setChatFocus({ channelId: String(channelId), threadRootId: String(rootId) });
      markIfPresent();
      return () => {
        focusedRef.current = false;
        clearChatFocus();
      };
    }, [markIfPresent, channelId, rootId]),
  );
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      appActiveRef.current = s === 'active';
      if (s === 'active') markIfPresent();
    });
    return () => sub.remove();
  }, [markIfPresent]);
  useEffect(() => { markIfPresent(); }, [newestReplyId, markIfPresent]);

  const echoed = useMemo(() => {
    const set = new Set<string>();
    for (const m of (thread?.replies as any[]) ?? []) if (m.client_id) set.add(m.client_id);
    return set;
  }, [thread?.replies]);
  useEffect(() => {
    if (echoed.size === 0) return;
    setPending((prev) => prev.filter((p) => !echoed.has(p.clientId)));
  }, [echoed]);

  const doSend = useCallback(async (entry: PendingSend) => {
    if (!channelId) return;
    try {
      await sendMessage({
        channel_id: channelId,
        content: entry.content,
        client_id: entry.clientId,
        thread_root_id: rootId,
        ...(entry.attachments?.length ? { attachments: entry.attachments as any } : {}),
      });
    } catch {
      setPending((prev) => prev.map((p) => (p.clientId === entry.clientId ? { ...p, failed: true } : p)));
    }
  }, [channelId, rootId, sendMessage]);

  const onSend = useCallback((content: string, attachments: ChatAttachmentArg[]) => {
    const entry: PendingSend = {
      clientId: `mobt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      content,
      createdAt: Date.now(),
      attachments: attachments.length ? attachments : undefined,
    };
    setPending((prev) => [...prev, entry]);
    void doSend(entry);
  }, [doSend]);

  const onRetrySend = useCallback((id: string) => {
    setPending((prev) => prev.map((p) => (`pend-${p.clientId}` === id ? { ...p, failed: false } : p)));
    const entry = pending.find((p) => `pend-${p.clientId}` === id);
    if (entry) void doSend({ ...entry, failed: false });
  }, [pending, doSend]);

  const onSubmitEdit = useCallback((messageId: string, content: string) => {
    void editMessage({ message_id: messageId as any, content }).catch(() => {
      Alert.alert('Edit failed', 'The message kept its previous text.');
    });
  }, [editMessage]);

  const reactionsByMessage = useMemo(() => {
    const map = new Map<string, { emoji: string; count: number; mine: boolean }[]>();
    for (const r of ((thread?.reactions as any[]) ?? [])) {
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
  }, [thread?.reactions, viewerId]);

  const toView = useCallback((m: any): MobileChatMessage => {
    const member = memberById.get(String(m.user_id));
    return {
      id: String(m._id),
      author: {
        id: String(m.user_id),
        name: member?.name || authorById.get(String(m.user_id))?.name
          || (m.author_kind === 'agent' ? thread?.anchor?.name ?? 'Anchor' : 'Teammate'),
        avatarUrl: member?.github_avatar_url || member?.image || undefined,
        isAgent: m.author_kind === 'agent' || member?.is_bot,
      },
      content: m.content,
      createdAt: m.created_at,
      editedAt: m.edited_at,
      deletedAt: m.deleted_at,
      mentionsMe: (m.mentions ?? []).some((x: any) => String(x) === viewerId),
      agentStatus: m.agent_status,
      agentDeadlineAt: m.agent_deadline_at,
      attachments: m.attachments?.length ? m.attachments : undefined,
      reactions: reactionsByMessage.get(String(m._id)),
    };
  }, [memberById, authorById, viewerId, reactionsByMessage, thread?.anchor?.name]);

  const rows = useMemo(() => {
    if (!thread?.root) return [];
    const replies = ((thread.replies as any[]) ?? []).map(toView);
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
    // Day separators add noise, not orientation, in a short dense thread.
    return buildChatTimeline(
      [...replies, ...pendingRows].map((m) => ({
        id: m.id,
        authorId: m.author.id,
        createdAt: m.createdAt,
        pendingAgent: m.agentStatus === 'thinking' || m.agentStatus === 'streaming',
        deleted: !!m.deletedAt,
        view: m,
      })),
      { now, viewerId, withoutDays: true },
    );
  }, [thread, pending, toView, now, viewerId, currentUser]);

  const inverted = useMemo(() => [...rows].reverse(), [rows]);

  // ── Deep-link target (?m=<replyId>) ───────────────────────────────────────
  // A push about a thread reply lands here; the reply flashes so the eye finds
  // it. getThread returns the whole thread, so no paging hunt is needed.
  const listRef = useRef<FlatList>(null);
  const doneTargetRef = useRef<string | null>(null);
  useEffect(() => {
    const target = typeof targetParam === 'string' ? targetParam : undefined;
    if (!target || doneTargetRef.current === target || !thread?.root) return;
    doneTargetRef.current = target;
    const index = inverted.findIndex((it: any) => it.kind === 'message' && it.message?.id === target);
    if (index >= 0) {
      setHighlightId(target);
      setTimeout(() => listRef.current?.scrollToIndex({ index, viewPosition: 0.5, animated: true }), 250);
      setTimeout(() => setHighlightId(null), 3200);
    }
  }, [targetParam, thread?.root, inverted]);

  // ── Long-press sheet ──────────────────────────────────────────────────────
  const onLongPress = useCallback((message: MobileChatMessage) => {
    if (message.pending || message.failed || message.deletedAt) return;
    if (Platform.OS === 'ios') void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setSheetTarget(message);
  }, []);

  const onSheetAction = useCallback((action: MessageAction) => {
    const message = sheetTarget;
    if (!message) return;
    if (action.kind === 'react') {
      void toggleReaction({ message_id: message.id as any, emoji: action.emoji });
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
  }, [sheetTarget, toggleReaction, deleteMessage]);

  const nameOf = useCallback((uid: string) => {
    const m = memberById.get(uid);
    return m?.name?.split(/\s+/)[0] || m?.github_username || '';
  }, [memberById]);

  const armed = thread?.anchor?.armed ?? false;
  const anchorName = thread?.anchor?.name ?? 'Anchor';

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <Stack.Screen options={{ headerShown: false }} />
      <RNView style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={10} style={styles.back}>
          <FontAwesome name="chevron-left" size={16} color={Theme.textMuted} />
        </TouchableOpacity>
        <RNView style={styles.headMain}>
          <RNText style={styles.title}>Thread</RNText>
          {!!channel?.name && (
            <RNText style={styles.subtitle} numberOfLines={1}>#{channel.name}</RNText>
          )}
        </RNView>
        {armed && (
          <TouchableOpacity
            onPress={() => void setFollow({ root_id: rootId, follow: false })}
            hitSlop={8}
            style={styles.armedPill}
          >
            <FontAwesome name="microchip" size={9} color={Theme.violet} />
            <RNText style={styles.armedText}>{anchorName} · on</RNText>
          </TouchableOpacity>
        )}
      </RNView>

      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <FlatList
          ref={listRef}
          inverted
          data={inverted}
          keyExtractor={(item) => item.key}
          onScrollToIndexFailed={() => {}}
          renderItem={({ item }) => {
            if (item.kind !== 'message') return null;
            const view = (item.message as any).view as MobileChatMessage;
            return (
              <RNView style={view.id === highlightId ? styles.highlight : undefined}>
                <MessageRow
                  message={view}
                  grouped={item.grouped}
                  now={now}
                  inThread
                  knownMentionHandles={knownHandles}
                  onLongPress={onLongPress}
                  onToggleReaction={(mid, emoji) => void toggleReaction({ message_id: mid as any, emoji })}
                  onStopAgent={(mid) => void stopAnchor({ message_id: mid as any })}
                  onRetrySend={onRetrySend}
                  onOpenImage={setViewerUri}
                />
              </RNView>
            );
          }}
          // The root renders at the top of the inverted list — the subject line
          // the replies hang from.
          ListFooterComponent={
            thread?.root ? (
              <RNView style={styles.rootWrap}>
                <MessageRow
                  message={toView(thread.root)}
                  now={now}
                  inThread
                  knownMentionHandles={knownHandles}
                  onLongPress={onLongPress}
                  onOpenImage={setViewerUri}
                />
                <RNView style={styles.rootRule} />
              </RNView>
            ) : null
          }
          keyboardDismissMode="interactive"
        />

        <TypingRow
          channelId={channelId ? String(channelId) : undefined}
          threadRootId={String(rootId)}
          viewerId={viewerId}
          nameOf={nameOf}
        />
        <ChatComposerBar
          channelId={channelId ? String(channelId) : undefined}
          threadRootId={String(rootId)}
          placeholder={armed ? `Reply — ${anchorName} will answer` : 'Reply…'}
          placeholderTint={armed ? Theme.violet + 'AA' : undefined}
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
        canReply={false}
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
  headMain: { flex: 1, minWidth: 0 },
  title: { fontSize: 15, fontWeight: '600', color: Theme.text },
  subtitle: { fontSize: 10.5, color: Theme.textMuted0 },
  armedPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderWidth: 1,
    borderColor: Theme.violet + '55',
    borderRadius: 10,
    paddingHorizontal: 7,
    paddingVertical: 3,
  },
  armedText: { fontSize: 10, fontWeight: '600', color: Theme.violet },
  // No counter-flip: on this RN (0.81 / Fabric) an inverted list does NOT
  // transform header/footer components — flipping here rendered the root
  // upside down (caught in the simulator, 2026-08-15).
  rootWrap: {},
  rootRule: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: Theme.border + '66',
    marginVertical: 8,
    marginHorizontal: Spacing.md,
  },
  highlight: { backgroundColor: Theme.accent + '1E' },
});
