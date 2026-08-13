import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  StyleSheet, FlatList, TouchableOpacity, View as RNView,
  KeyboardAvoidingView, Platform,
} from 'react-native';
import { Text as RNText, TextInput as ThemedTextInput } from '@/components/Themed';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter, Stack } from 'expo-router';
import { useQuery, useMutation } from 'convex/react';
import { api } from '@codecast/convex/convex/_generated/api';
import type { Id } from '@codecast/convex/convex/_generated/dataModel';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import { Theme, Spacing } from '@/constants/Theme';
import { buildChatTimeline } from '@codecast/shared/chat';
import { MessageRow, type MobileChatMessage } from '@/components/chat/MessageRow';
import { MentionStrip, type MentionCandidate } from '@/components/chat/MentionStrip';
import { memberHandle } from '@codecast/shared/chat';

// One thread: the root as the subject, the replies under it, and a composer
// that says out loud when a plain reply will reach the anchor. That hint comes
// from the SERVER (getThread.anchor.armed, computed by the same rule the send
// path applies) — the one place it can never disagree with what sending does.

type PendingSend = {
  clientId: string;
  content: string;
  createdAt: number;
  failed?: boolean;
};

export default function ChatThreadScreen() {
  const { id, channel: channelParam } = useLocalSearchParams<{ id: string; channel?: string }>();
  const rootId = id as Id<'chat_messages'>;
  const router = useRouter();

  const currentUser = useQuery(api.users.getCurrentUser);
  const viewerId = currentUser?._id ? String(currentUser._id) : '';

  const thread = useQuery(api.chat.getThread, { root_id: rootId });
  const channelId = (thread?.root?.channel_id ?? channelParam) as Id<'chat_channels'> | undefined;

  const channelData = useQuery(api.chat.listChannels, {});
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
  const [draft, setDraft] = useState('');

  const sendMessage = useMutation(api.chat.sendMessage);
  const markRead = useMutation(api.chat.markRead);
  const toggleReaction = useMutation(api.chat.toggleReaction);
  const stopAnchor = useMutation(api.chat.stopAnchorReply);
  const setFollow = useMutation(api.chat.setAnchorFollow);

  const [now, setNow] = useState(() => Date.now());
  const anyThinking = (thread?.replies as any[] | undefined)?.some(
    (m) => m.agent_status === 'thinking' || m.agent_status === 'streaming',
  );
  useEffect(() => {
    if (!anyThinking) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [anyThinking]);

  // Reading a thread advances the CHANNEL's read mark to the newest reply —
  // without this, a channel whose latest activity lives in threads would badge
  // forever, because the channel view alone can never reach those rows.
  const newestReplyId = (thread?.replies as any[] | undefined)?.at(-1)?._id;
  useEffect(() => {
    if (!newestReplyId || !channelId) return;
    markRead({ channel_id: channelId, last_read_message_id: newestReplyId }).catch(() => {});
  }, [channelId, newestReplyId, markRead]);

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
      });
    } catch {
      setPending((prev) => prev.map((p) => (p.clientId === entry.clientId ? { ...p, failed: true } : p)));
    }
  }, [channelId, rootId, sendMessage]);

  const onSend = useCallback(() => {
    const content = draft.trim();
    if (!content) return;
    const entry: PendingSend = {
      clientId: `mobt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      content,
      createdAt: Date.now(),
    };
    setDraft('');
    setPending((prev) => [...prev, entry]);
    void doSend(entry);
  }, [draft, doSend]);

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
          inverted
          data={inverted}
          keyExtractor={(item) => item.key}
          renderItem={({ item }) => {
            if (item.kind !== 'message') return null;
            const view = (item.message as any).view as MobileChatMessage;
            return (
              <MessageRow
                message={view}
                grouped={item.grouped}
                now={now}
                inThread
                knownMentionHandles={knownHandles}
                onToggleReaction={(mid, emoji) => void toggleReaction({ message_id: mid as any, emoji })}
                onStopAgent={(mid) => void stopAnchor({ message_id: mid as any })}
              />
            );
          }}
          // The root renders at the top of the inverted list — the subject line
          // the replies hang from.
          ListFooterComponent={
            thread?.root ? (
              <RNView style={styles.rootWrap}>
                <MessageRow message={toView(thread.root)} now={now} inThread knownMentionHandles={knownHandles} />
                <RNView style={styles.rootRule} />
              </RNView>
            ) : null
          }
          keyboardDismissMode="interactive"
        />

        <MentionStrip draft={draft} members={mentionCandidates} onPick={setDraft} />
        <RNView style={styles.composer}>
          <ThemedTextInput
            style={styles.input}
            placeholder={armed ? `Reply — ${anchorName} will answer` : 'Reply…'}
            placeholderTextColor={armed ? Theme.violet + 'AA' : Theme.textMuted0}
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
  rootWrap: { transform: [{ scaleY: -1 }] },
  rootRule: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: Theme.border + '66',
    marginVertical: 8,
    marginHorizontal: Spacing.md,
  },
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
