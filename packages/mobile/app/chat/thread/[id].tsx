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
import { useMutation } from 'convex/react';
import { api } from '@codecast/convex/convex/_generated/api';
import { useInboxStore, selectChannelReadMarker } from '@codecast/web/store/inboxStore';
import { useThreadMessages, useThreadSync } from '@codecast/web/hooks/useChatSync';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import { Theme, Spacing, themedStyles, useTheme } from '@/constants/Theme';
import { authorGroupKey, buildChatTimeline, memberHandle } from '@codecast/shared/chat';
import { MessageRow, fromChatView, type MobileChatMessage } from '@/components/chat/MessageRow';
import { type MentionCandidate } from '@/components/chat/MentionStrip';
import { useSessionIdentityLookup } from '@/components/identity';
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

export default function ChatThreadScreen() {
  const Theme = useTheme();
  const { id, channel: channelParam, m: targetParam } = useLocalSearchParams<{ id: string; channel?: string; m?: string }>();
  const rootId = id as string;
  const router = useRouter();

  // LOCAL FIRST, like the channel screen: the root and its replies read from
  // the store (a reply the channel page or a push prefetch already holds
  // paints at once); useThreadSync only feeds it.
  const currentUser = useInboxStore((s) => s.currentUser) as any;
  const viewerId = currentUser?._id ? String(currentUser._id) : '';

  const chatOn = useActiveTeamFeature("chat");
  const thread = useThreadSync(chatOn === false ? undefined : rootId);
  const { root, replies } = useThreadMessages(rootId);
  const rootRow = useInboxStore((s) => s.chatMessages[rootId]) as any;
  const channelId = (rootRow?.channel_id ?? channelParam) as string | undefined;
  const channel = useInboxStore((s) => (channelId ? s.chatChannels[channelId] : undefined)) as any;
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
  const setFollow = useMutation(api.chat.setAnchorFollow);

  const [now, setNow] = useState(() => Date.now());
  const anyThinking = replies.some((m) => m.agentStatus === 'thinking' || m.agentStatus === 'streaming');
  useEffect(() => {
    if (!anyThinking) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [anyThinking]);

  // ── Honest reading ────────────────────────────────────────────────────────
  // Reading a thread advances the CHANNEL's read mark to the newest row —
  // without this, a channel whose latest activity lives in threads would badge
  // forever, because the channel view alone can never reach those rows. But
  // only while the person is actually looking (focused + foregrounded).
  const focusedRef = useRef(false);
  const appActiveRef = useRef(AppState.currentState === 'active');
  const newestReplyId = replies.at(-1)?.id;
  const markIfPresent = useCallback(() => {
    if (!focusedRef.current || !appActiveRef.current || !channelId) return;
    const state = useInboxStore.getState();
    const marker = selectChannelReadMarker(state as any, channelId);
    if (marker) state.markChannelRead(channelId, marker._id);
  }, [channelId]);
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

  // Replies paint in this tick through the store's send action.
  const onSend = useCallback((content: string, attachments: ChatAttachmentArg[]) => {
    if (!channelId) return;
    useInboxStore.getState().sendChatMessage(channelId, content, {
      threadRootId: rootId,
      attachments: attachments.length ? (attachments as any) : undefined,
    });
  }, [channelId, rootId]);

  const onRetrySend = useCallback((rowId: string) => {
    useInboxStore.getState().retryChatSend(rowId);
  }, []);

  const onSubmitEdit = useCallback((messageId: string, content: string) => {
    useInboxStore.getState().editChatMessage(messageId, content);
  }, []);

  const toggleReaction = useCallback((messageId: string, emoji: string) => {
    useInboxStore.getState().toggleChatReaction(messageId, emoji);
  }, []);

  const identityFor = useSessionIdentityLookup();
  const chatMessages = useInboxStore.getState().chatMessages;
  const rootView = useMemo(
    () => (root ? fromChatView(root, chatMessages[root.id], identityFor) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [root, identityFor],
  );

  const rows = useMemo(() => {
    if (!root) return [];
    // Day separators add noise, not orientation, in a short dense thread.
    return buildChatTimeline(
      replies.map((v) => fromChatView(v, chatMessages[v.id], identityFor)).map((m) => ({
        id: m.id,
        authorId: m.author.id,
        groupKey: authorGroupKey(m.author),
        createdAt: m.createdAt,
        pendingAgent: m.agentStatus === 'thinking' || m.agentStatus === 'streaming',
        deleted: !!m.deletedAt,
        view: m,
      })),
      { now, viewerId, withoutDays: true },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root, replies, identityFor, now, viewerId]);

  const inverted = useMemo(() => [...rows].reverse(), [rows]);

  // ── Deep-link target (?m=<replyId>) ───────────────────────────────────────
  // A push about a thread reply lands here; the reply flashes so the eye finds
  // it. The thread page is the whole thread, so no paging hunt is needed.
  const listRef = useRef<FlatList>(null);
  const doneTargetRef = useRef<string | null>(null);
  useEffect(() => {
    const target = typeof targetParam === 'string' ? targetParam : undefined;
    if (!target || doneTargetRef.current === target || !root) return;
    const index = inverted.findIndex((it: any) => it.kind === 'message' && it.message?.id === target);
    // A cached thread may not hold the reply yet: wait for the page.
    if (index < 0 && thread.loading) return;
    doneTargetRef.current = target;
    if (index >= 0) {
      setHighlightId(target);
      if (index > 2) {
        setTimeout(() => listRef.current?.scrollToIndex({ index, viewPosition: 0.5, animated: true }), 250);
      }
      setTimeout(() => setHighlightId(null), 3200);
    }
  }, [targetParam, root, inverted, thread.loading]);

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
      toggleReaction(message.id, action.emoji);
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
  }, [sheetTarget, toggleReaction]);

  const nameOf = useCallback((uid: string) => {
    const m = memberById.get(uid);
    return m?.name?.split(/\s+/)[0] || m?.github_username || '';
  }, [memberById]);

  const armed = thread.anchor?.armed ?? false;
  const anchorName = thread.anchor?.name ?? 'Workspace agent';

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
            onPress={() => void setFollow({ root_id: rootId as any, follow: false })}
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
          keyboardShouldPersistTaps="always"
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
                  onToggleReaction={toggleReaction}
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
            rootView ? (
              <RNView style={styles.rootWrap}>
                <MessageRow
                  message={rootView}
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

const styles = themedStyles((Theme) => StyleSheet.create({
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
}));
