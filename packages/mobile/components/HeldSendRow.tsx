// Under a message the daemon is holding on purpose, the reason it gave.
import { StyleSheet, View as RNView } from 'react-native';
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

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8, alignSelf: 'flex-end', paddingHorizontal: 16, paddingTop: 2, paddingBottom: 4 },
  text: { fontSize: 10, fontStyle: 'italic' },
});
