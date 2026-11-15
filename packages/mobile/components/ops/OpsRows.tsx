// The rows the phone's Ops screens share: an issue (an event group: what
// failed, how often, how recently) and a recording (who, where, how long, what
// broke). Each opens its own screen. Nothing here fetches.
import { StyleSheet, TouchableOpacity, View as RNView } from 'react-native';
import { useRouter } from 'expo-router';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import { Text as RNText } from '@/components/Themed';
import { Spacing, themedStyles, useTheme, type Palette } from '@/constants/Theme';
import { Mono, uiFace } from '@/constants/fonts';
import { relTimeShort } from '@codecast/shared/time';
import { formatReplayTime, personLabel, routeOf, urlPath } from '@codecast/shared/replay';
import type { OpsGroup, OpsReplay } from '@codecast/web/components/ops/opsTypes';

type IconName = React.ComponentProps<typeof FontAwesome>['name'];

/** "just now", "12m ago"; "never" for nothing. */
export function ago(at: number | null | undefined, now: number): string {
  if (!at) return 'never';
  const r = relTimeShort(at, now);
  return r === 'now' ? 'just now' : `${r} ago`;
}

/** A length on the replay clock without its tenths: "5:00". */
export const clock = (ms: number) => formatReplayTime(ms).replace(/\.\d$/, '');

export function groupKindLook(kind: string, t: Palette): { icon: IconName; color: string } {
  switch (kind) {
    case 'error': return { icon: 'bug', color: t.red };
    case 'replay_issue': return { icon: 'film', color: t.orange };
    case 'job': return { icon: 'cogs', color: t.orange };
    case 'check': return { icon: 'check-square-o', color: t.violet };
    case 'metric': return { icon: 'line-chart', color: t.cyan };
    default: return { icon: 'exclamation-circle', color: t.textMuted };
  }
}

export function groupStatusColor(status: string, t: Palette): string {
  return status === 'open' ? t.red : status === 'resolved' ? t.green : t.textMuted0;
}

/** The last day of a group's hourly counts as a strip of bars, the web's sparkline in miniature. */
export function HourStrip({ buckets, now, color, height = 18, hours = 24 }: { buckets: { hour: number; count: number }[]; now: number; color: string; height?: number; hours?: number }) {
  const HOUR = 3600_000;
  const end = Math.floor(now / HOUR) * HOUR;
  const by = new Map(buckets.map((b) => [b.hour, b.count]));
  const vals = Array.from({ length: hours }, (_, i) => by.get(end - (hours - 1 - i) * HOUR) ?? 0);
  const max = Math.max(1, ...vals);
  return (
    <RNView style={[styles.strip, { height }]}>
      {vals.map((v, i) => (
        <RNView key={i} style={[styles.stripBar, { height: v ? Math.max(2, (v / max) * height) : 1, backgroundColor: v ? color : color + '33' }]} />
      ))}
    </RNView>
  );
}

export function GroupRow({ g, now, first }: { g: OpsGroup; now: number; first?: boolean }) {
  const Theme = useTheme();
  const router = useRouter();
  const look = groupKindLook(g.kind, Theme);
  const regressed = !!g.regressed_at && g.status === 'open';
  const fresh = now - g.first_seen < 24 * 3600_000;
  return (
    <TouchableOpacity style={[styles.row, !first && styles.rule]} onPress={() => router.push(`/issue/${g.short_id || g._id}` as never)} activeOpacity={0.6} testID={`ops-group-${g.short_id}`}>
      <FontAwesome name={look.icon} size={13} color={look.color} style={styles.icon} />
      <RNView style={styles.body}>
        <RNText style={styles.title} numberOfLines={2}>{g.title}</RNText>
        <RNView style={styles.metaRow}>
          <RNText style={[styles.count, { color: look.color }]}>×{g.count.toLocaleString()}</RNText>
          {g.users ? <RNText style={styles.meta}>{g.users} {g.users === 1 ? 'person' : 'people'}</RNText> : null}
          <RNText style={styles.meta}>{ago(g.last_seen, now)}</RNText>
          {regressed && <RNText style={[styles.tag, { color: Theme.orange, borderColor: Theme.orange + '55' }]}>regressed</RNText>}
          {!regressed && fresh && g.status === 'open' && <RNText style={[styles.tag, { color: Theme.magenta, borderColor: Theme.magenta + '55' }]}>new</RNText>}
          {g.status !== 'open' && <RNText style={[styles.tag, { color: groupStatusColor(g.status, Theme), borderColor: Theme.borderLight }]}>{g.status}</RNText>}
        </RNView>
      </RNView>
      <HourStrip buckets={g.buckets} now={now} color={look.color} />
      <FontAwesome name="angle-right" size={14} color={Theme.textDim} />
    </TouchableOpacity>
  );
}

/** A linked issue the store holds no row for yet: its name and status from the replay's detail. */
export function GroupRefRow({ g, first }: { g: { _id: string; short_id: string; kind: string; title: string; status: string }; first?: boolean }) {
  const Theme = useTheme();
  const router = useRouter();
  const look = groupKindLook(g.kind, Theme);
  return (
    <TouchableOpacity style={[styles.row, !first && styles.rule]} onPress={() => router.push(`/issue/${g.short_id || g._id}` as never)} activeOpacity={0.6}>
      <FontAwesome name={look.icon} size={13} color={look.color} style={styles.icon} />
      <RNView style={styles.body}>
        <RNText style={styles.title} numberOfLines={2}>{g.title}</RNText>
        <RNView style={styles.metaRow}>
          <RNText style={[styles.meta, styles.mono]}>{g.short_id}</RNText>
          <RNText style={[styles.meta, { color: groupStatusColor(g.status, Theme) }]}>{g.status}</RNText>
        </RNView>
      </RNView>
      <FontAwesome name="angle-right" size={14} color={Theme.textDim} />
    </TouchableOpacity>
  );
}

export function ReplayRow({ r, now, first, showPerson = true }: { r: OpsReplay; now: number; first?: boolean; showPerson?: boolean }) {
  const Theme = useTheme();
  const router = useRouter();
  const path = r.url ? routeOf(urlPath(r.url)) : null;
  const broke = r.counts.errors > 0 || r.counts.failed_requests > 0;
  return (
    <TouchableOpacity style={[styles.row, !first && styles.rule]} onPress={() => router.push(`/replay/${r.short_id || r._id}` as never)} activeOpacity={0.6} testID={`ops-replay-${r.short_id}`}>
      <FontAwesome name="play-circle-o" size={15} color={broke ? Theme.orange : Theme.cyan} style={styles.icon} />
      <RNView style={styles.body}>
        <RNText style={styles.title} numberOfLines={1}>{showPerson ? personLabel(r.user) : (path ?? 'no page recorded')}</RNText>
        <RNView style={styles.metaRow}>
          {showPerson && path ? <RNText style={[styles.meta, styles.mono]} numberOfLines={1}>{path}</RNText> : null}
          {r.duration_ms ? <RNText style={styles.meta}>{clock(r.duration_ms)}</RNText> : null}
          {r.counts.errors > 0 && <RNText style={[styles.meta, { color: Theme.red }]}>{r.counts.errors} err</RNText>}
          {r.counts.failed_requests > 0 && <RNText style={[styles.meta, { color: Theme.orange }]}>{r.counts.failed_requests} failed</RNText>}
        </RNView>
      </RNView>
      <RNText style={styles.meta}>{ago(r.started_at, now)}</RNText>
      <FontAwesome name="angle-right" size={14} color={Theme.textDim} />
    </TouchableOpacity>
  );
}

/** A figure in a tile: a label, a value, a line under it. */
export function Vital({ label, value, sub, color, subColor }: { label: string; value: string; sub?: string | null; color?: string; subColor?: string }) {
  return (
    <RNView style={styles.vital}>
      <RNText style={styles.vitalLabel}>{label}</RNText>
      <RNText style={[styles.vitalValue, color ? { color } : null]} numberOfLines={1}>{value}</RNText>
      {sub ? <RNText style={[styles.vitalSub, subColor ? { color: subColor } : null]} numberOfLines={1}>{sub}</RNText> : null}
    </RNView>
  );
}

export const opsStyles = themedStyles((Theme) => StyleSheet.create({
  card: { borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, borderColor: Theme.borderLight, backgroundColor: Theme.card, overflow: 'hidden' },
  vitals: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: Spacing.xl },
  empty: { paddingHorizontal: 12, paddingVertical: 14, fontSize: 13, color: Theme.textMuted0 },
}));

const styles = themedStyles((Theme) => StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, paddingVertical: 11 },
  rule: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: Theme.borderLight },
  icon: { width: 16, textAlign: 'center' },
  body: { flex: 1, minWidth: 0, gap: 4 },
  title: { fontSize: 14, lineHeight: 19, fontWeight: '500', color: Theme.text },
  metaRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', columnGap: 8, rowGap: 2 },
  meta: { fontSize: 12, color: Theme.textMuted0, fontVariant: ['tabular-nums'] },
  count: { fontSize: 12, fontWeight: '600', fontVariant: ['tabular-nums'] },
  mono: { fontFamily: uiFace(Mono.regular), maxWidth: 180 },
  tag: { fontSize: 11, borderWidth: 1, borderRadius: 4, paddingHorizontal: 4, overflow: 'hidden' },
  strip: { flexDirection: 'row', alignItems: 'flex-end', gap: 1, width: 48 },
  stripBar: { flex: 1, borderRadius: 1 },
  vital: { flexBasis: '47%', flexGrow: 1, minWidth: 0, borderRadius: 8, borderWidth: StyleSheet.hairlineWidth, borderColor: Theme.borderLight, backgroundColor: Theme.bgAlt, paddingHorizontal: 12, paddingVertical: 10 },
  vitalLabel: { fontSize: 10, fontWeight: '600', letterSpacing: 1, textTransform: 'uppercase', color: Theme.textMuted0, marginBottom: 4 },
  vitalValue: { fontSize: 15, fontWeight: '500', color: Theme.text, fontVariant: ['tabular-nums'] },
  vitalSub: { marginTop: 2, fontSize: 11, color: Theme.textMuted0 },
}));
