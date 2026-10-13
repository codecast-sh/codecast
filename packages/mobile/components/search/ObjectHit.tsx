// One object a search found (a to-do, plan, note, routine, project, goal,
// role, person or published page): the mark and the state its own list draws
// (TaskItem, PlanItem, DocItem), so a task reads the same in a search and on
// its board. One line, a full-width touch target.
import { memo } from 'react';
import { Pressable, StyleSheet, View as RNView } from 'react-native';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import type { ObjectHit as Hit } from '@codecast/web/hooks/useObjectSearch';
import { memberAvatarUrl } from '@codecast/web/lib/liveEntities';
import { describeTaskCadence } from '@codecast/web/components/triggerCadence';
import { parseQueryTerms, snippetAround, termSpans } from '@codecast/shared/search';
import { useSurface } from '@codecast/web/lib/surfaces';
import { Text as RNText } from '@/components/Themed';
import { STATUS_CONFIG, PRIORITY_CONFIG } from '@/components/TaskItem';
import { PLAN_STATUS_CONFIG } from '@/components/PlanItem';
import { DOC_TYPE_CONFIG } from '@/components/DocItem';
import { ChatAvatar } from '@/components/chat/MessageRow';
import { formatRelativeTime } from '@/components/SessionItem';
import { CHROME_FONT_CAP, themedStyles, useTheme } from '@/constants/Theme';
import { HighlightText } from './highlight';

type IconName = React.ComponentProps<typeof FontAwesome>['name'];
type Look = { icon: IconName; color: string; state?: string; stateColor?: string };

/** A long title shows the stretch around its hit, so the words found are
 *  never past the row's ellipsis. A phone row holds under thirty characters
 *  of the app's monospace face beside its state and age. */
const TITLE_WINDOW = 28;

function lookOf(hit: Hit, Theme: ReturnType<typeof useTheme>): Look {
  const e = hit.entity ?? {};
  switch (hit.kind) {
    case 'task': {
      const s = STATUS_CONFIG[e.status as keyof typeof STATUS_CONFIG] ?? STATUS_CONFIG.open;
      const p = e.priority === 'urgent' || e.priority === 'high' ? PRIORITY_CONFIG[e.priority as 'urgent' | 'high'] : null;
      return { icon: s.icon, color: s.color, state: p ? p.label : s.label, stateColor: p ? p.color : s.color };
    }
    case 'plan': {
      const s = PLAN_STATUS_CONFIG[e.status as keyof typeof PLAN_STATUS_CONFIG] ?? PLAN_STATUS_CONFIG.draft;
      return { icon: s.icon, color: s.color, state: s.label, stateColor: s.color };
    }
    case 'doc': {
      const d = DOC_TYPE_CONFIG[e.doc_type] ?? { icon: 'file-text-o' as IconName, color: Theme.green, label: 'Note' };
      return { icon: d.icon, color: d.color, state: d.label, stateColor: Theme.textMuted0 };
    }
    case 'trigger':
      return { icon: 'bolt', color: e.status === 'paused' ? Theme.accent : Theme.orange, state: describeTaskCadence(e), stateColor: Theme.textMuted0 };
    case 'project': return { icon: 'folder-o', color: Theme.blue };
    case 'initiative': return { icon: 'flag-o', color: Theme.magenta };
    case 'role': return { icon: 'cube', color: Theme.violet, state: e.handle ? `@${e.handle}` : undefined, stateColor: Theme.textMuted0 };
    case 'page': return { icon: 'globe', color: Theme.cyan };
    default: return { icon: 'circle-o', color: Theme.textMuted0 };
  }
}

export const ObjectHit = memo(function ObjectHit({ hit, highlight, onPress }: { hit: Hit; highlight: string; onPress: (hit: Hit) => void }) {
  const Theme = useTheme();
  const internals = useSurface('search.internals');
  const look = lookOf(hit, Theme);
  const done = hit.kind === 'task' && (hit.entity?.status === 'done' || hit.entity?.status === 'dropped');
  const terms = parseQueryTerms(highlight);
  const title = hit.title.length > TITLE_WINDOW ? snippetAround(hit.title, terms, TITLE_WINDOW) : hit.title;
  // Found by what it is for, not what it is called (a plan's goal, a
  // routine's instruction): the stretch that matched shows under the title.
  const body: string | undefined = termSpans(hit.title, terms).length === 0 ? hit.entity?.goal || hit.entity?.prompt : undefined;
  const why = body && termSpans(body, terms).length > 0 ? snippetAround(body.replace(/\s+/g, ' '), terms, 90) : undefined;
  // Hosted mode says a to-do's state only once it is done; an open one is the default.
  const state = !internals && hit.kind === 'task' ? (done ? 'Done' : undefined) : look.state;
  return (
    <Pressable onPress={() => onPress(hit)} style={({ pressed }) => [styles.row, pressed && styles.pressed]} accessibilityRole="button" accessibilityLabel={hit.title}>
      <RNView style={styles.mark}>
        {hit.kind === 'person'
          ? <ChatAvatar author={{ id: hit.key, name: hit.title, avatarUrl: memberAvatarUrl(hit.entity) }} size={20} />
          : <FontAwesome name={look.icon} size={15} color={look.color} />}
      </RNView>
      <RNView style={styles.words}>
        <HighlightText text={title} query={highlight} style={[styles.title, done && styles.titleDone]} numberOfLines={1} />
        {!!why && <HighlightText text={why} query={highlight} style={styles.why} numberOfLines={2} />}
      </RNView>
      {!!state && <RNText style={[styles.state, { color: look.stateColor }]} numberOfLines={1} maxFontSizeMultiplier={CHROME_FONT_CAP}>{state}</RNText>}
      {hit.at ? <RNText style={styles.time} maxFontSizeMultiplier={CHROME_FONT_CAP}>{formatRelativeTime(hit.at)}</RNText> : null}
    </Pressable>
  );
});

const styles = themedStyles((Theme) => StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 44, paddingHorizontal: 16, paddingVertical: 8 },
  pressed: { backgroundColor: Theme.bgHighlight + '80' },
  mark: { width: 20, alignItems: 'center', alignSelf: 'flex-start', marginTop: 4 },
  words: { flex: 1, minWidth: 0 },
  title: { fontSize: 15, color: Theme.text },
  why: { fontSize: 12, lineHeight: 17, color: Theme.textMuted0, marginTop: 2 },
  titleDone: { color: Theme.textMuted0 },
  state: { fontSize: 11, fontWeight: '600', maxWidth: 96, alignSelf: 'flex-start', marginTop: 5 },
  time: { fontSize: 11, color: Theme.textMuted0, minWidth: 28, textAlign: 'right', alignSelf: 'flex-start', marginTop: 5 },
}));
