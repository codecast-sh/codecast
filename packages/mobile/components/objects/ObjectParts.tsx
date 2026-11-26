// The pieces a project's and a goal's screen share: the header's share and
// menu buttons, a status chip, the progress bar with its count, a section
// label, the loading / not-found state, and the sessions block. Both screens
// read the store and draw these; nothing here fetches.
import { Children, cloneElement, isValidElement, useMemo, useState, type ReactElement, type ReactNode } from 'react';
import { useTextSize } from '@/hooks/useTextSize';
import { sizeStyle } from '@/lib/textSize';
import { ActivityIndicator, StyleSheet, TouchableOpacity, View as RNView } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import { Text as RNText } from '@/components/Themed';
import { Spacing, themedStyles, useTheme, chipShell, chipText, chipTint, CHROME_FONT_CAP } from '@/constants/Theme';
import { Mono, uiFace } from '@/constants/fonts';
import { InboxRowEnvProvider, SessionItem, type SessionData } from '@/components/SessionItem';
import { showActionSheet, type SheetItem } from '@/lib/popups';
import { copyToClipboard } from '@/lib/clipboard';
import { shareLink } from '@/lib/shareLink';
import { buildEntityUrl, type EntityType } from '@codecast/shared/entities';
import type { ProjectProgress } from '@codecast/shared/tasks';

type IconName = React.ComponentProps<typeof FontAwesome>['name'];

/** The nav header every object screen wears: its short id as the title, and
 *  Share (the system sheet with the object's codecast.sh address) beside a
 *  menu of the screen's other verbs. */
export function ObjectHeader({ type, shortId, refId, link, title, menu }: {
  /** Null for a page with no entity type (an Ops issue); give it `link`. */
  type: EntityType | null;
  /** What the header shows (a commit's 7-char sha). */
  shortId?: string;
  /** The id its address is built from, when it differs from shortId (`owner/repo@sha`). */
  refId?: string;
  /** The address to share when the page has no entity type. */
  link?: string;
  title: string;
  menu?: SheetItem[];
}) {
  const Theme = useTheme();
  const textSize = useTextSize();
  const ref = refId ?? shortId;
  const url = link ?? (ref && type ? buildEntityUrl(type, ref) : null);
  const items: SheetItem[] = [
    ...(menu ?? []),
    ...(shortId ? [{ label: `Copy ${shortId}`, onPress: () => { void copyToClipboard(shortId); } }] : []),
    ...(url ? [{ label: 'Copy link', onPress: () => { void copyToClipboard(url); } }] : []),
  ];
  return (
    <Stack.Screen
      options={{
        title: shortId ?? title,
        headerStyle: { backgroundColor: Theme.bgAlt },
        headerTintColor: Theme.text,
        headerTitleStyle: sizeStyle({ fontSize: 14, fontFamily: uiFace(Mono.semiBold), color: Theme.textMuted }, textSize),
        headerRight: () => (
          <RNView style={styles.headerButtons}>
            {url && (
              <TouchableOpacity onPress={() => shareLink(url)} hitSlop={8} accessibilityLabel={`Share ${title}`} testID="object-share">
                <FontAwesome name="share-square-o" size={18} color={Theme.textMuted} />
              </TouchableOpacity>
            )}
            {items.length > 0 && (
              <TouchableOpacity onPress={() => showActionSheet(title, items)} hitSlop={8} accessibilityLabel="More" testID="object-menu">
                <FontAwesome name="ellipsis-h" size={18} color={Theme.textMuted} />
              </TouchableOpacity>
            )}
          </RNView>
        ),
      }}
    />
  );
}

/** A fact as a chip: an icon, a word, its colour. Tappable when it opens or changes something. */
/** `link`: the press opens another object (a right caret); otherwise a press picks a value here (a down caret). */
export function FactChip({ icon, label, color, onPress, link, testID }: { icon?: IconName; label: string; color: string; onPress?: () => void; link?: boolean; testID?: string }) {
  const body = (
    <>
      {icon && <FontAwesome name={icon} size={11} color={color} />}
      <RNText maxFontSizeMultiplier={CHROME_FONT_CAP} style={[chipText, { color }]} numberOfLines={1}>{label}</RNText>
      {onPress && <FontAwesome name={link ? 'angle-right' : 'angle-down'} size={11} color={color} style={{ opacity: 0.7 }} />}
    </>
  );
  return onPress
    ? <TouchableOpacity style={[chipShell, chipTint(color), styles.chip]} onPress={onPress} activeOpacity={0.6} testID={testID}>{body}</TouchableOpacity>
    : <RNView style={[chipShell, chipTint(color), styles.chip]} testID={testID}>{body}</RNView>;
}

/** A target day as a chip word: "Dec 3", red once it has passed and the work is still open. */
export function targetChip(ts: number, now: number, ended: boolean, Theme: ReturnType<typeof useTheme>): { label: string; color: string } {
  const d = new Date(ts);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  const label = d.toLocaleDateString(undefined, sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' });
  return { label: `Due ${label}`, color: !ended && ts < now ? Theme.red : Theme.textMuted };
}

export function SectionLabel({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <RNView style={styles.labelRow}>
      <RNText maxFontSizeMultiplier={CHROME_FONT_CAP} style={styles.sectionLabel}>{children}</RNText>
      {right}
    </RNView>
  );
}

/** Done over total, with what is in flight beside it, as the plan screen draws it. */
export function ProgressBlock({ progress }: { progress: ProjectProgress }) {
  if (progress.total === 0) return null;
  const pct = (n: number) => `${(n / progress.total) * 100}%` as any;
  return (
    <RNView style={styles.progress} testID={`object-progress-${progress.done}-${progress.total}`}>
      <RNView style={styles.bar}>
        <RNView style={[styles.barDone, { width: pct(progress.done) }]} />
        <RNView style={[styles.barIp, { width: pct(progress.in_progress) }]} />
      </RNView>
      <RNText style={styles.progressText}>
        {progress.done} of {progress.total} tasks done{progress.in_progress ? ` · ${progress.in_progress} in progress` : ''}
      </RNText>
    </RNView>
  );
}

/** The spinner while a cold cache loads, then "not found" once the feed has answered. */
export function ObjectMissing({ what, id, loading, action }: {
  what: string; id?: string; loading: boolean;
  /** Where the object may still be found (GitHub for a commit), in place of Go back. */
  action?: { label: string; onPress: () => void };
}) {
  const Theme = useTheme();
  const router = useRouter();
  return (
    <>
      <Stack.Screen options={{ title: id ?? what }} />
      <RNView style={styles.center}>
        {loading ? (
          <>
            <ActivityIndicator size="small" color={Theme.textMuted} />
            <RNText style={styles.dim}>Loading {what.toLowerCase()}…</RNText>
          </>
        ) : (
          <>
            <FontAwesome name="exclamation-circle" size={28} color={Theme.textMuted0} />
            <RNText style={styles.dim}>{what} not found in this workspace</RNText>
            <TouchableOpacity onPress={action?.onPress ?? (() => router.back())} style={styles.backBtn}>
              <RNText style={styles.backBtnText}>{action?.label ?? 'Go back'}</RNText>
            </TouchableOpacity>
          </>
        )}
      </RNView>
    </>
  );
}

const SESSIONS_SHOWN = 5;

/** Sessions as the inbox draws them, newest first; past five the rest fold. */
export function SessionsBlock({ sessions }: { sessions: SessionData[] }) {
  const router = useRouter();
  const [all, setAll] = useState(false);
  const sorted = useMemo(() => [...sessions].sort((a, b) => b.updated_at - a.updated_at), [sessions]);
  if (sorted.length === 0) return null;
  const shown = all ? sorted : sorted.slice(0, SESSIONS_SHOWN);
  return (
    <RNView style={styles.section}>
      <SectionLabel>{`Sessions · ${sorted.length}`}</SectionLabel>
      <InboxRowEnvProvider>
        <RNView style={styles.list}>
          {shown.map((s) => <SessionItem key={s._id} session={s} onPress={() => router.push(`/session/${s._id}` as never)} />)}
        </RNView>
      </InboxRowEnvProvider>
      <MoreToggle hidden={sorted.length - SESSIONS_SHOWN} open={all} onPress={() => setAll((v) => !v)} />
    </RNView>
  );
}

/** A row that opens another object: a glyph, its title, and a fact on the right.
 *  Without `onPress` it has nothing to open: a plain row, no caret. */
export function LinkRow({ icon, color, title, meta, onPress, testID }: { icon: IconName; color: string; title: string; meta?: string; onPress?: () => void; testID?: string }) {
  const Theme = useTheme();
  const body = (
    <>
      <FontAwesome name={icon} size={13} color={color} style={styles.linkIcon} />
      <RNText style={styles.linkTitle} numberOfLines={2}>{title}</RNText>
      {meta ? <RNText maxFontSizeMultiplier={CHROME_FONT_CAP} style={styles.linkMeta} numberOfLines={1}>{meta}</RNText> : null}
      {onPress ? <FontAwesome name="angle-right" size={14} color={Theme.textDim} /> : null}
    </>
  );
  return onPress
    ? <TouchableOpacity style={styles.linkRow} onPress={onPress} activeOpacity={0.6} testID={testID}>{body}</TouchableOpacity>
    : <RNView style={styles.linkRow} testID={testID}>{body}</RNView>;
}

/** The fold under a list cut short: "12 more", then "Show fewer". Nothing when nothing is hidden. */
export function MoreToggle({ hidden, open, onPress }: { hidden: number; open: boolean; onPress: () => void }) {
  const Theme = useTheme();
  if (hidden <= 0) return null;
  return (
    <TouchableOpacity style={styles.more} onPress={onPress} activeOpacity={0.6}>
      <RNText maxFontSizeMultiplier={CHROME_FONT_CAP} style={styles.moreText}>{open ? 'Show fewer' : `${hidden} more`}</RNText>
      <FontAwesome name={open ? 'angle-up' : 'angle-down'} size={13} color={Theme.textMuted0} />
    </TouchableOpacity>
  );
}

/** A verb the object takes here (Resolve, Pause, Run now), outlined in its colour;
 *  `filled` marks the one a person most often came to press. Consequential
 *  verbs ask first in the caller's onPress. Lay several out in `objectStyles.verbs`. */
export function ActionButton({ icon, label, color, filled, onPress, disabled, testID }: { icon: IconName; label: string; color: string; filled?: boolean; onPress: () => void; disabled?: boolean; testID?: string }) {
  return (
    <TouchableOpacity onPress={onPress} disabled={disabled} activeOpacity={0.7} style={[styles.verb, { borderColor: color + '55' }, filled && { backgroundColor: color + '18' }, disabled && { opacity: 0.5 }]} accessibilityRole="button" accessibilityState={disabled ? { disabled: true, busy: true } : undefined} testID={testID}>
      <FontAwesome name={icon} size={13} color={color} />
      <RNText maxFontSizeMultiplier={CHROME_FONT_CAP} style={[styles.verbText, { color }]}>{label}</RNText>
    </TouchableOpacity>
  );
}

/** An object's facts as a table: a label down the left, its value beside it, rules between. Rows that render nothing drop out. */
export function Facts({ children, testID }: { children: ReactNode; testID?: string }) {
  const rows = Children.toArray(children).filter(isValidElement) as ReactElement<{ rule?: boolean }>[];
  if (rows.length === 0) return null;
  return <RNView style={styles.facts} testID={testID}>{rows.map((r, i) => cloneElement(r, { rule: i > 0 }))}</RNView>;
}

/** One fact. A string value reads as text; any other value (shas, chips) lays out in a wrapping row.
 *  `onPress`: the row opens what it names, with a caret. */
export function FactRow({ label, icon, tone, onPress, rule, children, testID }: {
  label: string; icon?: IconName; tone?: string; onPress?: () => void; rule?: boolean; children: ReactNode; testID?: string;
}) {
  const Theme = useTheme();
  const body = (
    <>
      {icon ? <FontAwesome name={icon} size={12} color={tone ?? Theme.textMuted} style={styles.factIcon} /> : null}
      <RNText style={styles.factLabel} maxFontSizeMultiplier={CHROME_FONT_CAP}>{label}</RNText>
      <RNView style={styles.factBody}>
        {typeof children === 'string'
          ? <RNText style={[styles.factValue, tone ? { color: tone } : null]} numberOfLines={3}>{children}</RNText>
          : children}
      </RNView>
      {onPress ? <FontAwesome name="angle-right" size={14} color={Theme.textDim} /> : null}
    </>
  );
  const style = [styles.fact, rule && styles.factRule];
  return onPress
    ? <TouchableOpacity style={style} onPress={onPress} activeOpacity={0.6} testID={testID}>{body}</TouchableOpacity>
    : <RNView style={style} testID={testID}>{body}</RNView>;
}

export const objectStyles = themedStyles((Theme) => StyleSheet.create({
  container: { flex: 1, backgroundColor: Theme.bg },
  content: { padding: Spacing.lg, paddingBottom: 56 },
  title: { fontSize: 20, fontWeight: '700', color: Theme.text, lineHeight: 26, marginBottom: Spacing.md },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: Spacing.lg },
  section: { marginBottom: Spacing.xl },
  body: { fontSize: 14, color: Theme.text, lineHeight: 21 },
  list: { borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, borderColor: Theme.borderLight, backgroundColor: Theme.card, overflow: 'hidden' },
  primary: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, height: 40, borderRadius: 10, marginBottom: Spacing.xl },
  primaryText: { fontSize: 14, fontWeight: '700', color: Theme.bg },
  ghost: { flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start', paddingVertical: 6 },
  ghostText: { fontSize: 13, fontWeight: '600', color: Theme.accent },
  dim: { fontSize: 13, color: Theme.textMuted },
  empty: { fontSize: 13, color: Theme.textMuted0, paddingVertical: Spacing.sm },
  verbs: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: Spacing.lg },
}));

const styles = themedStyles((Theme) => StyleSheet.create({
  headerButtons: { flexDirection: 'row', alignItems: 'center', gap: 20, paddingHorizontal: 4 },
  chip: { gap: 5, maxWidth: 260 },
  labelRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 },
  sectionLabel: { fontSize: 12, fontWeight: '600', color: Theme.textMuted0, textTransform: 'uppercase', letterSpacing: 0.5 },
  section: { marginBottom: Spacing.xl },
  list: { borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, borderColor: Theme.borderLight, backgroundColor: Theme.card, overflow: 'hidden' },
  more: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 8, paddingHorizontal: 2 },
  moreText: { fontSize: 12.5, fontWeight: '600', color: Theme.textMuted },
  progress: { gap: 8, marginBottom: Spacing.xl },
  bar: { height: 6, backgroundColor: Theme.borderLight, borderRadius: 3, flexDirection: 'row', overflow: 'hidden' },
  barDone: { height: 6, backgroundColor: Theme.green },
  barIp: { height: 6, backgroundColor: Theme.accent },
  progressText: { fontSize: 12, color: Theme.textMuted, fontVariant: ['tabular-nums'] },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 8, backgroundColor: Theme.bg, padding: Spacing.xxl },
  dim: { fontSize: 14, color: Theme.textMuted, textAlign: 'center' },
  backBtn: { marginTop: 8, paddingHorizontal: 16, paddingVertical: 8, borderRadius: 8, backgroundColor: Theme.bgAlt, borderWidth: StyleSheet.hairlineWidth, borderColor: Theme.borderLight },
  backBtnText: { fontSize: 14, fontWeight: '500', color: Theme.accent },
  linkRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: Spacing.md, paddingVertical: 11, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: Theme.bgHighlight },
  linkIcon: { width: 16, textAlign: 'center' },
  linkTitle: { flex: 1, fontSize: 14.5, fontWeight: '500', color: Theme.text },
  verb: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8, borderWidth: 1 },
  verbText: { fontSize: 13, fontWeight: '600' },
  linkMeta: { fontSize: 12, color: Theme.textMuted, fontVariant: ['tabular-nums'], maxWidth: 140 },
  facts: { borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, borderColor: Theme.borderLight, backgroundColor: Theme.card, overflow: 'hidden', marginBottom: Spacing.xl },
  fact: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: Spacing.md, paddingVertical: 10, minHeight: 42 },
  factRule: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: Theme.borderLight },
  factIcon: { width: 14, textAlign: 'center' },
  factLabel: { width: 76, fontSize: 12.5, color: Theme.textMuted0 },
  factBody: { flex: 1, minWidth: 0, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 },
  factValue: { flexShrink: 1, fontSize: 14, lineHeight: 19, color: Theme.text },
}));
