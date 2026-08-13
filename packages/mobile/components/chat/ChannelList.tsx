import { useMemo } from 'react';
import { StyleSheet, FlatList, TouchableOpacity, View as RNView } from 'react-native';
import { Text as RNText } from '@/components/Themed';
import { useQuery } from 'convex/react';
import { api } from '@codecast/convex/convex/_generated/api';
import type { Id } from '@codecast/convex/convex/_generated/dataModel';
import { useRouter } from 'expo-router';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import { Theme, Spacing } from '@/constants/Theme';
import { formatRelativeTime } from '@/components/SessionItem';

// The channel list — the Chat segment of the Team tab.
//
// Signal rules are the same as the web rail, deliberately: unread is carried by
// WEIGHT (bold name, brighter preview), a muted channel with unread gets a dot,
// and only mentions of you get a number. One count that includes ordinary
// chatter teaches people to ignore counts.

export type ChannelRailRow = {
  channel_id: string;
  last_message: {
    _id: string;
    user_id: string;
    author_kind: 'user' | 'agent';
    created_at: number;
    preview: string;
  } | null;
  sort_at: number;
  unread: number;
  unread_capped: boolean;
  unread_mentions: number;
  notify_level: 'all' | 'mentions' | 'none';
  joined: boolean;
};

export function useChatRail(teamId: Id<'teams'> | undefined) {
  const data = useQuery(api.chat.listChannels, teamId ? { team_id: teamId } : 'skip');
  return useMemo(() => {
    if (!data) return undefined;
    const railByChannel = new Map(
      (data.rail as ChannelRailRow[]).map((r) => [String(r.channel_id), r]),
    );
    const rows = (data.channels as any[])
      .filter((c) => !c.archived_at)
      .map((c) => ({ channel: c, rail: railByChannel.get(String(c._id)) }))
      // Recency, like the web rail: the room where something just happened is
      // the room you are most likely opening the app for.
      .sort((a, b) => (b.rail?.sort_at ?? 0) - (a.rail?.sort_at ?? 0));
    const mentionTotal = rows.reduce((n, r) => n + (r.rail?.unread_mentions ?? 0), 0);
    return { rows, mentionTotal };
  }, [data]);
}

export function ChannelList({ teamId }: { teamId: Id<'teams'> | undefined }) {
  const rail = useChatRail(teamId);
  const router = useRouter();

  if (rail === undefined) {
    return (
      <RNView style={styles.empty}>
        <RNText style={styles.emptySub}>Loading channels…</RNText>
      </RNView>
    );
  }

  if (rail.rows.length === 0) {
    return (
      <RNView style={styles.empty}>
        <FontAwesome name="comments-o" size={26} color={Theme.textMuted0} />
        <RNText style={styles.emptyTitle}>No channels yet</RNText>
        <RNText style={styles.emptySub}>
          Create the first one from the web app, or ask a teammate for an invite.
        </RNText>
      </RNView>
    );
  }

  return (
    <FlatList
      data={rail.rows}
      keyExtractor={(item) => String(item.channel._id)}
      renderItem={({ item }) => {
        const { channel, rail: r } = item;
        const unread = (r?.unread ?? 0) > 0;
        const mentions = r?.unread_mentions ?? 0;
        const muted = r?.notify_level === 'none';
        return (
          <TouchableOpacity
            style={styles.row}
            activeOpacity={0.7}
            onPress={() => router.push({ pathname: '/chat/[id]', params: { id: String(channel._id) } } as never)}
          >
            <RNView style={styles.rowIcon}>
              <FontAwesome
                name={channel.is_private ? 'lock' : 'hashtag'}
                size={13}
                color={unread ? Theme.textMuted : Theme.textMuted0}
              />
            </RNView>
            <RNView style={styles.rowMain}>
              <RNView style={styles.rowHead}>
                <RNText
                  style={[styles.name, unread && styles.nameUnread, muted && styles.nameMuted]}
                  numberOfLines={1}
                >
                  {channel.name}
                </RNText>
                {r?.last_message && (
                  <RNText style={styles.time}>
                    {formatRelativeTime(r.last_message.created_at)}
                  </RNText>
                )}
              </RNView>
              <RNText
                style={[styles.preview, unread && !muted && styles.previewUnread]}
                numberOfLines={1}
              >
                {r?.last_message
                  ? (r.last_message.author_kind === 'agent' ? '⚑ ' : '') + r.last_message.preview
                  : channel.topic || 'No messages yet'}
              </RNText>
            </RNView>
            {mentions > 0 ? (
              <RNView style={styles.badge}>
                <RNText style={styles.badgeText}>{mentions > 99 ? '99+' : mentions}</RNText>
              </RNView>
            ) : unread && muted ? (
              <RNView style={styles.dot} />
            ) : null}
          </TouchableOpacity>
        );
      }}
    />
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.md,
    paddingVertical: 10,
    gap: 10,
  },
  rowIcon: { width: 20, alignItems: 'center' },
  rowMain: { flex: 1, minWidth: 0 },
  rowHead: { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
  name: { flex: 1, fontSize: 14, color: Theme.textMuted },
  nameUnread: { color: Theme.text, fontWeight: '600' },
  nameMuted: { opacity: 0.5 },
  time: { fontSize: 10, color: Theme.textMuted0 },
  preview: { fontSize: 12, color: Theme.textMuted0, marginTop: 1 },
  previewUnread: { color: Theme.textMuted },
  badge: {
    minWidth: 20,
    height: 18,
    borderRadius: 9,
    backgroundColor: Theme.red,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 5,
  },
  badgeText: { fontSize: 10, fontWeight: '700', color: Theme.bg },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: Theme.textMuted0 },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8, padding: 32 },
  emptyTitle: { fontSize: 14, fontWeight: '600', color: Theme.textSecondary },
  emptySub: { fontSize: 12, color: Theme.textMuted0, textAlign: 'center', lineHeight: 18 },
});
