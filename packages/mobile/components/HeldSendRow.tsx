// Under a message the daemon is holding on purpose, the reason it gave. When
// the session runs in a terminal Codecast can't type into
// (shared/contracts/deliveryHold), the row offers the fix: restart it in tmux.
// That ends the person's own agent process, so it asks first, with the same
// ledger the web's confirm shows.
import { Alert, StyleSheet, TouchableOpacity, View as RNView } from 'react-native';
import * as Haptics from 'expo-haptics';
import { unreachableTerminalOf } from '@codecast/shared/contracts/deliveryHold';
import { restartInTmuxLedger } from '@codecast/web/components/consequential/ledgers';
import { Text as RNText } from '@/components/Themed';
import { useTheme } from '@/constants/Theme';

export function HeldSendRow({ reason, working, restarting, onRestart }: { reason: string; working: boolean; restarting: boolean; onRestart: () => void }) {
  const Theme = useTheme();
  const terminal = unreachableTerminalOf(reason);
  const confirm = () => {
    if (!terminal) return;
    const l = restartInTmuxLedger({ terminal, working });
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    Alert.alert(l.name, [l.alert, ...l.rows.map((r) => `${r.k}: ${r.v}`)].filter(Boolean).join('\n'), [
      { text: l.keep ?? 'Cancel', style: 'cancel' },
      { text: l.confirm, style: 'destructive', onPress: onRestart },
    ]);
  };
  return (
    <RNView style={styles.row}>
      <RNText style={[styles.text, { color: Theme.textDim }]} numberOfLines={2}>Held: {reason}</RNText>
      {terminal ? (
        <TouchableOpacity onPress={confirm} disabled={restarting} hitSlop={8} accessibilityRole="button">
          <RNText style={[styles.text, { color: Theme.cyan, fontWeight: '600' }]}>{restarting ? 'Restarting…' : 'Restart in tmux'}</RNText>
        </TouchableOpacity>
      ) : null}
    </RNView>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8, alignSelf: 'flex-end', paddingHorizontal: 16, paddingTop: 2, paddingBottom: 4 },
  text: { fontSize: 10, fontStyle: 'italic' },
});
