// Under a message the daemon is holding on purpose, the reason it gave. And
// the press that opens the live terminal, offered above the composer when
// only the pane can clear a hold.
import { Pressable, StyleSheet, View as RNView } from 'react-native';
import Feather from '@expo/vector-icons/Feather';
import { Text as RNText } from '@/components/Themed';
import { useTheme } from '@/constants/Theme';

export function HeldSendRow({ reason }: { reason: string }) {
  const Theme = useTheme();
  return (
    <RNView style={styles.row}>
      <RNText style={[styles.text, { color: Theme.textDim }]} numberOfLines={2}>Held: {reason}</RNText>
    </RNView>
  );
}

export function OpenTerminalButton({ onPress }: { onPress: () => void }) {
  const Theme = useTheme();
  return (
    <Pressable
      onPress={onPress}
      hitSlop={8}
      style={({ pressed }) => [styles.btn, { borderColor: Theme.accent, opacity: pressed ? 0.6 : 1 }]}
      accessibilityRole="button"
      accessibilityLabel="Open the live terminal"
      testID="open-terminal"
    >
      <Feather name="terminal" size={12} color={Theme.accent} />
      <RNText style={[styles.btnText, { color: Theme.accent }]}>Open terminal</RNText>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', flexWrap: 'wrap', gap: 8, alignSelf: 'flex-end', paddingHorizontal: 16, paddingTop: 2, paddingBottom: 4 },
  text: { fontSize: 10, fontStyle: 'italic', flexShrink: 1 },
  btn: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 10, height: 28, borderRadius: 14, borderWidth: 1 },
  btnText: { fontSize: 12, fontWeight: '600' },
});
