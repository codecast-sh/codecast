// A milestone's mark on the phone, shared by the Priorities list
// (app/priorities.tsx) and a priority's screen (app/priority/[id].tsx), and
// what pressing one does. Only two marks are actions, and only they are
// bordered: Needs you (yellow ring and dot) opens the session to answer, New
// session (the composer's pen, filled primary) opens the composer seeded with
// web's brief and linked to the milestone at creation. Every other state is
// the session mark alone, and nobody on it is an empty box.
import { useCallback } from 'react';
import { StyleSheet, TouchableOpacity, View as RNView } from 'react-native';
import { useRouter } from 'expo-router';
import Feather from '@expo/vector-icons/Feather';
import { themedStyles, useTheme } from '@/constants/Theme';
import type { PriorityRow } from '@codecast/shared/contracts/priorities';
import type { MilestoneModel, SessionLine } from '@codecast/web/lib/priorityList';
import { lookup } from '@codecast/web/lib/liveEntities';
import { useInboxStore } from '@codecast/web/store/inboxStore';
import { mobileEntityRoute } from '@/lib/linkRoutes';
import { openCompose } from '@/lib/compose';
import { milestoneMark, startCompose } from '@/lib/prioritiesList';
import { SessionStatusMark } from '@/components/marks';

/** Opening a linked session (its native screen), and New session on a milestone. */
export function usePriorityActs() {
  const router = useRouter();
  // Its target: the session itself, or the lead a role's session rides, where the answer is.
  const openSession = useCallback((s: Pick<SessionLine, 'target'>) => {
    const route = mobileEntityRoute('session', s.target);
    if (route) router.push(route as never);
  }, [router]);
  // Web's New session: the same brief, and the session linked to the milestone at creation.
  const start = useCallback((row: Parameters<typeof startCompose>[0], m: MilestoneModel) => {
    const { seed, start: link, task } = startCompose(row, m, (id) => lookup(useInboxStore.getState().tasks, id));
    openCompose(seed, [], link, task);
  }, []);
  return { openSession, start };
}

/** The bordered yellow Needs you box, drawn alone (the legend) or inside its press. */
export function NeedsYouBox() {
  const Theme = useTheme();
  return (
    <RNView style={[styles.box, styles.needsYou, { borderColor: Theme.yellow + 'b3', backgroundColor: Theme.yellow + '26' }]}>
      <SessionStatusMark status="needs_you" size={14} />
    </RNView>
  );
}

/** The filled primary pen, the composer's icon, drawn alone (the legend) or inside its press. */
export function NewSessionBox() {
  const Theme = useTheme();
  return (
    <RNView style={[styles.box, { backgroundColor: Theme.accent }]}>
      <Feather name="edit" size={14} color={Theme.bg} />
    </RNView>
  );
}

/**
 * A milestone's first column: a 44pt slot holding its mark. The two action
 * marks are their own press; a quiet mark is drawn alone, so a press there
 * falls to the line it sits in.
 */
export function MilestoneMark({ row, m }: { row: Pick<PriorityRow, 'short_id' | 'plan'>; m: MilestoneModel }) {
  const { openSession, start } = usePriorityActs();
  const mark = milestoneMark(m);
  if (mark.kind === 'needs_you') {
    return (
      <TouchableOpacity onPress={() => openSession(mark.session)} style={styles.slot} accessibilityRole="button" accessibilityLabel={mark.label} testID={`priorities-needs-you-${m.key}`}>
        <NeedsYouBox />
      </TouchableOpacity>
    );
  }
  if (mark.kind === 'start') {
    return (
      <TouchableOpacity onPress={() => start(row, m)} style={styles.slot} accessibilityRole="button" accessibilityLabel={mark.label} testID={`priorities-new-session-${m.key}`}>
        <NewSessionBox />
      </TouchableOpacity>
    );
  }
  if (mark.kind === 'none') return <RNView style={styles.slot} testID={`priorities-mark-none-${m.key}`} />;
  return (
    <RNView style={styles.slot} accessible accessibilityLabel={mark.label} testID={`priorities-mark-${m.state.kind}-${m.key}`}>
      <SessionStatusMark status={mark.status} size={13} />
    </RNView>
  );
}

const styles = themedStyles(() => StyleSheet.create({
  slot: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  box: { width: 28, height: 28, borderRadius: 7, alignItems: 'center', justifyContent: 'center' },
  needsYou: { borderWidth: 1 },
}));
