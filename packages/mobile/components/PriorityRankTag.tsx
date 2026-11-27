// The inbox's Priorities view on a session row: the priority target and the
// rank of the viewer's priority the session serves, then that workspace's
// mark when it is not the active one (web's PriorityRankChip).
import { StyleSheet, View } from 'react-native';
import Feather from '@expo/vector-icons/Feather';
import { Text } from '@/components/Themed';
import { themedStyles, useTheme } from '@/constants/Theme';
import { useInboxStore } from '@codecast/web/store/inboxStore';
import { rankTitle, workspaceMarkOf, type PriorityRankLabel } from '@codecast/web/store/priorityOrder';
import { TEAM_ICON_EMOJI } from '@/lib/teamIconEmoji';

export function PriorityRankTag({ rank }: { rank: NonNullable<PriorityRankLabel> }) {
  const Theme = useTheme();
  const teams = useInboxStore((s) => (rank.workspace ? s.teams : null));
  const viewerId = useInboxStore((s) => (s.currentUser?._id ? String(s.currentUser._id) : null));
  const mark = rank.workspace ? workspaceMarkOf(rank.workspace, teams, viewerId) : null;
  return (
    <View style={styles.rank} accessible accessibilityLabel={rankTitle(rank, mark)}>
      <Feather name="target" size={10} color={Theme.cyan} />
      <Text style={styles.text}>{rank.rank}</Text>
      {mark && (mark.personal
        ? <Feather name="user" size={10} color={Theme.textMuted0} />
        : mark.icon && TEAM_ICON_EMOJI[mark.icon]
          ? <Text style={styles.emoji}>{TEAM_ICON_EMOJI[mark.icon]}</Text>
          : <Feather name="users" size={10} color={Theme.textMuted0} />)}
    </View>
  );
}

const styles = themedStyles((Theme) => StyleSheet.create({
  rank: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Theme.border,
    borderRadius: 4,
    paddingHorizontal: 4,
    overflow: 'hidden',
  },
  text: {
    fontSize: 11,
    fontWeight: '600',
    color: Theme.cyan,
  },
  emoji: {
    fontSize: 9,
  },
}));
