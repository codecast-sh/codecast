import { useMemo } from 'react';
import { StyleSheet, FlatList, TouchableOpacity, View as RNView, ActionSheetIOS, Alert, Platform } from 'react-native';
import { Text as RNText } from '@/components/Themed';
import { useMutation, useQuery } from 'convex/react';
import { api } from '@codecast/convex/convex/_generated/api';
import type { Id } from '@codecast/convex/convex/_generated/dataModel';
import { useRouter } from 'expo-router';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { Theme, Spacing, themedStyles, useTheme } from '@/constants/Theme';
import { formatRelativeTime } from '@/components/SessionItem';
import { MemberSkeleton } from '@/components/SkeletonLoader';
import { dmOtherIds } from '@codecast/shared/chat';
import { channelDisplayName } from '@codecast/web/lib/chatViews';
import { MIRROR_STATE_LABEL, mirrorState, type SlackMirrorState } from '@codecast/convex/convex/lib/slackMirror';
import { SlackLogo } from '@/components/SlackLogo';
import { dmRoomKey } from '@codecast/shared/contracts';
import { ChatAvatar } from './MessageRow';
import { LivePulse, LiveRoomCard, type LiveRoomRow } from '@/components/calls/LiveRooms';
import { joinCall, startHuddle } from '@/lib/calls/callManager';

// The Chat tab's home list: live huddles first, then channels, then direct
// messages, then the team's people. One FlatList, four kinds of row.
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
  member_ids?: string[];
};

/** The channel rail for a team. `enabled` is the team's chat opt-in: the
 *  server refuses listChannels for an off team, and a thrown query drops the
 *  screen, so an off team never subscribes. */
export function useChatRail(teamId: Id<'teams'> | undefined, enabled = true) {
  const data = useQuery(api.chat.listChannels, teamId && enabled ? { team_id: teamId } : 'skip');
  return useMemo(() => {
    if (!enabled) return { rows: [], mentionTotal: 0, channels: [], rail: [] as ChannelRailRow[] };
    if (!data) return undefined;
    const rail = data.rail as ChannelRailRow[];
    const railByChannel = new Map(rail.map((r) => [String(r.channel_id), r]));
    // A mirrored channel wears the Slack channel's name, so the row's label is
    // the Slack mark (same rule as the web rail), coloured by the mirror's state.
    const slackByChannel = new Map<string, SlackMirrorState>(
      ((data as any).slack_links ?? []).map((l: any) => [String(l.chat_channel_id), mirrorState(l)]),
    );
    const channels = (data.channels as any[]).filter((c) => !c.archived_at);
    const rows = channels
      .map((c) => ({ channel: c, rail: railByChannel.get(String(c._id)), slack: slackByChannel.get(String(c._id)) }))
      // Recency, like the web rail: the room where something just happened is
      // the room you are most likely opening the app for.
      .sort((a, b) => (b.rail?.sort_at ?? 0) - (a.rail?.sort_at ?? 0));
    const mentionTotal = rows.reduce((n, r) => n + (r.rail?.unread_mentions ?? 0), 0);
    return { rows, mentionTotal, channels, rail };
  }, [data, enabled]);
}

const PRESENCE_LINE: Record<string, string> = { active: 'Active now', idle: 'Idle', away: 'Away' };

function presenceColor(state: string | undefined, Theme: any): string | null {
  return state === 'active' ? Theme.green : state === 'idle' ? Theme.accent : null;
}

/** A face with the person's presence pinned to its corner — who it is and
 *  whether they're there, in one glance. */
function PresenceFace({ member, size }: { member: any; size: number }) {
  const Theme = useTheme();
  const dotColor = presenceColor(member.presence_state, Theme);
  return (
    <RNView>
      <ChatAvatar
        author={{ id: String(member._id), name: member.name || 'Teammate', avatarUrl: member.github_avatar_url || member.image, isAgent: member.is_bot }}
        size={size}
      />
      {dotColor && <RNView style={[styles.presenceDot, { backgroundColor: dotColor }]} />}
    </RNView>
  );
}

/** A 1:1 DM row wears the person's face; group DMs keep a neutral glyph (three
 *  faces at 15pt read as noise). */
function DmFace({ channel, viewerId, members }: { channel: any; viewerId: string; members?: any[] }) {
  const Theme = useTheme();
  const others = dmOtherIds(channel.dm_key, viewerId);
  const one = others.length === 1
    ? (members ?? []).find((m) => String(m._id) === others[0])
    : undefined;
  if (!one) {
    return (
      <RNView style={styles.glyphBox}>
        <FontAwesome name={others.length > 1 ? 'users' : 'user'} size={14} color={Theme.textMuted} />
      </RNView>
    );
  }
  return <PresenceFace member={one} size={36} />;
}

type ListItem =
  | { kind: 'header'; key: string; label: string; live?: boolean; action?: 'compose' }
  | { kind: 'live'; key: string; row: LiveRoomRow }
  | { kind: 'channel'; key: string; channel: any; rail?: ChannelRailRow; slack?: SlackMirrorState }
  | { kind: 'member'; key: string; member: any; inRoom: LiveRoomRow | null }
  | { kind: 'loading'; key: string }
  | { kind: 'notice'; key: string; icon: 'comments-o' | 'hashtag'; title: string; body: string };

export function ChatHomeList({
  teamId,
  teamName,
  chatOn,
  callsOn,
  currentUser,
  members,
  liveRooms,
  myRoomKey,
}: {
  teamId: Id<'teams'>;
  teamName: string;
  chatOn: boolean;
  callsOn: boolean;
  currentUser: any;
  members: any[] | undefined;
  liveRooms: LiveRoomRow[] | undefined;
  myRoomKey: string | null;
}) {
  const Theme = useTheme();
  const rail = useChatRail(teamId, chatOn);
  const router = useRouter();
  const openDm = useMutation(api.chat.openDm);
  const markRead = useMutation(api.chat.markRead);
  const setNotifyLevel = useMutation(api.chat.setNotifyLevel);
  const viewerId = String(currentUser?._id ?? '');

  // DM naming: the other side's names, resolved live from the roster — the
  // web rail's own rule, so a departed member or an agent reads the same
  // here as there.
  const displayName = (channel: any): string =>
    channelDisplayName(
      { name: channel.name, kind: channel.kind, dmMemberIds: channel.kind === 'dm' ? dmOtherIds(channel.dm_key, viewerId) : undefined },
      members,
    );

  const items = useMemo<ListItem[]>(() => {
    const out: ListItem[] = [];
    if (liveRooms && liveRooms.length > 0) {
      out.push({ kind: 'header', key: 'h-live', label: 'Live now', live: true });
      for (const row of liveRooms) out.push({ kind: 'live', key: `live-${row.roomKey}`, row });
    }
    if (chatOn) {
      if (rail === undefined) {
        out.push({ kind: 'header', key: 'h-ch', label: 'Channels' });
        for (let i = 0; i < 4; i++) out.push({ kind: 'loading', key: `sk-${i}` });
      } else {
        const channels = rail.rows.filter((r) => r.channel.kind !== 'dm');
        const dms = rail.rows.filter((r) => r.channel.kind === 'dm');
        out.push({ kind: 'header', key: 'h-ch', label: 'Channels' });
        if (channels.length === 0) {
          out.push({ kind: 'notice', key: 'n-ch', icon: 'hashtag', title: 'No channels yet', body: `Create one from the web to give ${teamName} a room.` });
        }
        for (const r of channels) out.push({ kind: 'channel', key: String(r.channel._id), channel: r.channel, rail: r.rail, slack: r.slack });
        out.push({ kind: 'header', key: 'h-dm', label: 'Direct messages', action: 'compose' });
        if (dms.length === 0) {
          out.push({ kind: 'notice', key: 'n-dm', icon: 'comments-o', title: 'No direct messages yet', body: 'Tap a teammate below to start one.' });
        }
        for (const r of dms) out.push({ kind: 'channel', key: String(r.channel._id), channel: r.channel, rail: r.rail });
      }
    } else {
      out.push({
        kind: 'notice', key: 'n-off', icon: 'comments-o', title: `Chat is off for ${teamName}`,
        body: 'A team admin can turn it on from the team settings on the web. People and huddles still work here.',
      });
    }
    // People: the roster, the present first. A person already sitting in a
    // huddle says so, and the headset joins them instead of ringing.
    const people = (members ?? [])
      .filter((m) => m && !m.is_bot && String(m._id) !== viewerId)
      .sort((a, b) => {
        const rank = (m: any) => (m.presence_state === 'active' ? 0 : m.presence_state === 'idle' ? 1 : 2);
        return rank(a) - rank(b) || (a.name ?? '').localeCompare(b.name ?? '');
      });
    out.push({ kind: 'header', key: 'h-people', label: `People${people.length ? ` · ${people.length}` : ''}` });
    if (members === undefined) {
      for (let i = 0; i < 3; i++) out.push({ kind: 'loading', key: `skp-${i}` });
    }
    for (const m of people) {
      const inRoom = (liveRooms ?? []).find((r) => r.members.some((x) => String(x.user_id) === String(m._id))) ?? null;
      out.push({ kind: 'member', key: `m-${m._id}`, member: m, inRoom });
    }
    return out;
  }, [rail, liveRooms, chatOn, members, viewerId, teamName]);

  const openChannel = (channel: any) =>
    router.push({ pathname: '/chat/[id]', params: { id: String(channel._id) } } as never);

  const openPerson = async (m: any) => {
    if (!chatOn) return;
    void Haptics.selectionAsync();
    try {
      const res = await openDm({ member_ids: [m._id] });
      router.push({ pathname: '/chat/[id]', params: { id: String(res.channel_id) } } as never);
    } catch {}
  };

  const huddleWith = (m: any, inRoom: LiveRoomRow | null) => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    if (inRoom && (inRoom.canJoin || inRoom.mine)) {
      void joinCall(inRoom.roomKey);
    } else {
      void startHuddle({ roomKey: dmRoomKey(viewerId, String(m._id)), toUserIds: [String(m._id)] });
    }
    router.push('/call');
  };

  // Hold a room for the things a swipe would hide: read it all, or change how
  // loudly it reaches you. Same three levels as the web rail.
  const channelActions = (channel: any, r?: ChannelRailRow) => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    const level = r?.notify_level ?? 'all';
    const options = [
      ...(r && r.unread > 0 ? ['Mark as read'] : []),
      `${level === 'all' ? '✓ ' : ''}Notify for everything`,
      `${level === 'mentions' ? '✓ ' : ''}Notify for mentions only`,
      `${level === 'none' ? '✓ ' : ''}Mute`,
      'Cancel',
    ];
    const run = (index: number) => {
      const picked = options[index];
      if (!picked || picked === 'Cancel') return;
      if (picked === 'Mark as read') void markRead({ channel_id: channel._id });
      else if (picked.endsWith('everything')) void setNotifyLevel({ channel_id: channel._id, notify_level: 'all' });
      else if (picked.endsWith('mentions only')) void setNotifyLevel({ channel_id: channel._id, notify_level: 'mentions' });
      else if (picked.endsWith('Mute')) void setNotifyLevel({ channel_id: channel._id, notify_level: 'none' });
    };
    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        { options, cancelButtonIndex: options.length - 1, title: displayName(channel) },
        run,
      );
    } else {
      Alert.alert(displayName(channel), undefined, options.map((text, i) => ({
        text, onPress: () => run(i), style: text === 'Cancel' ? ('cancel' as const) : undefined,
      })));
    }
  };

  return (
    <FlatList
      data={items}
      keyExtractor={(item) => item.key}
      contentContainerStyle={styles.listContent}
      showsVerticalScrollIndicator={false}
      renderItem={({ item }) => {
        switch (item.kind) {
          case 'header':
            return (
              <RNView style={styles.sectionHead}>
                {item.live && <LivePulse color={Theme.green} size={7} />}
                <RNText style={[styles.sectionLabel, item.live && styles.sectionLabelLive]}>{item.label}</RNText>
                {item.action === 'compose' && (
                  <TouchableOpacity
                    hitSlop={8}
                    onPress={() => router.push('/chat/new' as never)}
                    style={styles.sectionAction}
                    accessibilityLabel="New message"
                  >
                    <FontAwesome name="pencil-square-o" size={15} color={Theme.blue} />
                  </TouchableOpacity>
                )}
              </RNView>
            );
          case 'live':
            return <LiveRoomCard row={item.row} />;
          case 'loading':
            return <MemberSkeleton />;
          case 'notice':
            return (
              <RNView style={styles.notice}>
                <FontAwesome name={item.icon} size={16} color={Theme.textMuted0} />
                <RNView style={{ flex: 1 }}>
                  <RNText style={styles.noticeTitle}>{item.title}</RNText>
                  <RNText style={styles.noticeBody}>{item.body}</RNText>
                </RNView>
              </RNView>
            );
          case 'member': {
            const m = item.member;
            const line = item.inRoom
              ? `In a huddle${item.inRoom.redacted ? '' : ` · ${item.inRoom.label}`}`
              : m.title || PRESENCE_LINE[m.presence_state as string] || 'Offline';
            return (
              <TouchableOpacity
                style={styles.row}
                activeOpacity={chatOn ? 0.7 : 1}
                onPress={() => void openPerson(m)}
                accessibilityLabel={chatOn ? `Message ${m.name || 'teammate'}` : m.name || 'Teammate'}
              >
                <PresenceFace member={m} size={36} />
                <RNView style={styles.rowMain}>
                  <RNText style={styles.name} numberOfLines={1}>{m.name || m.github_username || 'Teammate'}</RNText>
                  <RNText style={[styles.preview, item.inRoom && { color: Theme.green }]} numberOfLines={1}>{line}</RNText>
                </RNView>
                {callsOn && (
                  <TouchableOpacity
                    style={[styles.huddleBtn, item.inRoom && styles.huddleBtnLive]}
                    onPress={() => huddleWith(m, item.inRoom)}
                    hitSlop={6}
                    accessibilityLabel={item.inRoom ? `Join ${m.name || 'teammate'}'s huddle` : `Huddle with ${m.name || 'teammate'}`}
                  >
                    <Ionicons name={item.inRoom ? 'headset' : 'headset-outline'} size={17} color={item.inRoom ? Theme.green : Theme.violet} />
                  </TouchableOpacity>
                )}
              </TouchableOpacity>
            );
          }
          case 'channel': {
            const { channel, rail: r } = item;
            const unread = (r?.unread ?? 0) > 0;
            const mentions = r?.unread_mentions ?? 0;
            const muted = r?.notify_level === 'none';
            const isDm = channel.kind === 'dm';
            return (
              <TouchableOpacity
                style={styles.row}
                activeOpacity={0.7}
                onPress={() => openChannel(channel)}
                onLongPress={() => channelActions(channel, r)}
                delayLongPress={350}
              >
                {isDm ? (
                  <DmFace channel={channel} viewerId={viewerId} members={members} />
                ) : (
                  <RNView style={[styles.glyphBox, unread && styles.glyphBoxUnread]}>
                    <FontAwesome
                      name={channel.kind === 'private' || channel.is_private ? 'lock' : 'hashtag'}
                      size={14}
                      color={unread ? Theme.text : Theme.textMuted}
                    />
                  </RNView>
                )}
                <RNView style={styles.rowMain}>
                  <RNView style={styles.rowHead}>
                    <RNText
                      style={[styles.name, unread && styles.nameUnread, muted && styles.nameMuted]}
                      numberOfLines={1}
                    >
                      {displayName(channel)}
                    </RNText>
                    {item.slack && (
                      <RNView accessibilityRole="image" accessibilityLabel={MIRROR_STATE_LABEL[item.slack]}>
                        <SlackLogo size={10} muted={item.slack !== 'live'} />
                      </RNView>
                    )}
                    {muted && <FontAwesome name="bell-slash-o" size={10} color={Theme.textMuted0} />}
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
                ) : unread ? (
                  <RNView style={[styles.dot, muted && styles.dotMuted]} />
                ) : null}
              </TouchableOpacity>
            );
          }
        }
      }}
    />
  );
}

const styles = themedStyles((Theme) => StyleSheet.create({
  listContent: { paddingBottom: 24 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.md,
    paddingVertical: 9,
    gap: 12,
  },
  glyphBox: {
    width: 36,
    height: 36,
    borderRadius: 10,
    backgroundColor: Theme.bgHighlight + '99',
    alignItems: 'center',
    justifyContent: 'center',
  },
  glyphBoxUnread: { backgroundColor: Theme.bgHighlight },
  rowMain: { flex: 1, minWidth: 0 },
  rowHead: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  name: { flex: 1, fontSize: 14.5, color: Theme.textSecondary },
  nameUnread: { color: Theme.text, fontWeight: '600' },
  nameMuted: { color: Theme.textMuted },
  time: { fontSize: 10.5, color: Theme.textMuted0 },
  preview: { fontSize: 12, color: Theme.textMuted0, marginTop: 2 },
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
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: Theme.blue },
  dotMuted: { backgroundColor: Theme.textMuted0 },
  huddleBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: Theme.violet + '16',
    alignItems: 'center',
    justifyContent: 'center',
  },
  huddleBtnLive: { backgroundColor: Theme.green + '1f' },
  sectionHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: Spacing.md,
    paddingTop: 16,
    paddingBottom: 6,
  },
  sectionLabel: {
    flex: 1,
    fontSize: 10.5,
    fontWeight: '700',
    letterSpacing: 0.8,
    textTransform: 'uppercase',
    color: Theme.textMuted0,
  },
  sectionLabelLive: { color: Theme.green },
  sectionAction: { padding: 2 },
  presenceDot: {
    position: 'absolute',
    right: -1,
    bottom: -1,
    width: 11,
    height: 11,
    borderRadius: 5.5,
    borderWidth: 2,
    borderColor: Theme.bg,
  },
  notice: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    marginHorizontal: Spacing.md,
    marginVertical: 4,
    padding: 12,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Theme.borderLight,
    backgroundColor: Theme.bgAlt + '80',
  },
  noticeTitle: { fontSize: 13, fontWeight: '600', color: Theme.textSecondary },
  noticeBody: { fontSize: 12, color: Theme.textMuted, marginTop: 2, lineHeight: 17 },
}));
