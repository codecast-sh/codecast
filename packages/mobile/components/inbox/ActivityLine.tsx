// The line under a Working, Shipping or Sleeping row on the phone, web's
// ActivityUnderLine (components/inbox/ActivityLine): what its own work is,
// where its change is with the five-segment bar, or what wakes it. The words
// come from lib/inboxActivity, so both apps say the same.
//
// Colour is for attention only: the person a row waits on keeps its colour,
// the stalled line wears the warning colour; every other reference is grey.
// The ↳ sits in the row's status-mark column and the words start in its text
// column (the 6pt mark column, then Spacing.sm).
import { StyleSheet, View as RNView } from 'react-native';
import Feather from '@expo/vector-icons/Feather';
import Svg, { Circle, Path } from 'react-native-svg';
import { Text as RNText } from '@/components/Themed';
import { EntityPill } from '@/components/EntityPill';
import { Spacing, useTheme } from '@/constants/Theme';
import type { ShipStage } from '@codecast/shared/contracts/sessionActivity';
import { activityLineParts, type ActivityLineParts, type RowActivity } from '@/lib/inboxActivity';

const SHIP_STAGES: ShipStage[] = ['ci', 'review', 'merge', 'deploy', 'live'];
const SHIP_LABEL = ['Check', 'Review', 'Merge', 'Deploy', 'Live'];

/** The change's five segments in grey, the passed ones solid, the current one filled; ✕ after it only on a failed step. */
function ShipBar({ stage, failed }: { stage: ShipStage; failed: boolean }) {
  const Theme = useTheme();
  const at = SHIP_STAGES.indexOf(stage);
  return (
    <RNText testID="ship-bar" accessibilityLabel={`${SHIP_LABEL.join(', ')}: at ${SHIP_LABEL[at]}${failed ? ', failed' : ''}`} style={styles.bar}>
      {SHIP_STAGES.map((s, i) => (
        <RNText key={s} style={{ color: i <= at ? Theme.textMuted : Theme.textDim, opacity: i === at ? 1 : i < at ? 0.7 : 0.4 }}>▬</RNText>
      ))}
      {failed ? <>{' '}<Feather name="x" size={11} color={Theme.textMuted} /></> : null}
    </RNText>
  );
}

const Alert = ({ color, bg }: { color: string; bg: string }) => (
  <Svg viewBox="0 0 10 10" width={10} height={10}>
    <Path d="M5 1.1 9.3 8.7H.7z" fill={color} />
    <Path d="M5 4v2.2" stroke={bg} strokeWidth={1.1} strokeLinecap="round" />
    <Circle cx="5" cy="7.4" r=".55" fill={bg} />
  </Svg>
);

/** A session's ref is its conversation id and a pull request's
 *  "owner/repo#42"; the pill resolves the object, `label` stands in until it does. */
function WaitPill({ waiting, repository }: { waiting: NonNullable<ActivityLineParts['waiting']>; repository: string | null | undefined }) {
  const { kind, ref, label } = waiting;
  if (kind === 'person') return <EntityPill type="person" id={ref.replace(/^@/, '')} fallback={label} />;
  if (kind === 'pr') return <EntityPill shortId={/^#\d+$/.test(ref) && repository ? `${repository}${ref}` : ref} fallback={label} neutral />;
  return <EntityPill type={kind} id={ref} fallback={label} neutral />;
}

export function ActivityLine({ activity, now, repository }: { activity: RowActivity; now: number; repository?: string | null }) {
  const Theme = useTheme();
  const p = activityLineParts(activity, now);
  const tone = p.warn ? Theme.yellow : Theme.textMuted0;
  const kind = activity.state === 'sleeping' ? activity.flavor : activity.state;
  return (
    <RNView style={styles.line} testID={`activity-line-${kind}`}>
      <RNView style={styles.arrowColumn}>
        <Feather name="corner-down-right" size={11} color={tone} style={{ opacity: p.warn ? 1 : 0.7 }} accessibilityLabel={p.label} />
      </RNView>
      <RNView style={styles.body}>
        {p.alert ? <Alert color={tone} bg={Theme.bg} /> : null}
        {p.waiting ? (
          <>
            <RNText maxFontSizeMultiplier={1.2} style={[styles.text, { color: tone }]}>waiting on</RNText>
            <RNText maxFontSizeMultiplier={1.2} numberOfLines={1} style={[styles.text, styles.shrink, { color: tone }]}>
              <WaitPill waiting={p.waiting} repository={repository} />
            </RNText>
            {p.waiting.tail ? <RNText maxFontSizeMultiplier={1.2} style={[styles.text, { color: tone }]}>{p.waiting.tail}</RNText> : null}
          </>
        ) : null}
        {p.words ? <RNText maxFontSizeMultiplier={1.2} numberOfLines={1} style={[styles.text, styles.shrink, { color: tone }]}>{p.words}</RNText> : null}
        {p.bar ? <ShipBar stage={p.bar.stage} failed={p.bar.failed} /> : null}
      </RNView>
      {p.right ? <RNText maxFontSizeMultiplier={1.2} numberOfLines={1} style={[styles.text, styles.right, { color: tone }]}>{p.right}</RNText> : null}
    </RNView>
  );
}

const styles = StyleSheet.create({
  line: { flexDirection: 'row', alignItems: 'center', marginTop: 4, minHeight: 20 },
  // Centred on the row's 6pt status-mark column (MOBILE_SESSION_STYLE.dot),
  // ending where the row's text column starts (the mark, then Spacing.sm).
  arrowColumn: { width: 14, marginLeft: -4, marginRight: Spacing.sm - 4, alignItems: 'center' },
  body: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 5, overflow: 'hidden' },
  text: { fontSize: 12, lineHeight: 18 },
  shrink: { flexShrink: 1 },
  bar: { fontSize: 9, letterSpacing: 0.5 },
  right: { marginLeft: 8, fontVariant: ['tabular-nums'] },
});
