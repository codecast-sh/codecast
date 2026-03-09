import { StyleSheet, FlatList, RefreshControl, View as RNView, Text as RNText } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useQuery } from 'convex/react';
import { api } from '@codecast/convex/convex/_generated/api';
import { useState, useCallback, useMemo } from 'react';
import { useRouter } from 'expo-router';
import { Theme, Spacing } from '@/constants/Theme';
import { SessionData, SessionItem } from '@/components/SessionItem';

function getDateGroup(timestamp: number, now: number): string {
  const diffMs = now - timestamp;
  const diffHours = diffMs / 3600000;
  const diffDays = diffMs / 86400000;
  if (diffHours < 1) return "Last Hour";
  if (diffHours < 6) return "Last 6 Hours";
  if (diffDays < 1) return "Today";
  if (diffDays < 2) return "Yesterday";
  if (diffDays < 7) return "This Week";
  if (diffDays < 30) return "This Month";
  return "Older";
}

const GROUP_ORDER = ["Last Hour", "Last 6 Hours", "Today", "Yesterday", "This Week", "This Month", "Older"];

type SectionItem = { type: 'header'; group: string } | { type: 'session'; session: SessionData };

export default function SessionsScreen() {
  const [refreshing, setRefreshing] = useState(false);
  const router = useRouter();

  const conversations = useQuery(api.conversations.listConversations, {
    filter: "my" as const,
    limit: 100,
    include_message_previews: true,
  });

  const sections = useMemo(() => {
    if (!conversations?.conversations) return [];
    const now = Date.now();
    const grouped: Record<string, SessionData[]> = {};

    for (const c of conversations.conversations as any[]) {
      const session: SessionData = {
        ...c,
        last_user_message: c.first_user_message || null,
        idle_summary: c.idle_summary || c.subtitle || null,
      };
      const group = getDateGroup(c.updated_at, now);
      if (!grouped[group]) grouped[group] = [];
      grouped[group].push(session);
    }

    const items: SectionItem[] = [];
    for (const group of GROUP_ORDER) {
      const sessions = grouped[group];
      if (!sessions?.length) continue;
      items.push({ type: 'header', group });
      for (const s of sessions) {
        items.push({ type: 'session', session: s });
      }
    }
    return items;
  }, [conversations]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    setTimeout(() => setRefreshing(false), 1000);
  }, []);

  const renderItem = useCallback(({ item }: { item: SectionItem }) => {
    if (item.type === 'header') {
      return (
        <RNView style={styles.sectionHeader}>
          <RNText style={styles.sectionHeaderText}>{item.group}</RNText>
        </RNView>
      );
    }
    return (
      <SessionItem
        session={item.session}
        onPress={() => router.push(`/session/${item.session._id}`)}
      />
    );
  }, [router]);

  const keyExtractor = useCallback((item: SectionItem) => {
    return item.type === 'header' ? `header-${item.group}` : (item as any).session._id;
  }, []);

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <RNView style={styles.header}>
        <RNText style={styles.headerTitle}>Sessions</RNText>
      </RNView>

      <FlatList
        data={sections}
        renderItem={renderItem}
        keyExtractor={keyExtractor}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={Theme.textMuted} />
        }
        ListEmptyComponent={
          conversations === undefined ? null : (
            <RNView style={styles.emptyContainer}>
              <RNText style={styles.emptySubtitle}>No sessions yet</RNText>
            </RNView>
          )
        }
        contentContainerStyle={sections.length === 0 ? styles.emptyList : styles.listContent}
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
  headerTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: Theme.text,
  },
  sectionHeader: {
    paddingHorizontal: Spacing.lg,
    paddingTop: 16,
    paddingBottom: 6,
    backgroundColor: Theme.bg,
  },
  sectionHeaderText: {
    fontSize: 11,
    fontWeight: '600',
    color: Theme.textMuted0,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  },
  listContent: {
    paddingBottom: 20,
  },
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 32,
    gap: 12,
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
