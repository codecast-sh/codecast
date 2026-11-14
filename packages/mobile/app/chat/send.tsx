import { useMemo, useState } from 'react';
import { StyleSheet, FlatList, TouchableOpacity, View as RNView, KeyboardAvoidingView, Platform } from 'react-native';
import { Text as RNText, TextInput as ThemedTextInput } from '@/components/Themed';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, Stack, useLocalSearchParams } from 'expo-router';
import * as Haptics from 'expo-haptics';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import { Spacing, themedStyles, useTheme } from '@/constants/Theme';
import { ChatAvatar } from '@/components/chat/MessageRow';
import { showNotice } from '@/lib/undoBar';
import { useInboxStore } from '@codecast/web/store/inboxStore';
import { useChatRail } from '@codecast/web/hooks/useChatSync';
import { channelDisplayName } from '@codecast/web/lib/chatViews';
import { teamMembersOf } from '@codecast/web/lib/activeTeam';
import { isPerson } from '@codecast/shared/team/memberKind';

// Send a link to a channel or a person: the phone's half of web's "Send to
// chat" (lib/forwardToChat.ts). Pick a room, add a note if you like, Send.
// The note and the link go as one message with the link alone on its last
// line, which is what chat draws as a preview card. Both store calls are
// local-first (openDmChannel and sendChatMessage answer in this tick), so the
// screen closes at once.
//
// Params: url (what to send), label (what it is: "session"), title (its name,
// for the preview at the bottom).

type Target =
  | { kind: 'channel'; key: string; id: string; name: string; dm: boolean; avatar?: { id: string; name: string; avatarUrl?: string } }
  | { kind: 'person'; key: string; id: string; name: string; avatarUrl?: string };

export default function SendToChatScreen() {
  const Theme = useTheme();
  const router = useRouter();
  const { url, label, title } = useLocalSearchParams<{ url: string; label?: string; title?: string }>();
  const rail = useChatRail();
  const viewerId = useInboxStore((s) => (s.currentUser?._id ? String(s.currentUser._id) : ''));
  const members = useInboxStore(teamMembersOf) as any[];

  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<Target | null>(null);
  const [note, setNote] = useState('');

  const targets = useMemo<Target[]>(() => {
    const byId = new Map((members ?? []).map((m: any) => [String(m._id), m]));
    const out: Target[] = [];
    // Rooms in the rail's own order (most recent first), then the teammates
    // who have no 1:1 room yet, so nobody shows twice.
    const withDm = new Set<string>();
    for (const c of rail) {
      if (c.kind === 'dm' && c.dmMemberIds?.length === 1) withDm.add(String(c.dmMemberIds[0]));
      const other = c.kind === 'dm' && c.dmMemberIds?.length === 1 ? byId.get(String(c.dmMemberIds[0])) : undefined;
      out.push({
        kind: 'channel',
        key: `c-${c.id}`,
        id: c.id,
        name: channelDisplayName(c, members),
        dm: c.kind === 'dm',
        avatar: other ? { id: String(other._id), name: other.name || 'Teammate', avatarUrl: other.github_avatar_url || other.image } : undefined,
      });
    }
    for (const m of members ?? []) {
      const id = String(m._id);
      if (!isPerson(m) || id === viewerId || withDm.has(id)) continue;
      out.push({ kind: 'person', key: `p-${id}`, id, name: m.name || m.github_username || 'Teammate', avatarUrl: m.github_avatar_url || m.image });
    }
    const needle = q.trim().toLowerCase();
    return needle ? out.filter((t) => t.name.toLowerCase().includes(needle)) : out;
  }, [rail, members, viewerId, q]);

  const send = () => {
    if (!picked || !url) return;
    const store = useInboxStore.getState();
    const channelId = picked.kind === 'person' ? store.openDmChannel([picked.id]) : picked.id;
    store.sendChatMessage(channelId, [note.trim(), url].filter(Boolean).join('\n\n'));
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    showNotice(`Sent to ${picked.kind === 'channel' && !picked.dm ? '#' : ''}${picked.name}`);
    router.back();
  };

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      <Stack.Screen options={{ headerShown: false }} />
      <RNView style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={10} style={styles.back}>
          <FontAwesome name="chevron-left" size={16} color={Theme.textMuted} />
        </TouchableOpacity>
        <RNText style={styles.title}>Send {label || 'link'} to…</RNText>
      </RNView>

      <RNView style={styles.search}>
        <FontAwesome name="search" size={12} color={Theme.textMuted0} />
        <ThemedTextInput
          style={styles.searchInput}
          placeholder="Search channels and people"
          value={q}
          onChangeText={setQ}
          autoCorrect={false}
        />
      </RNView>

      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <FlatList
          style={styles.flex}
          data={targets}
          keyExtractor={(t) => t.key}
          keyboardShouldPersistTaps="handled"
          renderItem={({ item: t }) => {
            const on = picked?.key === t.key;
            return (
              <TouchableOpacity
                style={[styles.row, on && styles.rowOn]}
                activeOpacity={0.7}
                onPress={() => { void Haptics.selectionAsync(); setPicked(on ? null : t); }}
              >
                {t.kind === 'person' ? (
                  <ChatAvatar author={{ id: t.id, name: t.name, avatarUrl: t.avatarUrl }} size={28} />
                ) : t.avatar ? (
                  <ChatAvatar author={t.avatar} size={28} />
                ) : (
                  <RNView style={styles.glyph}>
                    <FontAwesome name={t.dm ? 'comments-o' : 'hashtag'} size={13} color={Theme.textMuted} />
                  </RNView>
                )}
                <RNText style={styles.name} numberOfLines={1}>{t.name}</RNText>
                {on && <FontAwesome name="check-circle" size={16} color={Theme.blue} />}
              </TouchableOpacity>
            );
          }}
          ListEmptyComponent={<RNText style={styles.emptyText}>{q ? 'Nobody matches' : 'No channels or teammates yet'}</RNText>}
        />

        <RNView style={styles.footer}>
          <RNView style={styles.preview}>
            <FontAwesome name="link" size={11} color={Theme.textMuted0} />
            <RNText style={styles.previewText} numberOfLines={1}>{title || url}</RNText>
          </RNView>
          <RNView style={styles.composeRow}>
            <ThemedTextInput
              style={styles.note}
              placeholder="Add a message (optional)"
              value={note}
              onChangeText={setNote}
              multiline
            />
            <TouchableOpacity
              style={[styles.sendBtn, !picked && styles.sendOff]}
              disabled={!picked}
              onPress={send}
              accessibilityLabel={picked ? `Send to ${picked.name}` : 'Pick where to send it'}
            >
              <RNText style={styles.sendText}>Send</RNText>
            </TouchableOpacity>
          </RNView>
        </RNView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = themedStyles((Theme) => StyleSheet.create({
  container: { flex: 1, backgroundColor: Theme.bg },
  flex: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: Spacing.md, paddingVertical: 10 },
  back: { paddingRight: 6 },
  title: { flex: 1, fontSize: 15, fontWeight: '600', color: Theme.text },
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
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: Spacing.md, paddingVertical: 9 },
  rowOn: { backgroundColor: Theme.blue + '14' },
  glyph: {
    width: 28,
    height: 28,
    borderRadius: 7,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Theme.bgAlt,
  },
  name: { flex: 1, fontSize: 14, color: Theme.text },
  emptyText: { textAlign: 'center', padding: 24, fontSize: 12, color: Theme.textMuted0 },
  footer: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Theme.border,
    paddingHorizontal: Spacing.md,
    paddingTop: 8,
    paddingBottom: 8,
    gap: 8,
  },
  preview: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  previewText: { flex: 1, fontSize: 11.5, color: Theme.textMuted },
  composeRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 8 },
  note: {
    flex: 1,
    maxHeight: 110,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 13.5,
    color: Theme.text,
    borderWidth: 1,
    borderColor: Theme.border + '66',
    borderRadius: 9,
    backgroundColor: Theme.bgAlt + '55',
  },
  sendBtn: { height: 36, paddingHorizontal: 16, borderRadius: 18, backgroundColor: Theme.blue, alignItems: 'center', justifyContent: 'center' },
  sendOff: { opacity: 0.4 },
  sendText: { fontSize: 13, fontWeight: '700', color: Theme.bg },
}));
