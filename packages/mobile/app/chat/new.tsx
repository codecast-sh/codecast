import { useMemo, useState } from 'react';
import { StyleSheet, FlatList, TouchableOpacity, View as RNView } from 'react-native';
import { Text as RNText, TextInput as ThemedTextInput } from '@/components/Themed';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, Stack, useLocalSearchParams } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { Ionicons } from '@expo/vector-icons';
import { dmRoomKey } from '@codecast/shared/contracts';
import { startHuddle } from '@/lib/calls/callManager';
import { useInboxStore } from '@codecast/web/store/inboxStore';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import { Theme, Spacing, themedStyles, useTheme } from '@/constants/Theme';
import { ChatAvatar } from '@/components/chat/MessageRow';
import { isPerson } from '@codecast/shared/team/memberKind';

// New message: pick one teammate and land in the 1:1, or several and land in
// the group. openDmChannel is idempotent on the member set and local-first:
// a room the store holds answers with its real id, a new one with a stub the
// server row supersedes, so the screen moves in the same tick either way.
//
// With `huddle=1` the same picker starts a call instead: one person rings
// their 1:1 room, several ring the group's room (the same keys web's chips
// use), and the call stage opens.

export default function NewMessageScreen() {
  const Theme = useTheme();
  const router = useRouter();
  const { huddle } = useLocalSearchParams<{ huddle?: string }>();
  const huddleMode = huddle === '1';
  // The active team's roster, off the store the sync bridge feeds.
  const viewerId = useInboxStore((s) => (s.currentUser?._id ? String(s.currentUser._id) : ''));
  const teamMembers = useInboxStore((s) => s.teamMembers) as any[];

  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<string[]>([]);

  const candidates = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (teamMembers ?? [])
      .filter((m: any) => isPerson(m) && String(m._id) !== viewerId)
      .filter((m: any) =>
        !needle
        || (m.name ?? '').toLowerCase().includes(needle)
        || (m.github_username ?? '').toLowerCase().includes(needle))
      .sort((a: any, b: any) => {
        // The people who are around sort first — a DM is usually to someone
        // you expect to answer.
        const rank = (m: any) => (m.presence_state === 'active' ? 0 : m.presence_state === 'idle' ? 1 : 2);
        return rank(a) - rank(b) || (a.name ?? '').localeCompare(b.name ?? '');
      });
  }, [teamMembers, q, viewerId]);

  const open = (ids: string[]) => {
    if (ids.length === 0) return;
    if (huddleMode) {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      void startHuddle({ roomKey: dmRoomKey(viewerId, ids), toUserIds: ids });
      router.replace('/call');
      return;
    }
    const channelId = useInboxStore.getState().openDmChannel(ids);
    router.replace({ pathname: '/chat/[id]', params: { id: channelId } } as never);
  };

  const toggle = (id: string) =>
    setPicked((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <Stack.Screen options={{ headerShown: false }} />
      <RNView style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={10} style={styles.back}>
          <FontAwesome name="chevron-left" size={16} color={Theme.textMuted} />
        </TouchableOpacity>
        <RNText style={styles.title}>{huddleMode ? 'Start a huddle' : 'New message'}</RNText>
        {picked.length > 0 && (
          <TouchableOpacity style={[styles.go, huddleMode && styles.goHuddle]} onPress={() => open(picked)}>
            {huddleMode ? (
              <RNView style={styles.goRow}>
                <Ionicons name="headset" size={13} color={Theme.bg} />
                <RNText style={styles.goText}>Ring{picked.length > 1 ? ` ${picked.length}` : ''}</RNText>
              </RNView>
            ) : (
              <RNText style={styles.goText}>
                Open{picked.length > 1 ? ` (${picked.length})` : ''}
              </RNText>
            )}
          </TouchableOpacity>
        )}
      </RNView>

      <RNView style={styles.search}>
        <FontAwesome name="search" size={12} color={Theme.textMuted0} />
        <ThemedTextInput
          style={styles.searchInput}
          placeholder="Search teammates"
          value={q}
          onChangeText={setQ}
          autoFocus
          autoCorrect={false}
        />
      </RNView>

      <FlatList
        data={candidates}
        keyExtractor={(m: any) => String(m._id)}
        keyboardShouldPersistTaps="always"
        renderItem={({ item: m }: { item: any }) => {
          const id = String(m._id);
          const on = picked.includes(id);
          const presence = m.presence_state as string | undefined;
          const dotColor = presence === 'active' ? Theme.green : presence === 'idle' ? Theme.accent : null;
          const line = presence === 'active' ? 'Active now' : presence === 'idle' ? 'Idle' : presence === 'away' ? 'Away' : 'Offline';
          return (
            <TouchableOpacity
              style={[styles.row, on && styles.rowOn]}
              activeOpacity={0.7}
              // Tap = open the 1:1 now (the common case). Long-press = start
              // picking a group.
              onPress={() => (picked.length ? toggle(id) : open([id]))}
              onLongPress={() => toggle(id)}
            >
              <RNView>
                <ChatAvatar
                  author={{ id, name: m.name || 'Teammate', avatarUrl: m.github_avatar_url || m.image }}
                  size={30}
                />
                {dotColor && <RNView style={[styles.presenceDot, { backgroundColor: dotColor }]} />}
              </RNView>
              <RNView style={styles.rowMain}>
                <RNText style={styles.name} numberOfLines={1}>{m.name || m.github_username || 'Teammate'}</RNText>
                <RNText style={styles.presence}>{line}</RNText>
              </RNView>
              {on ? (
                <FontAwesome name="check-circle" size={16} color={huddleMode ? Theme.violet : Theme.blue} />
              ) : huddleMode ? (
                <Ionicons name="headset-outline" size={16} color={Theme.violet} />
              ) : null}
            </TouchableOpacity>
          );
        }}
        ListEmptyComponent={
          // An empty roster is a cold cache (a team always holds the viewer).
          (teamMembers ?? []).length === 0 ? null : (
            <RNText style={styles.emptyText}>Nobody matches</RNText>
          )
        }
      />
      {picked.length === 0 && (
        <RNText style={styles.hint}>
          {huddleMode ? 'Tap to ring · hold to ring a group' : 'Tap to message · hold to start a group'}
        </RNText>
      )}
    </SafeAreaView>
  );
}

const styles = themedStyles((Theme) => StyleSheet.create({
  container: { flex: 1, backgroundColor: Theme.bg },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: Spacing.md,
    paddingVertical: 10,
  },
  back: { paddingRight: 6 },
  title: { flex: 1, fontSize: 15, fontWeight: '600', color: Theme.text },
  go: {
    minWidth: 64,
    height: 30,
    borderRadius: 15,
    backgroundColor: Theme.blue,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 12,
  },
  goText: { fontSize: 12.5, fontWeight: '700', color: Theme.bg },
  search: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginHorizontal: Spacing.md,
    marginBottom: 6,
    paddingHorizontal: 10,
    borderWidth: 1,
    borderColor: Theme.border + '66',
    borderRadius: 9,
    backgroundColor: Theme.bgAlt + '55',
  },
  searchInput: { flex: 1, paddingVertical: 8, fontSize: 13.5, color: Theme.text },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: Spacing.md,
    paddingVertical: 9,
  },
  rowOn: { backgroundColor: Theme.blue + '14' },
  goHuddle: { backgroundColor: Theme.violet },
  goRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  rowMain: { flex: 1, minWidth: 0 },
  name: { fontSize: 14, color: Theme.text },
  presence: { fontSize: 10.5, color: Theme.textMuted0, marginTop: 1 },
  presenceDot: {
    position: 'absolute',
    right: -2,
    bottom: -2,
    width: 9,
    height: 9,
    borderRadius: 4.5,
    borderWidth: 1.5,
    borderColor: Theme.bg,
  },
  emptyText: { textAlign: 'center', padding: 24, fontSize: 12, color: Theme.textMuted0 },
  hint: {
    textAlign: 'center',
    fontSize: 10.5,
    color: Theme.textMuted0,
    paddingVertical: 8,
  },
}));
