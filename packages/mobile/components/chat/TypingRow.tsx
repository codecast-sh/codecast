import { StyleSheet, View as RNView } from 'react-native';
import { Text as RNText } from '@/components/Themed';
import { useTypingMembers } from '@codecast/web/hooks/useChatTyping';
import { Spacing, themedStyles, useTheme } from '@/constants/Theme';

// "Samvit is typing…" above the composer: web's own watcher (one subscription
// per channel, scoped to the floor or one thread, aged out on the client
// clock). Typing is a seconds-long signal and deliberately not in the store.

export function TypingRow({
  channelId,
  threadRootId,
  nameOf,
}: {
  channelId: string | undefined;
  /** Present on the thread screen: only that thread's typists show. */
  threadRootId?: string;
  viewerId?: string;
  nameOf: (userId: string) => string;
}) {
  useTheme();
  const typists = useTypingMembers(channelId, threadRootId);
  const names = typists.map((m) => nameOf(String(m._id))).filter(Boolean);
  if (names.length === 0) return null;
  const label =
    names.length === 1 ? `${names[0]} is typing…`
    : names.length === 2 ? `${names[0]} and ${names[1]} are typing…`
    : 'Several people are typing…';
  return (
    <RNView style={styles.row}>
      <RNText style={styles.text}>{label}</RNText>
    </RNView>
  );
}

const styles = themedStyles((Theme) => StyleSheet.create({
  row: { paddingHorizontal: Spacing.md, paddingBottom: 2 },
  text: { fontSize: 10.5, fontStyle: 'italic', color: Theme.textMuted0 },
}));
