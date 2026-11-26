// The inbox's Priorities view on a session row: the rank of the viewer's
// priority the session serves, "—" for one in another workspace, or None
// (web's PriorityRankChip).
import { StyleSheet } from 'react-native';
import { Text } from '@/components/Themed';
import { themedStyles } from '@/constants/Theme';
import { rankLabelWords, type PriorityRankLabel } from '@codecast/web/store/priorityOrder';

export function PriorityRankTag({ rank }: { rank: PriorityRankLabel }) {
  const words = rankLabelWords(rank);
  return (
    <Text style={[styles.rank, typeof rank !== 'number' && styles.none]} accessibilityLabel={words.title}>
      {words.touch}
    </Text>
  );
}

const styles = themedStyles((Theme) => StyleSheet.create({
  rank: {
    fontSize: 11,
    fontWeight: '600',
    color: Theme.cyan,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Theme.border,
    borderRadius: 4,
    paddingHorizontal: 4,
    overflow: 'hidden',
  },
  none: {
    color: Theme.textMuted0,
  },
}));
