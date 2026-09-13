import { StyleSheet, TouchableOpacity, View as RNView, ActionSheetIOS, useWindowDimensions } from 'react-native';
import { Text as RNText } from '@/components/Themed';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useQuery, useMutation } from 'convex/react';
import { api } from '@codecast/convex/convex/_generated/api';
import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { useRouter } from 'expo-router';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { teamFeatureEnabled } from '@codecast/shared/contracts';
import type { Id } from '@codecast/convex/convex/_generated/dataModel';
import { Spacing, themedStyles, useTheme } from '@/constants/Theme';
import { ChatHomeList, useChatRail } from '@/components/chat/ChannelList';
import { useLiveRooms } from '@/components/calls/LiveRooms';
import { getCallSnapshot, subscribeCall } from '@/lib/calls/callManager';

const TEAM_ICON_EMOJI: Record<string, string> = {
  rocket: '🚀', flame: '🔥', zap: '⚡', star: '⭐', diamond: '💎', crown: '👑',
  shield: '🛡️', sword: '⚔️', anchor: '⚓', compass: '🧭', mountain: '⛰️', tree: '🌲',
  sun: '☀️', moon: '🌙', cloud: '☁️', bolt: '🔩', atom: '⚛️', dna: '🧬',
  hexagon: '⬡', triangle: '🔺', cube: '🧊', sphere: '🔵', infinity: '♾️', omega: 'Ω',
};

// The Chat tab: the team talking, top level. Live huddles at the top so a
// running call is the first thing on the screen, then channels, direct
// messages and the people themselves. The team switcher lives in this header
// because chat and calls are per-team rooms.

export default function ChatScreen() {
  const Theme = useTheme();
  const router = useRouter();
  const { width } = useWindowDimensions();

  const currentUser = useQuery(api.users.getCurrentUser);
  const teams = useQuery(api.teams.getUserTeams);
  const saveActiveTeam = useMutation(api.teams.setActiveTeam);

  const activeTeamId = (currentUser?.active_team_id || currentUser?.team_id) as Id<'teams'> | undefined;
  const validTeams = useMemo(() => (teams?.filter(Boolean) ?? []) as NonNullable<NonNullable<typeof teams>[number]>[], [teams]);
  const activeTeam = validTeams.find((t) => t._id === activeTeamId);
  const teamName = activeTeam?.name || 'Team';

  // Chat and calls are per-team opt-ins (default off). getCallConfig lists
  // the caller's teams that have calls, and is false outright when the
  // deployment has no LiveKit.
  const chatOn = teamFeatureEnabled(activeTeam as any, 'chat');
  const callConfig = useQuery(api.calls.getCallConfig);
  const callsOn = callConfig?.enabled === true && !!activeTeamId && (callConfig.teams ?? []).includes(String(activeTeamId));

  const teamMembers = useQuery(api.teams.getTeamMembers, activeTeamId ? { team_id: activeTeamId } : 'skip');
  const members = useMemo(() => (teamMembers ?? []).filter(Boolean) as any[], [teamMembers]);
  const rail = useChatRail(activeTeamId, chatOn);
  const call = useSyncExternalStore(subscribeCall, getCallSnapshot, getCallSnapshot);
  const liveRooms = useLiveRooms(
    { members: teamMembers === undefined ? undefined : members, currentUser, channels: rail?.channels, rail: rail?.rail, myRoomKey: call.roomKey },
    callsOn,
  );

  const showTeamPicker = useCallback(() => {
    if (validTeams.length <= 1) return;
    void Haptics.selectionAsync();
    const options = [...validTeams.map((t) => `${TEAM_ICON_EMOJI[t.icon || ''] || t.icon || ''} ${t.name}`.trim()), 'Cancel'];
    ActionSheetIOS.showActionSheetWithOptions(
      { options, cancelButtonIndex: options.length - 1, title: 'Switch team' },
      (index) => {
        if (index < validTeams.length) void saveActiveTeam({ team_id: validTeams[index]._id });
      },
    );
  }, [validTeams, saveActiveTeam]);

  if (currentUser !== undefined && teams !== undefined && !activeTeamId) {
    return (
      <SafeAreaView style={styles.container} edges={['top']}>
        <RNView style={styles.header}>
          <RNText style={styles.headerTitle}>Chat</RNText>
        </RNView>
        <RNView style={styles.emptyContainer}>
          <FontAwesome name="comments-o" size={30} color={Theme.textMuted0} />
          <RNText style={styles.emptyTitle}>No team yet</RNText>
          <RNText style={styles.emptySubtitle}>
            Chat and huddles are team rooms. Join or create a team in Settings and they appear here.
          </RNText>
          <TouchableOpacity style={styles.emptyBtn} onPress={() => router.push('/(tabs)/settings' as never)} activeOpacity={0.7}>
            <RNText style={styles.emptyBtnText}>Open Settings</RNText>
          </TouchableOpacity>
        </RNView>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <RNView style={styles.header}>
        <RNText style={styles.headerTitle}>Chat</RNText>
        {activeTeam && (
          <TouchableOpacity
            style={styles.teamPill}
            onPress={showTeamPicker}
            activeOpacity={validTeams.length > 1 ? 0.7 : 1}
            accessibilityLabel={validTeams.length > 1 ? `Team: ${teamName}. Switch team` : `Team: ${teamName}`}
          >
            {activeTeam.icon ? (
              <RNText style={styles.teamIcon}>{TEAM_ICON_EMOJI[activeTeam.icon] ?? activeTeam.icon}</RNText>
            ) : (
              <FontAwesome name="users" size={11} color={Theme.textMuted} />
            )}
            <RNText style={[styles.teamName, { maxWidth: Math.max(80, width - 250) }]} numberOfLines={1}>{teamName}</RNText>
            {validTeams.length > 1 && <FontAwesome name="angle-down" size={11} color={Theme.textMuted0} />}
          </TouchableOpacity>
        )}
        <RNView style={{ flex: 1 }} />
        {callsOn && (
          <TouchableOpacity
            style={[styles.iconBtn, styles.iconBtnHuddle]}
            onPress={() => {
              void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              router.push({ pathname: '/chat/new', params: { huddle: '1' } } as never);
            }}
            activeOpacity={0.7}
            accessibilityLabel="Start a huddle"
          >
            <Ionicons name="headset" size={17} color={Theme.violet} />
          </TouchableOpacity>
        )}
        {chatOn && (
          <TouchableOpacity
            style={[styles.iconBtn, styles.iconBtnCompose]}
            onPress={() => {
              void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              router.push('/chat/new' as never);
            }}
            activeOpacity={0.7}
            accessibilityLabel="New message"
          >
            <FontAwesome name="pencil" size={15} color={Theme.blue} />
          </TouchableOpacity>
        )}
      </RNView>

      {activeTeamId ? (
        <ChatHomeList
          teamId={activeTeamId}
          teamName={teamName}
          chatOn={chatOn}
          callsOn={callsOn}
          currentUser={currentUser}
          members={teamMembers === undefined ? undefined : members}
          liveRooms={liveRooms}
          myRoomKey={call.roomKey}
        />
      ) : null}
    </SafeAreaView>
  );
}

const styles = themedStyles((Theme) => StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Theme.bg,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.lg,
    paddingTop: Spacing.md,
    paddingBottom: Spacing.sm,
    backgroundColor: Theme.bgAlt,
    borderBottomWidth: 1,
    borderBottomColor: Theme.borderLight,
    gap: 8,
  },
  headerTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: Theme.text,
  },
  teamPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    height: 26,
    paddingHorizontal: 9,
    borderRadius: 13,
    backgroundColor: Theme.bgHighlight,
  },
  teamIcon: { fontSize: 12 },
  teamName: { fontSize: 12, fontWeight: '600', color: Theme.textSecondary },
  iconBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconBtnHuddle: { backgroundColor: Theme.violet + '18' },
  iconBtnCompose: { backgroundColor: Theme.blue + '18' },
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
    fontSize: 14,
    color: Theme.textMuted,
    textAlign: 'center',
    lineHeight: 20,
  },
  emptyBtn: {
    marginTop: 4,
    height: 36,
    paddingHorizontal: 16,
    borderRadius: 18,
    backgroundColor: Theme.blue,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyBtnText: { fontSize: 13, fontWeight: '700', color: Theme.bg },
}));
