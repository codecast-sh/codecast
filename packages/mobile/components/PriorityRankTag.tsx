// On a session row filed under one of the viewer's priorities: the target,
// its rank and title (cut to fit), then that workspace's mark when it is not
// the active one (web's PriorityRankChip). A tap opens the priority's screen;
// the nested Pressable wins the touch over the row's own.
import { Pressable, StyleSheet } from 'react-native';
import { router } from 'expo-router';
import Feather from '@expo/vector-icons/Feather';
import { Text } from '@/components/Themed';
import { themedStyles, useTheme } from '@/constants/Theme';
import { useInboxStore } from '@codecast/web/store/inboxStore';
import { rankTitle, workspaceMarkOf, type PriorityRankLabel } from '@codecast/web/store/priorityOrder';
import { TEAM_ICON_EMOJI } from '@/lib/teamIconEmoji';

/** `neutral`: grey, on a row that asks nothing of the eye (Shipping,
 *  Sleeping); `workspaceMark` false leaves the workspace's mark off, as on a
 *  Shipping row, where a rocket mark would read as the section's own. */
export function PriorityRankTag({ rank, neutral = false, workspaceMark = true }: { rank: NonNullable<PriorityRankLabel>; neutral?: boolean; workspaceMark?: boolean }) {
  const Theme = useTheme();
  const teams = useInboxStore((s) => (rank.workspace ? s.teams : null));
  const viewerId = useInboxStore((s) => (s.currentUser?._id ? String(s.currentUser._id) : null));
  const mark = rank.workspace ? workspaceMarkOf(rank.workspace, teams, viewerId) : null;
  return (
    <Pressable
      style={styles.rank}
      hitSlop={8}
      onPress={() => router.push(`/priority/${rank.shortId}` as never)}
      accessibilityRole="link"
      accessibilityLabel={rankTitle(rank, mark)}
    >
      <Feather name="target" size={10} color={neutral ? Theme.textMuted : Theme.cyan} />
      <Text style={[styles.text, neutral && { color: Theme.textMuted }]} numberOfLines={1}>
        #{rank.rank}{rank.title ? <Text style={styles.title}> {rank.title}</Text> : null}
      </Text>
      {mark && workspaceMark && (mark.personal
        ? <Feather name="user" size={10} color={Theme.textMuted0} />
        : mark.icon && TEAM_ICON_EMOJI[mark.icon]
          ? <Text style={styles.emoji}>{TEAM_ICON_EMOJI[mark.icon]}</Text>
          : <Feather name="users" size={10} color={Theme.textMuted0} />)}
    </Pressable>
  );
}

const styles = themedStyles((Theme) => StyleSheet.create({
  rank: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    maxWidth: 140,
    flexShrink: 1,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Theme.border,
    borderRadius: 4,
    paddingHorizontal: 4,
    overflow: 'hidden',
  },
  text: {
    flexShrink: 1,
    fontSize: 11,
    fontWeight: '600',
    color: Theme.cyan,
  },
  title: {
    fontWeight: '500',
  },
  emoji: {
    fontSize: 9,
  },
}));
