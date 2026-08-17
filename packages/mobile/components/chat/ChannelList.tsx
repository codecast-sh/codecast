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
import { dmOtherIds } from '@codecast/shared/chat';
import { ChatAvatar } from './MessageRow';

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

/** A 1:1 DM row wears the person's face with their presence dot pinned to its
 *  corner — who it is and whether they're there, in one glance. Group DMs keep
 *  a neutral glyph (three faces at 15pt read as noise). */
function DmFace({ channel, viewerId, members }: { channel: any; viewerId: string; members?: any[] }) {
  const others = dmOtherIds(channel.dm_key, viewerId);
  const one = others.length === 1
    ? (members ?? []).find((m) => String(m._id) === others[0])
    : undefined;
  if (!one) return <FontAwesome name={others.length > 1 ? 'users' : 'user'} size={13} color={Theme.textMuted0} />;
  const presence = one.presence_state as string | undefined;
  const dotColor = presence === 'active' ? Theme.green : presence === 'idle' ? Theme.accent : null;
  return (
    <RNView>
      <ChatAvatar
        author={{ id: String(one._id), name: one.name || 'Teammate', avatarUrl: one.github_avatar_url || one.image, isAgent: one.is_bot }}
        size={20}
      />
      {dotColor && <RNView style={[styles.presenceDot, { backgroundColor: dotColor }]} />}
    </RNView>
  );
}

type ListItem =
  | { kind: 'header'; key: string; label: string; newMessage?: boolean }
  | { kind: 'channel'; key: string; channel: any; rail?: ChannelRailRow };

export function ChannelList({ teamId }: { teamId: Id<'teams'> | undefined }) {
  const rail = useChatRail(teamId);
  const router = useRouter();
  // DM naming: the other side's names, resolved live from the roster — the
  // same rule as every web surface (lib/chatViews.channelDisplayName).
  const currentUser = useQuery(api.users.getCurrentUser);
  const teamMembers = useQuery(api.teams.getTeamMembers, teamId ? { team_id: teamId } : 'skip');
  const memberName = (id: string): string => {
    const m = (teamMembers as any[] | undefined)?.find((x) => String(x._id) === id);
    return m?.name || m?.github_username || 'Teammate';
  };
  const displayName = (channel: any): string => {
    if (channel.kind !== 'dm') return channel.name;
    const others = dmOtherIds(channel.dm_key, String(currentUser?._id ?? ''));
    if (others.length === 0) return 'Direct message';
    const names = others.map(memberName);
    return others.length > 1 ? names.map((n) => n.split(/\s+/)[0]).join(', ') : names[0];
  };

  // Channels and direct messages are one list with two headers — a FlatList
  // keeps the scroll simple and the row shape identical across sections.
  const items = useMemo<ListItem[]>(() => {
    if (!rail) return [];
    const channels = rail.rows.filter((r) => r.channel.kind !== 'dm');
    const dms = rail.rows.filter((r) => r.channel.kind === 'dm');
    const out: ListItem[] = [];
    if (channels.length) out.push({ kind: 'header', key: 'h-ch', label: 'Channels' });
    for (const r of channels) out.push({ kind: 'channel', key: String(r.channel._id), channel: r.channel, rail: r.rail });
    out.push({ kind: 'header', key: 'h-dm', label: 'Direct messages', newMessage: true });
    for (const r of dms) out.push({ kind: 'channel', key: String(r.channel._id), channel: r.channel, rail: r.rail });
    return out;
  }, [rail]);

  if (rail === undefined) {
    return (
      <RNView style={styles.empty}>
        <RNText style={styles.emptySub}>Loading channels…</RNText>
      </RNView>
    );
  }

  return (
    <FlatList
      data={items}
      keyExtractor={(item) => item.key}
      renderItem={({ item }) => {
        if (item.kind === 'header') {
          return (
            <RNView style={styles.sectionHead}>
              <RNText style={styles.sectionLabel}>{item.label}</RNText>
              {item.newMessage && (
                <TouchableOpacity
                  hitSlop={8}
                  onPress={() => router.push('/chat/new' as never)}
                  style={styles.sectionAction}
                >
                  <FontAwesome name="pencil-square-o" size={15} color={Theme.blue} />
                </TouchableOpacity>
              )}
            </RNView>
          );
        }
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
              {channel.kind === 'dm' ? (
                <DmFace channel={channel} viewerId={String(currentUser?._id ?? '')} members={teamMembers as any[] | undefined} />
              ) : (
                <FontAwesome
                  name={channel.kind === 'private' || channel.is_private ? 'lock' : 'hashtag'}
                  size={13}
                  color={unread ? Theme.textMuted : Theme.textMuted0}
                />
              )}
            </RNView>
            <RNView style={styles.rowMain}>
              <RNView style={styles.rowHead}>
                <RNText
                  style={[styles.name, unread && styles.nameUnread, muted && styles.nameMuted]}
                  numberOfLines={1}
                >
                  {displayName(channel)}
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
  sectionHead: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.md,
    paddingTop: 14,
    paddingBottom: 4,
  },
  sectionLabel: {
    flex: 1,
    fontSize: 10.5,
    fontWeight: '700',
    letterSpacing: 0.8,
    textTransform: 'uppercase',
    color: Theme.textMuted0,
  },
  sectionAction: { padding: 2 },
  presenceDot: {
    position: 'absolute',
    right: -2,
    bottom: -2,
    width: 8,
    height: 8,
    borderRadius: 4,
    borderWidth: 1.5,
    borderColor: Theme.bg,
  },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8, padding: 32 },
  emptyTitle: { fontSize: 14, fontWeight: '600', color: Theme.textSecondary },
  emptySub: { fontSize: 12, color: Theme.textMuted0, textAlign: 'center', lineHeight: 18 },
});
