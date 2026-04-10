import { StyleSheet, FlatList, RefreshControl, TouchableOpacity, View as RNView, Text as RNText, ActionSheetIOS, Image } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useQuery, useMutation } from 'convex/react';
import { api } from '@codecast/convex/convex/_generated/api';
import { useState, useCallback, useMemo } from 'react';
import { useRouter } from 'expo-router';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import type { Id } from '@codecast/convex/convex/_generated/dataModel';
import { Theme, Spacing } from '@/constants/Theme';
import { SessionData, SessionItem, formatRelativeTime } from '@/components/SessionItem';
import { SessionListSkeleton, MemberSkeleton } from '@/components/SkeletonLoader';

const ICON_EMOJI: Record<string, string> = {
  rocket: '🚀', flame: '🔥', zap: '⚡', star: '⭐', diamond: '💎', crown: '👑',
  shield: '🛡️', sword: '⚔️', anchor: '⚓', compass: '🧭', mountain: '⛰️', tree: '🌲',
  sun: '☀️', moon: '🌙', cloud: '☁️', bolt: '🔩', atom: '⚛️', dna: '🧬',
  hexagon: '⬡', triangle: '🔺', cube: '🧊', sphere: '🔵', infinity: '♾️', omega: 'Ω',
};

type Segment = 'sessions' | 'members';

function getMemberStatus(daemonLastSeen: number | undefined): 'online' | 'recent' | 'offline' {
  if (!daemonLastSeen) return 'offline';
  const diff = Date.now() - daemonLastSeen;
  if (diff < 60000) return 'online';
  if (diff < 300000) return 'recent';
  return 'offline';
}

const STATUS_DOT_COLOR: Record<string, string> = {
  online: Theme.greenBright,
  recent: Theme.orange,
  offline: Theme.textMuted0,
};

const USER_STATUS_COLOR: Record<string, { bg: string; text: string }> = {
  available: { bg: Theme.green + '30', text: Theme.green },
  busy: { bg: Theme.red + '30', text: Theme.red },
  away: { bg: Theme.orange + '30', text: Theme.orange },
};

export default function TeamScreen() {
  const [refreshing, setRefreshing] = useState(false);
  const [segment, setSegment] = useState<Segment>('sessions');
  const router = useRouter();

  const currentUser = useQuery(api.users.getCurrentUser);
  const teams = useQuery(api.teams.getUserTeams);
  const saveActiveTeam = useMutation(api.teams.setActiveTeam);

  const activeTeamId = (currentUser?.active_team_id || currentUser?.team_id) as Id<"teams"> | undefined;
  const activeTeam = teams?.find((t: any) => t?._id === activeTeamId);
  const validTeams = useMemo(() => (teams?.filter(Boolean) ?? []) as NonNullable<NonNullable<typeof teams>[number]>[], [teams]);

  const teamMembers = useQuery(
    api.teams.getTeamMembers,
    activeTeamId ? { team_id: activeTeamId } : "skip"
  );

  const filteredMembers = useMemo(() => {
    if (!teamMembers) return [];
    return teamMembers.filter((m): m is NonNullable<typeof m> => m !== null);
  }, [teamMembers]);

  const teamConversations = useQuery(
    api.conversations.listConversations,
    activeTeamId ? {
      filter: "team" as const,
      activeTeamId,
      limit: 50,
      include_message_previews: true,
    } : "skip"
  );

  const sessions = useMemo(() => {
    if (!teamConversations?.conversations) return [];
    return teamConversations.conversations.map((c: any) => ({
      ...c,
      author_name: c.author_name ?? null,
      is_own: c.is_own ?? true,
      last_user_message: c.first_user_message || c.message_alternates?.find((m: any) => m.role === 'user')?.content || null,
      idle_summary: c.idle_summary || c.subtitle || null,
    })) as SessionData[];
  }, [teamConversations]);

  const handleTeamSwitch = useCallback(async (teamId: Id<"teams">) => {
    await saveActiveTeam({ team_id: teamId });
  }, [saveActiveTeam]);

  const showTeamPicker = useCallback(() => {
    if (validTeams.length <= 1) return;
    const options = [...validTeams.map(t => `${ICON_EMOJI[t.icon || ''] || t.icon || ''} ${t.name}`.trim()), 'Cancel'];
    ActionSheetIOS.showActionSheetWithOptions(
      { options, cancelButtonIndex: options.length - 1, title: 'Switch Team' },
      (index) => {
        if (index < validTeams.length) {
          handleTeamSwitch(validTeams[index]._id);
        }
      }
    );
  }, [validTeams, handleTeamSwitch]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    setTimeout(() => setRefreshing(false), 1000);
  }, []);

  if (!activeTeamId) {
    return (
      <SafeAreaView style={styles.container} edges={['top']}>
        <RNView style={styles.emptyContainer}>
          <FontAwesome name="users" size={28} color={Theme.textMuted0} />
          <RNText style={styles.emptyTitle}>No Team Yet</RNText>
          <RNText style={styles.emptySubtitle}>
            Join or create a team in Settings to see team sessions here.
          </RNText>
        </RNView>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <RNView style={styles.header}>
        <TouchableOpacity
          style={styles.teamButton}
          onPress={showTeamPicker}
          activeOpacity={validTeams.length > 1 ? 0.7 : 1}
        >
          {activeTeam?.icon ? (
            <RNText style={styles.teamIcon}>{ICON_EMOJI[activeTeam.icon] ?? activeTeam.icon}</RNText>
          ) : (
            <FontAwesome name="users" size={16} color={Theme.text} />
          )}
          <RNText style={styles.teamName} numberOfLines={1}>
            {activeTeam?.name || "Team"}
          </RNText>
          {validTeams.length > 1 && (
            <FontAwesome name="chevron-down" size={10} color={Theme.textMuted} />
          )}
        </TouchableOpacity>
        <RNView style={styles.segmentRow}>
          {(['sessions', 'members'] as const).map((s) => (
            <TouchableOpacity
              key={s}
              style={[styles.segmentTab, segment === s && styles.segmentTabActive]}
              onPress={() => setSegment(s)}
              activeOpacity={0.7}
            >
              <RNText style={[styles.segmentText, segment === s && styles.segmentTextActive]}>
                {s === 'sessions' ? 'Sessions' : `Members${filteredMembers.length ? ` (${filteredMembers.length})` : ''}`}
              </RNText>
            </TouchableOpacity>
          ))}
        </RNView>
      </RNView>

      {segment === 'sessions' ? (
        <FlatList
          data={sessions}
          renderItem={({ item }) => (
            <SessionItem
              session={item}
              onPress={() => router.push(`/session/${item._id}`)}
            />
          )}
          keyExtractor={(item) => item._id}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={Theme.textMuted} />
          }
          ListEmptyComponent={
            teamConversations === undefined ? <SessionListSkeleton count={6} /> : (
              <RNView style={styles.emptyContainer}>
                <RNText style={styles.emptySubtitle}>No team sessions yet</RNText>
              </RNView>
            )
          }
          contentContainerStyle={sessions.length === 0 ? styles.emptyList : styles.listContent}
          showsVerticalScrollIndicator={false}
        />
      ) : (
        <FlatList
          data={filteredMembers}
          renderItem={({ item: member }) => {
            const connStatus = getMemberStatus(member.daemon_last_seen);
            const avatar = member.github_avatar_url || member.image;
            return (
              <RNView style={styles.memberCard}>
                <RNView style={styles.memberAvatarWrap}>
                  {avatar ? (
                    <Image source={{ uri: avatar }} style={styles.memberAvatar} />
                  ) : (
                    <RNView style={styles.memberAvatarFallback}>
                      <RNText style={styles.memberAvatarLetter}>
                        {(member.name?.[0] || member.email?.[0] || '?').toUpperCase()}
                      </RNText>
                    </RNView>
                  )}
                  <RNView style={[styles.memberStatusDot, { backgroundColor: STATUS_DOT_COLOR[connStatus] }]} />
                </RNView>
                <RNView style={styles.memberInfo}>
                  <RNText style={styles.memberName} numberOfLines={1}>{member.name || 'Unnamed'}</RNText>
                  {member.title ? (
                    <RNText style={styles.memberTitle} numberOfLines={1}>{member.title}</RNText>
                  ) : (
                    <RNText style={styles.memberTitle} numberOfLines={1}>{member.email}</RNText>
                  )}
                  <RNView style={styles.memberBadgeRow}>
                    {member.status && (
                      <RNView style={[styles.memberBadge, { backgroundColor: (USER_STATUS_COLOR[member.status] || USER_STATUS_COLOR.away).bg }]}>
                        <RNText style={[styles.memberBadgeText, { color: (USER_STATUS_COLOR[member.status] || USER_STATUS_COLOR.away).text }]}>
                          {member.status}
                        </RNText>
                      </RNView>
                    )}
                    {member.role && (
                      <RNView style={[styles.memberBadge, { backgroundColor: member.role === 'admin' ? Theme.cyan + '25' : Theme.bgHighlight }]}>
                        <RNText style={[styles.memberBadgeText, { color: member.role === 'admin' ? Theme.cyan : Theme.textMuted }]}>
                          {member.role}
                        </RNText>
                      </RNView>
                    )}
                  </RNView>
                  {member.daemon_last_seen && (
                    <RNText style={styles.memberLastSeen}>
                      {connStatus === 'online' ? 'Online now' : formatRelativeTime(member.daemon_last_seen)}
                    </RNText>
                  )}
                  {member.recent_session_title && (
                    <RNText style={styles.memberRecentSession} numberOfLines={1}>
                      {member.recent_session_title}
                    </RNText>
                  )}
                </RNView>
              </RNView>
            );
          }}
          keyExtractor={(item) => item._id}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={Theme.textMuted} />
          }
          ListEmptyComponent={
            teamMembers === undefined ? (
              <RNView style={styles.listContent}>
                {Array.from({ length: 4 }).map((_, i) => <MemberSkeleton key={i} />)}
              </RNView>
            ) : (
              <RNView style={styles.emptyContainer}>
                <RNText style={styles.emptySubtitle}>No team members found</RNText>
              </RNView>
            )
          }
          contentContainerStyle={filteredMembers.length === 0 ? styles.emptyList : styles.listContent}
          showsVerticalScrollIndicator={false}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Theme.bg,
  },
  header: {
    backgroundColor: Theme.bgAlt,
    borderBottomWidth: 1,
    borderBottomColor: Theme.borderLight,
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 0,
  },
  teamButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 10,
  },
  teamIcon: {
    fontSize: 18,
  },
  teamName: {
    fontSize: 20,
    fontWeight: '700',
    color: Theme.text,
    flex: 1,
  },
  segmentRow: {
    flexDirection: 'row',
    gap: 0,
  },
  segmentTab: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 8,
    borderBottomWidth: 2,
    borderBottomColor: 'transparent',
  },
  segmentTabActive: {
    borderBottomColor: Theme.accent,
  },
  segmentText: {
    fontSize: 14,
    fontWeight: '500',
    color: Theme.textMuted,
  },
  segmentTextActive: {
    color: Theme.text,
    fontWeight: '600',
  },
  listContent: {
    paddingVertical: 4,
  },
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 32,
    gap: 12,
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: Theme.text,
  },
  emptySubtitle: {
    fontSize: 15,
    color: Theme.textMuted,
    textAlign: 'center',
  },
  emptyList: {
    flex: 1,
  },
  memberCard: {
    flexDirection: 'row',
    paddingHorizontal: Spacing.lg,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Theme.bgHighlight,
    gap: 12,
  },
  memberAvatarWrap: {
    position: 'relative',
  },
  memberAvatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
  },
  memberAvatarFallback: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: Theme.bgHighlight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  memberAvatarLetter: {
    fontSize: 18,
    fontWeight: '600',
    color: Theme.text,
  },
  memberStatusDot: {
    position: 'absolute',
    bottom: 0,
    right: 0,
    width: 12,
    height: 12,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: Theme.bg,
  },
  memberInfo: {
    flex: 1,
    justifyContent: 'center',
  },
  memberName: {
    fontSize: 15,
    fontWeight: '600',
    color: Theme.text,
    marginBottom: 1,
  },
  memberTitle: {
    fontSize: 13,
    color: Theme.textMuted,
    marginBottom: 4,
  },
  memberBadgeRow: {
    flexDirection: 'row',
    gap: 6,
    marginBottom: 3,
  },
  memberBadge: {
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 4,
  },
  memberBadgeText: {
    fontSize: 11,
    fontWeight: '600',
  },
  memberLastSeen: {
    fontSize: 11,
    color: Theme.textMuted0,
  },
  memberRecentSession: {
    fontSize: 12,
    color: Theme.textMuted,
    marginTop: 2,
  },
});
