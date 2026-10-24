import { useMemo } from 'react';
import { ActivityIndicator, FlatList, StyleSheet, View as RNView } from 'react-native';
import { Text as RNText } from '@/components/Themed';
import { useRouter } from 'expo-router';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import { useInboxStore } from '@codecast/web/store/inboxStore';
import { useTeamFeed } from '@codecast/web/hooks/useTeamFeed';
import { Spacing, themedStyles, useTheme } from '@/constants/Theme';
import { InboxRowEnvProvider, SessionItem, type SessionData } from '@/components/SessionItem';
import { SessionListSkeleton } from '@/components/SkeletonLoader';

/** The team's sessions, newest first: the web's team Activity feed on the
 *  phone. Rows come from the shared store (useTeamFeed), so a cached feed
 *  paints at once; the roster is the one the sync bridge feeds. */
export function TeamActivityList({ teamName }: { teamName: string }) {
  const Theme = useTheme();
  const router = useRouter();
  const members = useInboxStore((s) => s.teamMembers) as any[] | undefined;
  const roster = useMemo(() => (Array.isArray(members) ? members.filter(Boolean) : undefined), [members]);
  const { rows, hasMore, loadMore, loadingMore, isLoading } = useTeamFeed({ members: roster });

  const sessions = useMemo(() => [...rows]
    .sort((a: any, b: any) => (b.updated_at ?? 0) - (a.updated_at ?? 0))
    .map((c: any) => ({
      ...c,
      author_name: c.author_name ?? null,
      is_own: c.is_own ?? false,
      is_idle: !c.is_active,
      last_user_message: c.first_user_message || c.message_alternates?.find((m: any) => m.role === 'user')?.content || null,
      idle_summary: c.idle_summary || c.subtitle || null,
    })) as SessionData[], [rows]);

  if (sessions.length === 0) {
    if (isLoading) return <SessionListSkeleton />;
    return (
      <RNView style={styles.empty}>
        <FontAwesome name="users" size={28} color={Theme.textMuted0} />
        <RNText style={styles.emptyTitle}>No team sessions yet</RNText>
        <RNText style={styles.emptyBody}>Sessions {teamName} shares show up here.</RNText>
      </RNView>
    );
  }

  return (
    <InboxRowEnvProvider>
      <FlatList
        data={sessions}
        keyExtractor={(s) => s._id}
        renderItem={({ item }) => (
          <SessionItem session={item} onPress={() => router.push(`/session/${item._id}` as never)} />
        )}
        onEndReached={() => { if (hasMore) void loadMore(); }}
        onEndReachedThreshold={0.6}
        ListFooterComponent={loadingMore ? <ActivityIndicator style={styles.footer} color={Theme.textMuted} /> : null}
        contentInsetAdjustmentBehavior="automatic"
      />
    </InboxRowEnvProvider>
  );
}

const styles = themedStyles((Theme) => StyleSheet.create({
  empty: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 32, gap: 10 },
  emptyTitle: { fontSize: 17, fontWeight: '600', color: Theme.text },
  emptyBody: { fontSize: 14, color: Theme.textMuted, textAlign: 'center' },
  footer: { paddingVertical: Spacing.lg },
}));
