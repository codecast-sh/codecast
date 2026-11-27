// What the priorities' icons mean, behind a quiet ⓘ in the Priorities
// header (web's components/priorities/Legend): the milestone and session
// states (the two bordered ones are the actions), the task states, and the
// other kinds an open milestone lists, each drawn with the phone's own mark.
import { useState, type ReactNode } from 'react';
import { ScrollView, StyleSheet, TouchableOpacity, View as RNView } from 'react-native';
import Feather from '@expo/vector-icons/Feather';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import { Text as RNText } from '@/components/Themed';
import { CHROME_FONT_CAP, themedStyles, useTheme } from '@/constants/Theme';
import { MILESTONE_STATE_WORD } from '@codecast/web/lib/priorityList';
import { SESSION_STATUS } from '@codecast/web/lib/sessionStatus';
import { BottomSheet } from '@/components/BottomSheet';
import { STATUS_CONFIG } from '@/components/TaskItem';
import { SessionStatusMark } from '@/components/SessionStatusMark';
import { NeedsYouBox, NewSessionBox } from '@/components/priorities/MilestoneMark';
import { KIND_ICON, PR_LOOK } from '@/components/priorities/PriorityParts';

const TASK_STATES = ['backlog', 'open', 'in_progress', 'in_review', 'done', 'dropped'] as const;

function Row({ icon, word }: { icon: ReactNode; word: string }) {
  return (
    <RNView style={styles.row} testID={`priorities-legend-${word}`}>
      <RNView style={styles.icon}>{icon}</RNView>
      <RNText style={styles.word}>{word}</RNText>
    </RNView>
  );
}

const Head = ({ children }: { children: string }) => <RNText maxFontSizeMultiplier={CHROME_FONT_CAP} style={styles.head}>{children.toUpperCase()}</RNText>;

/** The ⓘ, a 44pt press, and the sheet it opens. */
export function Legend() {
  const Theme = useTheme();
  const [open, setOpen] = useState(false);
  const icon = (name: (typeof KIND_ICON)[keyof typeof KIND_ICON] | (typeof PR_LOOK)[keyof typeof PR_LOOK]['icon'], color: string) => <Feather name={name} size={14} color={color} />;
  return (
    <>
      <TouchableOpacity onPress={() => setOpen(true)} style={styles.trigger} accessibilityRole="button" accessibilityLabel="What the icons mean" testID="priorities-legend">
        <Feather name="info" size={17} color={Theme.textDim} />
      </TouchableOpacity>
      <BottomSheet visible={open} onClose={() => setOpen(false)}>
        <RNText style={styles.title}>What the icons mean</RNText>
        <ScrollView style={styles.scroll} contentContainerStyle={styles.body}>
          <RNView style={styles.columns}>
            <RNView style={styles.column}>
              <Head>Milestones and sessions</Head>
              <Row icon={<NeedsYouBox />} word={MILESTONE_STATE_WORD.needs_you} />
              <Row icon={<NewSessionBox />} word={MILESTONE_STATE_WORD.start} />
              <Row icon={<SessionStatusMark status="working" size={13} />} word={MILESTONE_STATE_WORD.working} />
              <Row icon={<SessionStatusMark status="dormant" size={13} />} word={MILESTONE_STATE_WORD.dormant} />
              <Row icon={<SessionStatusMark status="idle" size={13} />} word={MILESTONE_STATE_WORD.idle} />
              <Row icon={<SessionStatusMark status="done" size={13} />} word={MILESTONE_STATE_WORD.done} />
              <Row icon={<SessionStatusMark status="killed" size={13} />} word="Closed" />
              {/* A session row draws its inbox's mark, these three included. */}
              <Row icon={<SessionStatusMark status="starting" size={13} />} word={SESSION_STATUS.starting.word} />
              <Row icon={<SessionStatusMark status="error" size={13} />} word={SESSION_STATUS.error.word} />
              <Row icon={<SessionStatusMark status="stashed" size={13} />} word={SESSION_STATUS.stashed.word} />
              <Row icon={icon(KIND_ICON.workflow, Theme.textDim)} word="Workflow run" />
            </RNView>
            <RNView style={styles.column}>
              <Head>Tasks</Head>
              {TASK_STATES.map((k) => {
                const { icon: name, color, label } = STATUS_CONFIG[k];
                return <Row key={k} icon={<FontAwesome name={name} size={14} color={color} />} word={label} />;
              })}
            </RNView>
          </RNView>
          <Head>Other</Head>
          <RNView style={styles.columns}>
            <RNView style={styles.column}>
              <Row icon={icon(PR_LOOK.open.icon, Theme[PR_LOOK.open.color])} word="Pull request, open" />
              <Row icon={icon(PR_LOOK.merged.icon, Theme[PR_LOOK.merged.color])} word="Pull request, merged" />
              <Row icon={icon(PR_LOOK.closed.icon, Theme[PR_LOOK.closed.color])} word="Pull request, closed" />
            </RNView>
            <RNView style={styles.column}>
              <Row icon={icon(KIND_ICON.branch, Theme.textDim)} word="Branch" />
              <Row icon={icon(KIND_ICON.plan, Theme.textDim)} word="Plan" />
              <Row icon={icon(KIND_ICON.deploy, Theme.green)} word="Deploy" />
            </RNView>
          </RNView>
        </ScrollView>
      </BottomSheet>
    </>
  );
}

const styles = themedStyles((Theme) => StyleSheet.create({
  trigger: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: 16, fontWeight: '600', color: Theme.text, paddingHorizontal: 20, paddingTop: 4, paddingBottom: 8 },
  scroll: { maxHeight: 620 },
  body: { paddingHorizontal: 20, paddingBottom: 8 },
  columns: { flexDirection: 'row', gap: 16 },
  column: { flex: 1, minWidth: 0 },
  head: { marginTop: 12, marginBottom: 4, fontSize: 11, fontWeight: '600', color: Theme.textDim, letterSpacing: 0.5 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 32 },
  icon: { width: 28, alignItems: 'center' },
  word: { flexShrink: 1, fontSize: 13.5, color: Theme.text },
}));
