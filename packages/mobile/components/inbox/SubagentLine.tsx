// The folded subagents line at the foot of an inbox row, the phone twin of
// web's CardSubagentsLine: a mark and a count per state, most urgent first, no
// words. A count opens the newest subagent in that state.
import { StyleSheet, Pressable, View as RNView } from 'react-native';
import Feather from '@expo/vector-icons/Feather';
import type { SubagentStateGroup } from '@codecast/web/lib/subagentRows';
import { Text as RNText } from '@/components/Themed';
import { StatusMark } from '@/components/StatusMark';
import { useTheme } from '@/constants/Theme';
import { subagentGroupWords } from '@/lib/subagentLine';

export function SubagentLine({ groups, onOpen }: { groups: readonly SubagentStateGroup[]; onOpen: (conversationId: string) => void }) {
  const Theme = useTheme();
  return (
    <RNView style={styles.line}>
      <Feather name="corner-down-right" size={11} color={Theme.violet} style={styles.arrow} accessibilityLabel="Subagents" />
      {groups.map((g) => (
        // Each count is a 44pt target: the width here, the height by hitSlop,
        // so the line itself stays one short row.
        <Pressable
          key={g.status}
          onPress={() => onOpen(String(g.newest._id))}
          hitSlop={{ top: 12, bottom: 12 }}
          style={({ pressed }) => [styles.count, pressed && { opacity: 0.5 }]}
          accessibilityRole="button"
          accessibilityLabel={subagentGroupWords(g)}
          accessibilityHint="Opens the newest"
        >
          <StatusMark status={g.status} theme={Theme} size={9} />
          <RNText maxFontSizeMultiplier={1.2} style={[styles.countText, { color: Theme.textMuted0 }]}>{g.count}</RNText>
        </Pressable>
      ))}
    </RNView>
  );
}

const styles = StyleSheet.create({
  line: { flexDirection: 'row', alignItems: 'center', marginTop: 4, height: 20 },
  arrow: { marginRight: 6, opacity: 0.7 },
  count: { flexDirection: 'row', alignItems: 'center', gap: 4, minWidth: 44, height: 20 },
  countText: { fontSize: 11, fontVariant: ['tabular-nums'] },
});
