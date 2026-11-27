// What a priority's pill (`pri-N`) draws before its title, as on the web's
// PriorityPill: the owner's face, then the rank in a small solid orange
// square. A priority with no rank (not active) wears the target instead.
// Drawn inside the pill's Text, so it sits inline in prose: one row, so the
// face and the badge centre on each other, sized to the pill's line at the
// phone's text size.
import { useContext } from 'react';
import { StyleSheet, View } from 'react-native';
import Feather from '@expo/vector-icons/Feather';
import { Text } from '@/components/Themed';
import { useTheme } from '@/constants/Theme';
import { PersonFace } from '@/components/owners/OwnerFace';
import { TextSizeContext } from '@/lib/textSizeContext';
import { sizedText } from '@/lib/textSize';
import type { PriorityRow } from '@codecast/shared/contracts/priorities';

export function PriorityPillMarks({ row }: { row: Pick<PriorityRow, 'owner' | 'owner_image' | 'rank'> }) {
  const Theme = useTheme();
  // The pill's text is 11 on a 12 line at Small; the marks match that line.
  const textSize = useContext(TextSizeContext);
  const { fontSize, lineHeight } = sizedText(11, 12, textSize);
  const side = lineHeight!;
  // An inline view sits on the text's baseline; lower it so its middle meets
  // the middle of the title's capitals (JetBrains Mono caps are 0.73 em).
  const drop = (side - 0.73 * fontSize) / 2;
  // The bold digits draw 0.16 em below the middle of their own line (measured on iOS); lift them back.
  const lift = -0.16 * sizedText(9, undefined, textSize).fontSize;
  return (
    <View style={[styles.lead, { transform: [{ translateY: drop }] }]}>
      {(row.owner || row.owner_image) && <PersonFace name={row.owner} image={row.owner_image} size={side} />}
      {row.rank != null ? (
        <View style={[styles.badge, { height: side, minWidth: side, backgroundColor: Theme.orange }]} testID="priority-rank-badge">
          <Text allowFontScaling={false} style={[styles.digits, { color: Theme.activeBadgeText, transform: [{ translateY: lift }] }]}>{row.rank}</Text>
        </View>
      ) : (
        <Feather name="target" size={side - 2} color={Theme.orange} testID="priority-target" />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  lead: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  badge: { paddingHorizontal: 2, borderRadius: 3, alignItems: 'center', justifyContent: 'center' },
  digits: { fontSize: 9, fontWeight: '700', fontVariant: ['tabular-nums'] },
});
