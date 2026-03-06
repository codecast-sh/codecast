import { StyleSheet, FlatList, RefreshControl, TouchableOpacity, View as RNView, Text as RNText, ActionSheetIOS } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useQuery, useMutation } from 'convex/react';
import { api } from '@codecast/convex/convex/_generated/api';
import { useState, useCallback, useMemo } from 'react';
import { useRouter } from 'expo-router';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import type { Id } from '@codecast/convex/convex/_generated/dataModel';
import { Theme } from '@/constants/Theme';
import { SessionData, SessionItem } from '@/components/SessionItem';

const ICON_EMOJI: Record<string, string> = {
  rocket: '🚀', flame: '🔥', zap: '⚡', star: '⭐', diamond: '💎', crown: '👑',
  shield: '🛡️', sword: '⚔️', anchor: '⚓', compass: '🧭', mountain: '⛰️', tree: '🌲',
  sun: '☀️', moon: '🌙', cloud: '☁️', bolt: '🔩', atom: '⚛️', dna: '🧬',
  hexagon: '⬡', triangle: '🔺', cube: '🧊', sphere: '🔵', infinity: '♾️', omega: 'Ω',
};

export default function TeamScreen() {
  const [refreshing, setRefreshing] = useState(false);
  const router = useRouter();

  const currentUser = useQuery(api.users.getCurrentUser);
  const teams = useQuery(api.teams.getUserTeams);
  const saveActiveTeam = useMutation(api.teams.setActiveTeam);

  const activeTeamId = (currentUser?.active_team_id || currentUser?.team_id) as Id<"teams"> | undefined;
  const activeTeam = teams?.find(t => t?._id === activeTeamId);
  const validTeams = useMemo(() => (teams?.filter(Boolean) ?? []) as NonNullable<NonNullable<typeof teams>[number]>[], [teams]);

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
      </RNView>

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
          teamConversations === undefined ? null : (
            <RNView style={styles.emptyContainer}>
              <RNText style={styles.emptySubtitle}>No team sessions yet</RNText>
            </RNView>
          )
        }
        contentContainerStyle={sessions.length === 0 ? styles.emptyList : styles.listContent}
        showsVerticalScrollIndicator={false}
      />
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
    paddingVertical: 12,
  },
  teamButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
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
});
