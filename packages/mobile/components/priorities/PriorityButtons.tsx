// The buttons a priority's next action wears on the phone, shared by the
// Priorities list (app/priorities.tsx) and a priority's screen
// (app/priority/[id].tsx), and what pressing one does: Answer, Open and
// Resume open the session, Start opens the composer seeded with web's brief
// and linked to the milestone at creation.
import { useCallback } from 'react';
import { StyleSheet, TouchableOpacity } from 'react-native';
import { useRouter } from 'expo-router';
import Feather from '@expo/vector-icons/Feather';
import { Text as RNText } from '@/components/Themed';
import { CHROME_FONT_CAP, themedStyles, useTheme } from '@/constants/Theme';
import type { NextAction } from '@codecast/shared/contracts/priorityDerive';
import type { PriorityRow } from '@codecast/shared/contracts/priorities';
import type { MilestoneModel, SessionLine } from '@codecast/web/lib/priorityList';
import { lookup } from '@codecast/web/lib/liveEntities';
import { useInboxStore } from '@codecast/web/store/inboxStore';
import { mobileEntityRoute } from '@/lib/linkRoutes';
import { openCompose } from '@/lib/compose';
import { startCompose, VERB } from '@/lib/priorityScreen';

/** Opening a linked session, and pressing a priority's action. */
export function usePriorityActs() {
  const router = useRouter();
  const openSession = useCallback((s: Pick<SessionLine, 'conversation_id'>) => {
    const route = mobileEntityRoute('session', s.conversation_id);
    if (route) router.push(route as never);
  }, [router]);
  // Web's Start: the same brief, and the session linked to the milestone at creation.
  const start = useCallback((row: Parameters<typeof startCompose>[0], m: MilestoneModel) => {
    const { seed, start: link, task } = startCompose(row, m, (id) => lookup(useInboxStore.getState().tasks, id));
    openCompose(seed, [], link, task);
  }, []);
  const act = useCallback((row: PriorityRow, action: NextAction<MilestoneModel>) => {
    if (action.kind === 'start' || !action.session) start(row, action.milestone);
    else openSession(action.session);
  }, [start, openSession]);
  return { openSession, start, act };
}

/** The priority's one action. Answer wears its own look (a dark fill and a reply glyph) so it reads in grayscale. */
export function PrimaryAction({ action, onPress, testID }: { action: NextAction<MilestoneModel>; onPress: () => void; testID?: string }) {
  const Theme = useTheme();
  const answer = action.kind === 'answer';
  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.75}
      accessibilityRole="button"
      testID={testID ?? `priority-action-${action.kind}`}
      style={[styles.primary, { backgroundColor: answer ? Theme.text : Theme.accent }]}
    >
      {answer && <Feather name="corner-up-left" size={14} color={Theme.bg} />}
      <RNText maxFontSizeMultiplier={CHROME_FONT_CAP} style={[styles.primaryText, { color: Theme.bg }]}>{VERB[action.kind]}</RNText>
    </TouchableOpacity>
  );
}

/** A session that asks, but is not the priority's action: an outlined Answer. */
export function AnswerOutline({ onPress, testID }: { onPress: () => void; testID?: string }) {
  const Theme = useTheme();
  return (
    <TouchableOpacity onPress={onPress} activeOpacity={0.7} accessibilityRole="button" testID={testID} style={[styles.outline, { borderColor: Theme.text }]}>
      <Feather name="corner-up-left" size={13} color={Theme.text} />
      <RNText maxFontSizeMultiplier={CHROME_FONT_CAP} style={[styles.outlineText, { color: Theme.text }]}>Answer</RNText>
    </TouchableOpacity>
  );
}

const styles = themedStyles(() => StyleSheet.create({
  primary: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, minHeight: 44, minWidth: 96, paddingHorizontal: 16, borderRadius: 10 },
  primaryText: { fontSize: 14, fontWeight: '700' },
  outline: { flexDirection: 'row', alignItems: 'center', gap: 5, minHeight: 44, paddingHorizontal: 12, borderRadius: 8, borderWidth: 1 },
  outlineText: { fontSize: 13, fontWeight: '600' },
}));
