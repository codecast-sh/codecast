import { useMemo, useSyncExternalStore } from 'react';
import { StyleSheet, FlatList, TouchableOpacity, View as RNView } from 'react-native';
import { Text as RNText } from '@/components/Themed';
import { useRouter } from 'expo-router';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { Theme, Spacing, themedStyles, useTheme } from '@/constants/Theme';
import { formatRelativeTime } from '@/components/SessionItem';
import { MemberSkeleton } from '@/components/SkeletonLoader';
import { channelDisplayName } from '@codecast/web/lib/chatViews';
import { MIRROR_STATE_LABEL } from '@codecast/convex/convex/lib/slackMirror';
import { useChatRail } from '@codecast/web/hooks/useChatSync';
import { isChatRailLive, subscribeChatRailLive } from '@codecast/web/lib/chatLive';
import { useInboxStore, type ChatRailChannel } from '@codecast/web/store/inboxStore';
import { SlackLogo } from '@/components/SlackLogo';
import { ChatAvatar } from './MessageRow';
import { LivePulse, LiveRoomCard, type LiveRoomRow } from '@/components/calls/LiveRooms';
import { openDmWith, huddleWith as huddleWithPerson, liveRoomOf } from './personActions';
import { isPerson } from '@codecast/shared/team/memberKind';
import { showActionSheet } from '@/lib/popups';

// The Chat tab's home list: live huddles first, then channels, then direct
// messages, then the team's people. One FlatList, four kinds of row.
//
// Signal rules are the same as the web rail, deliberately: unread is carried by
// WEIGHT (bold name, brighter preview), a muted channel with unread gets a dot,
// and only mentions of you get a number. One count that includes ordinary
// chatter teaches people to ignore counts.

/** The rail is ready to paint: the store holds a rail (cached or live) or the
 *  server has answered this launch. Only a genuinely cold cache shows rows of
 *  skeleton; an empty team after a live answer shows its empty state. */
function useRailKnown(): boolean {
  const live = useSyncExternalStore(subscribeChatRailLive, isChatRailLive, () => false);
  const cached = useInboxStore((s: any) => (s.chatRail?.length ?? 0) > 0);
  return live || cached;
}

/** Every row's leading tile: a face, or a glyph in a square of the same size. */
const FACE = 44;

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
function DmFace({ channel, members }: { channel: ChatRailChannel; members?: any[] }) {
  const Theme = useTheme();
  const others = channel.dmMemberIds ?? [];
  const one = others.length === 1
    ? (members ?? []).find((m) => String(m._id) === others[0])
    : undefined;
  if (!one) {
    return (
      <RNView style={styles.glyphBox}>
        <FontAwesome name={others.length > 1 ? 'users' : 'user'} size={17} color={Theme.textMuted} />
      </RNView>
    );
  }
  return <PresenceFace member={one} size={FACE} />;
}

type ListItem =
  | { kind: 'header'; key: string; label: string; live?: boolean; action?: 'compose' }
  | { kind: 'live'; key: string; row: LiveRoomRow }
  | { kind: 'channel'; key: string; channel: ChatRailChannel }
  | { kind: 'member'; key: string; member: any; inRoom: LiveRoomRow | null }
  | { kind: 'loading'; key: string }
  | { kind: 'notice'; key: string; icon: 'comments-o' | 'hashtag'; title: string; body: string };

export function ChatHomeList({
  teamName,
  chatOn,
  callsOn,
  currentUser,
  members,
  liveRooms,
  myRoomKey,
}: {
  teamName: string;
  chatOn: boolean;
  callsOn: boolean;
  currentUser: any;
  members: any[];
  liveRooms: LiveRoomRow[] | undefined;
  myRoomKey: string | null;
}) {
  const Theme = useTheme();
  // The shared rail off the store (useChatChannelsSync feeds it app-wide):
  // sorted, counted and scoped to the active team, cached across launches.
  const rail = useChatRail();
  const railKnown = useRailKnown();
  const router = useRouter();
  const viewerId = String(currentUser?._id ?? '');

  // DM naming: the other side's names, resolved live from the roster — the
  // web rail's own rule, so a departed member or an agent reads the same
  // here as there.
  const displayName = (channel: ChatRailChannel): string => channelDisplayName(channel, members);

  const items = useMemo<ListItem[]>(() => {
    const out: ListItem[] = [];
    if (liveRooms && liveRooms.length > 0) {
      out.push({ kind: 'header', key: 'h-live', label: 'Live now', live: true });
      for (const row of liveRooms) out.push({ kind: 'live', key: `live-${row.roomKey}`, row });
    }
    if (chatOn) {
      if (!railKnown && rail.length === 0) {
        out.push({ kind: 'header', key: 'h-ch', label: 'Channels' });
        for (let i = 0; i < 4; i++) out.push({ kind: 'loading', key: `sk-${i}` });
      } else {
        const channels = rail.filter((c) => c.kind !== 'dm');
        const dms = rail.filter((c) => c.kind === 'dm');
        out.push({ kind: 'header', key: 'h-ch', label: 'Channels' });
        if (channels.length === 0) {
          out.push({ kind: 'notice', key: 'n-ch', icon: 'hashtag', title: 'No channels yet', body: `Create one from the web to give ${teamName} a room.` });
        }
        for (const c of channels) out.push({ kind: 'channel', key: c.id, channel: c });
        out.push({ kind: 'header', key: 'h-dm', label: 'Direct messages', action: 'compose' });
        if (dms.length === 0) {
          out.push({ kind: 'notice', key: 'n-dm', icon: 'comments-o', title: 'No direct messages yet', body: 'Tap a teammate below to start one.' });
        }
        for (const c of dms) out.push({ kind: 'channel', key: c.id, channel: c });
      }
    } else {
      out.push({
        kind: 'notice', key: 'n-off', icon: 'comments-o', title: `Chat is off for ${teamName}`,
        body: 'A team admin can turn it on from the team settings on the web. People and huddles still work here.',
      });
    }
    // People: the roster, the present first. A person already sitting in a
    // huddle says so, and the headset joins them instead of ringing.
    const people = members
      .filter((m) => isPerson(m) && String(m._id) !== viewerId)
      .sort((a, b) => {
        const rank = (m: any) => (m.presence_state === 'active' ? 0 : m.presence_state === 'idle' ? 1 : 2);
        return rank(a) - rank(b) || (a.name ?? '').localeCompare(b.name ?? '');
      });
    out.push({ kind: 'header', key: 'h-people', label: `People${people.length ? ` · ${people.length}` : ''}` });
    if (members.length === 0) {
      for (let i = 0; i < 3; i++) out.push({ kind: 'loading', key: `skp-${i}` });
    }
    for (const m of people) {
      const inRoom = liveRoomOf(liveRooms, String(m._id));
      out.push({ kind: 'member', key: `m-${m._id}`, member: m, inRoom });
    }
    return out;
  }, [rail, railKnown, liveRooms, chatOn, members, viewerId, teamName]);

  const openChannel = (channel: ChatRailChannel) =>
    router.push({ pathname: '/chat/[id]', params: { id: channel.id } } as never);

  const openPerson = (m: any) => {
    if (chatOn) openDmWith(router, String(m._id));
  };

  const huddleWith = (m: any, inRoom: LiveRoomRow | null) => huddleWithPerson(router, viewerId, String(m._id), inRoom);

  // Hold a room for the things a swipe would hide: read it all, or change how
  // loudly it reaches you. Same three levels as the web rail.
  const channelActions = (channel: ChatRailChannel) => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    const level = channel.notifyLevel;
    const store = useInboxStore.getState();
    showActionSheet(displayName(channel), [
      ...((channel.unreadCount ?? 0) > 0 ? [{ label: 'Mark as read', icon: 'check-circle' as const, onPress: () => store.markChannelRead(channel.id) }] : []),
      { label: 'Notify for everything', icon: 'bell', selected: level === 'all', onPress: () => store.setChannelNotifyLevel(channel.id, 'all') },
      { label: 'Notify for mentions only', icon: 'at-sign', selected: level === 'mentions', onPress: () => store.setChannelNotifyLevel(channel.id, 'mentions') },
      { label: 'Mute', icon: 'bell-off', selected: level === 'none', onPress: () => store.setChannelNotifyLevel(channel.id, 'none') },
    ]);
  };

  return (
    <FlatList
      data={items}
      keyExtractor={(item) => item.key}
      contentContainerStyle={styles.listContent}
      showsVerticalScrollIndicator={false}
      ItemSeparatorComponent={({ leadingItem }: { leadingItem: ListItem }) =>
        leadingItem.kind === 'channel' || leadingItem.kind === 'member' ? <RNView style={styles.separator} /> : null}
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
                    <FontAwesome name="pencil-square-o" size={18} color={Theme.blue} />
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
                onPress={() => openPerson(m)}
                accessibilityLabel={chatOn ? `Message ${m.name || 'teammate'}` : m.name || 'Teammate'}
              >
                <PresenceFace member={m} size={FACE} />
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
                    <Ionicons name={item.inRoom ? 'headset' : 'headset-outline'} size={19} color={item.inRoom ? Theme.green : Theme.violet} />
                  </TouchableOpacity>
                )}
              </TouchableOpacity>
            );
          }
          case 'channel': {
            const { channel } = item;
            const unread = (channel.unreadCount ?? 0) > 0;
            const mentions = channel.mentionCount ?? 0;
            const muted = !!channel.muted;
            const isDm = channel.kind === 'dm';
            return (
              <TouchableOpacity
                style={styles.row}
                activeOpacity={0.7}
                onPress={() => openChannel(channel)}
                onLongPress={() => channelActions(channel)}
                delayLongPress={350}
              >
                {isDm ? (
                  <DmFace channel={channel} members={members} />
                ) : (
                  <RNView style={[styles.glyphBox, unread && styles.glyphBoxUnread]}>
                    <FontAwesome
                      name={channel.isPrivate ? 'lock' : 'hashtag'}
                      size={18}
                      color={unread ? Theme.accent : Theme.textMuted}
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
                    {/* A healthy Slack mirror is the normal state and says
                        nothing; the mark shows only when it needs attention. */}
                    {channel.slack && channel.slack.state !== 'live' && (
                      <RNView accessibilityRole="image" accessibilityLabel={MIRROR_STATE_LABEL[channel.slack.state]}>
                        <SlackLogo size={12} muted />
                      </RNView>
                    )}
                    {muted && <FontAwesome name="bell-slash-o" size={12} color={Theme.textMuted0} />}
                    {channel.lastMessagePreview !== undefined && (
                      <RNText style={[styles.time, unread && !muted && styles.timeUnread]}>
                        {formatRelativeTime(channel.sortAt)}
                      </RNText>
                    )}
                  </RNView>
                  <RNView style={styles.previewRow}>
                    {channel.lastMessagePreview !== undefined && channel.lastMessageFromAgent && (
                      <FontAwesome name="microchip" size={11} color={Theme.violet} />
                    )}
                    <RNText
                      style={[styles.preview, unread && !muted && styles.previewUnread]}
                      numberOfLines={1}
                    >
                      {channel.lastMessagePreview !== undefined
                        ? channel.lastMessagePreview
                        : channel.topic || 'No messages yet'}
                    </RNText>
                    {mentions > 0 ? (
                      <RNView style={styles.badge}>
                        <RNText style={styles.badgeText}>{mentions > 99 ? '99+' : mentions}</RNText>
                      </RNView>
                    ) : unread ? (
                      <RNView style={[styles.dot, muted && styles.dotMuted]} />
                    ) : null}
                  </RNView>
                </RNView>
              </TouchableOpacity>
            );
          }
        }
      }}
    />
  );
}

const styles = themedStyles((Theme) => StyleSheet.create({
  listContent: { paddingBottom: 32 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.md,
    paddingVertical: 11,
    gap: 14,
    minHeight: 68,
  },
  // Rules start where the words do, so each row's tile stands clear.
  separator: {
    height: StyleSheet.hairlineWidth,
    marginLeft: Spacing.md + FACE + 14,
    backgroundColor: Theme.border + '70',
  },
  glyphBox: {
    width: FACE,
    height: FACE,
    borderRadius: 12,
    backgroundColor: Theme.bgHighlight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  glyphBoxUnread: { backgroundColor: Theme.accent + '2E' },
  rowMain: { flex: 1, minWidth: 0, gap: 3 },
  rowHead: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  name: { flex: 1, fontSize: 15.5, fontWeight: '500', color: Theme.text },
  nameUnread: { fontWeight: '700' },
  nameMuted: { color: Theme.textMuted },
  time: { fontSize: 12, color: Theme.textMuted0 },
  timeUnread: { color: Theme.accent, fontWeight: '600' },
  previewRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  preview: { flex: 1, fontSize: 13.5, color: Theme.textMuted0 },
  previewUnread: { color: Theme.textSecondary },
  badge: {
    minWidth: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: Theme.red,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 6,
  },
  badgeText: { fontSize: 11, fontWeight: '700', color: '#fff' },
  dot: { width: 10, height: 10, borderRadius: 5, backgroundColor: Theme.accent },
  dotMuted: { backgroundColor: Theme.textMuted0 },
  huddleBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
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
    paddingTop: 26,
    paddingBottom: 6,
  },
  sectionLabel: {
    flex: 1,
    fontSize: 11.5,
    fontWeight: '700',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    color: Theme.textMuted,
  },
  sectionLabelLive: { color: Theme.green },
  sectionAction: { padding: 4 },
  presenceDot: {
    position: 'absolute',
    right: -2,
    bottom: -2,
    width: 14,
    height: 14,
    borderRadius: 7,
    borderWidth: 2.5,
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
  noticeTitle: { fontSize: 13.5, fontWeight: '600', color: Theme.textSecondary },
  noticeBody: { fontSize: 12.5, color: Theme.textMuted, marginTop: 2, lineHeight: 17 },
}));
