// The weekly card, the phone twin of the web's /week: the person's week with
// coding agents as one card, a step between the weeks they have cards for,
// what the card shows, and publishing it to the native share sheet. ?w=<week
// key> opens one week; without it, the current week.
//
// The web draws the card at its 1200x630 social-image size and scales it to
// the column, which on a phone puts its labels under 6pt. Here the same stats
// (weekCardFigures, shared with the web card) are laid out for the column.
//
// Local-first as the web page is: cards come from the store (weeklyCards, fed
// by weeklyCards.listMine), every option and the publish switch are store
// actions, and building a card is the one server action whose row syncs in.
import { useState } from 'react';
import { ActivityIndicator, Platform, ScrollView, Share, StyleSheet, Switch, TouchableOpacity, View as RNView } from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import { useAction } from 'convex/react';
import { api } from '@codecast/convex/convex/_generated/api';
import { CODECAST_BASE_URL, sharePath } from '@codecast/shared/entities';
import { localTimeZone } from '@codecast/shared/time';
import {
  WEEK_DAY_NAMES,
  formatCount,
  publicWeekCard,
  weekBounds,
  weekCardFigures,
  weekCardShareText,
  weekRangeLabel,
  weeklyCardAllowed,
  type WeekCardStats,
  type WeekWhich,
} from '@codecast/shared/contracts/weeklyCard';
import { useInboxStore } from '@codecast/web/store/inboxStore';
import { useCollectionRows } from '@codecast/web/hooks/useCollectionRows';
import { useSyncWeeklyCards } from '@codecast/web/hooks/useSyncWeeklyCards';
import { useMountEffect } from '@codecast/web/hooks/useMountEffect';
import { weekCardLedger } from '@codecast/web/components/weeklyCard/weekCardLedger';
import { ledgerLines } from '@codecast/web/components/consequential/roleOnline';
import { Text as RNText } from '@/components/Themed';
import { CHROME_FONT_CAP, Spacing, themedStyles, useTheme } from '@/constants/Theme';
import { Mono, uiFace } from '@/constants/fonts';
import { ActionButton, ObjectMissing, objectStyles } from '@/components/objects/ObjectParts';
import { appAlert } from '@/lib/popups';
import { copyToClipboard } from '@/lib/clipboard';

type CardRow = {
  _id: string;
  week_key: string;
  stats: WeekCardStats;
  generated_at: number;
  show_projects?: boolean;
  show_tokens?: boolean;
  share_token?: string;
};

const cardSig = (c: CardRow) => `${c._id}:${c.generated_at}:${c.share_token ?? ''}:${c.show_projects ? 1 : 0}${c.show_tokens ? 1 : 0}`;

export default function WeekScreen() {
  const user = useInboxStore((s) => s.currentUser) as { name?: string; staff?: boolean; weekly_card_enabled?: boolean } | null | undefined;
  if (!user) return <ObjectMissing what="Week" loading={user === undefined} />;
  if (!weeklyCardAllowed(user)) return <ObjectMissing what="Weekly card" loading={false} />;
  return <Week name={user.name ?? null} enabled={!!user.weekly_card_enabled} />;
}

function Week({ name, enabled }: { name: string | null; enabled: boolean }) {
  const Theme = useTheme();
  useSyncWeeklyCards();
  const { w: asked } = useLocalSearchParams<{ w?: string }>();
  const tz = localTimeZone();
  const now = Date.now();
  const buildable: Record<string, WeekWhich> = {
    [weekBounds(now, tz, 'current').key]: 'current',
    [weekBounds(now, tz, 'last').key]: 'last',
  };
  const cards = useCollectionRows<CardRow>('weeklyCards', { sig: cardSig });
  // Every week the person can step to: the two the server builds on demand,
  // every week a card is stored for, and the one the link asked for. Newest first.
  const start = asked || weekBounds(now, tz, 'current').key;
  const weeks = [...new Set([...Object.keys(buildable), ...cards.map((c) => c.week_key), start])].sort().reverse();
  const [key, setKey] = useState(start);
  const at = weeks.indexOf(key);
  const card = cards.find((c) => c.week_key === key);
  const which = buildable[key];

  return (
    <>
      <Stack.Screen
        options={{
          title: 'Your week',
          headerStyle: { backgroundColor: Theme.bgAlt },
          headerTintColor: Theme.text,
          headerTitleStyle: { fontSize: 14, fontFamily: uiFace(Mono.semiBold), color: Theme.textMuted },
        }}
      />
      <ScrollView style={objectStyles.container} contentContainerStyle={objectStyles.content}>
        <RNView style={styles.stepper}>
          <Step icon="chevron-left" label="Older week" disabled={at >= weeks.length - 1} onPress={() => setKey(weeks[at + 1])} />
          <RNView style={styles.stepperMid}>
            <RNText style={styles.stepperRange} maxFontSizeMultiplier={CHROME_FONT_CAP} testID="week-range">
              {card ? weekRangeLabel(card.stats) : weekLabelOfKey(key)}
            </RNText>
            <RNText style={styles.stepperWhich} maxFontSizeMultiplier={CHROME_FONT_CAP}>
              {which === 'current' ? 'This week' : which === 'last' ? 'Last week' : `${weeksAgo(key, weeks[0])} weeks ago`}
            </RNText>
          </RNView>
          <Step icon="chevron-right" label="Newer week" disabled={at <= 0} onPress={() => setKey(weeks[at - 1])} />
        </RNView>

        {card ? (
          <CardPanel key={card._id} card={card} name={name} which={which} />
        ) : which ? (
          <Building key={key} which={which} tz={tz} />
        ) : (
          <RNView style={styles.placeholder}>
            <FontAwesome name="calendar-o" size={22} color={Theme.textMuted0} />
            <RNText style={styles.dim}>No card for this week</RNText>
          </RNView>
        )}

        <RNView style={styles.optionRow}>
          <RNText style={styles.optionLabel}>Every Monday</RNText>
          <Switch
            value={enabled}
            onValueChange={(on) => useInboxStore.getState().setWeeklyCardEnabled(on)}
            trackColor={{ false: Theme.bgHighlight, true: Theme.accent }}
            thumbColor="#fff"
            ios_backgroundColor={Theme.bgHighlight}
            accessibilityLabel="Build my card every Monday"
            testID="week-every-monday"
          />
        </RNView>
      </ScrollView>
    </>
  );
}

function Step({ icon, label, disabled, onPress }: { icon: 'chevron-left' | 'chevron-right'; label: string; disabled: boolean; onPress: () => void }) {
  const Theme = useTheme();
  return (
    <TouchableOpacity onPress={onPress} disabled={disabled} hitSlop={10} style={[styles.stepBtn, disabled && { opacity: 0.3 }]} accessibilityRole="button" accessibilityLabel={label}>
      <FontAwesome name={icon} size={14} color={Theme.text} />
    </TouchableOpacity>
  );
}

const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "Week of Nov 10" from a "YYYY-MM-DD" Monday, for a week with no card to read the range from. */
function weekLabelOfKey(key: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  return m ? `Week of ${SHORT_MONTHS[Number(m[2]) - 1]} ${Number(m[3])}` : key;
}
function weeksAgo(key: string, newest: string): number {
  return Math.round((Date.parse(newest) - Date.parse(key)) / (7 * 86_400_000));
}

function useBuild(which: WeekWhich | undefined, tz: string) {
  const generate = useAction(api.weeklyCards.generate);
  const [state, setState] = useState<'idle' | 'building' | 'failed'>('idle');
  const build = () => {
    if (!which) return;
    setState('building');
    generate({ which, tz }).then(() => setState('idle'), () => setState('failed'));
  };
  return { state, build };
}

/** No card for this week yet: build it now. */
function Building({ which, tz }: { which: WeekWhich; tz: string }) {
  const Theme = useTheme();
  const { state, build } = useBuild(which, tz);
  useMountEffect(build);
  return (
    <RNView style={styles.placeholder} testID="week-building">
      {state === 'failed' ? (
        <ActionButton icon="refresh" label="Could not build. Try again" color={Theme.red} onPress={build} />
      ) : (
        <>
          <ActivityIndicator size="small" color={Theme.textMuted} />
          <RNText style={styles.dim}>Counting your week</RNText>
        </>
      )}
    </RNView>
  );
}

function CardPanel({ card, name, which }: { card: CardRow; name: string | null; which: WeekWhich | undefined }) {
  const Theme = useTheme();
  const { state, build } = useBuild(which, card.stats.tz);
  const published = !!card.share_token;
  const opts = { show_projects: !!card.show_projects, show_tokens: !!card.show_tokens };
  const shown = publicWeekCard(card.stats, opts);
  const url = card.share_token ? `${CODECAST_BASE_URL}${sharePath('card', card.share_token)}` : null;
  const setOpt = (patch: Partial<typeof opts>) => useInboxStore.getState().setWeeklyCardOptions(card._id, patch);

  const openSheet = (link: string) => {
    const message = weekCardShareText(shown);
    void Share.share(Platform.OS === 'ios' ? { message, url: link } : { message: `${message} ${link}` }).catch(() => {});
  };
  // Publishing puts the card on the open web, so it asks first with the
  // web's review; once public, Share goes straight to the sheet.
  const share = () => {
    if (url) return openSheet(url);
    const l = weekCardLedger(card.stats, opts);
    appAlert(`${l.name}: ${l.subject}`, ledgerLines(l).join('\n'), [
      { text: 'Not now', style: 'cancel' },
      {
        text: l.confirm,
        onPress: () => {
          const token = crypto.randomUUID();
          useInboxStore.getState().setObjectShareLink('card', card._id, token);
          openSheet(`${CODECAST_BASE_URL}${sharePath('card', token)}`);
        },
      },
    ]);
  };
  const unpublish = () => useInboxStore.getState().setObjectShareLink('card', card._id, null);

  return (
    <>
      <CardView stats={shown} name={name} />

      <RNView style={objectStyles.verbs}>
        <ActionButton icon="share-square-o" label="Share" color={Theme.cyan} filled onPress={share} testID="week-share" />
        {url && <ActionButton icon="link" label="Copy link" color={Theme.textMuted} onPress={() => { void copyToClipboard(url); }} testID="week-copy" />}
        {url && <ActionButton icon="eye-slash" label="Unpublish" color={Theme.textMuted} onPress={unpublish} testID="week-unpublish" />}
        {!published && which && (
          <ActionButton icon="refresh" label={state === 'building' ? 'Counting' : 'Recount'} color={Theme.textMuted} onPress={() => state !== 'building' && build()} testID="week-recount" />
        )}
      </RNView>

      <RNView style={styles.options}>
        <OptionRow label="Projects" value={opts.show_projects} disabled={published || card.stats.projects.length === 0} onChange={(v) => setOpt({ show_projects: v })} />
        <OptionRow label="Tokens" value={opts.show_tokens} disabled={published || card.stats.tokens === null} onChange={(v) => setOpt({ show_tokens: v })} rule />
        {url && (
          <RNView style={[styles.optionRow, styles.rule]}>
            <FontAwesome name="globe" size={13} color={Theme.green} />
            <RNText style={[styles.link, { color: Theme.green }]} numberOfLines={1} selectable>{url.replace(/^https:\/\//, '')}</RNText>
          </RNView>
        )}
      </RNView>
    </>
  );
}

function OptionRow({ label, value, disabled, onChange, rule }: { label: string; value: boolean; disabled: boolean; onChange: (v: boolean) => void; rule?: boolean }) {
  const Theme = useTheme();
  return (
    <RNView style={[styles.optionRow, rule && styles.rule]}>
      <RNText style={[styles.optionLabel, disabled && { color: Theme.textMuted0 }]}>{label}</RNText>
      <Switch
        value={value}
        onValueChange={onChange}
        disabled={disabled}
        trackColor={{ false: Theme.bgHighlight, true: Theme.accent }}
        thumbColor="#fff"
        ios_backgroundColor={Theme.bgHighlight}
        accessibilityLabel={`Show ${label.toLowerCase()}`}
      />
    </RNView>
  );
}

/** The card: the same figures as the web's 1200x630 card, laid out for a phone column. */
function CardView({ stats, name }: { stats: WeekCardStats; name: string | null }) {
  const Theme = useTheme();
  const { maxHours, shares, pct, fraction, machines, extras } = weekCardFigures(stats);
  const agentColors = [Theme.cyan, Theme.blue, Theme.magenta, Theme.yellow, Theme.violet, Theme.orange, Theme.green];
  return (
    <RNView style={styles.card} testID={`week-card-${stats.week_key}`}>
      <RNView style={styles.cardHead}>
        <RNText style={styles.cardName} numberOfLines={1}>{name ? `${name}'s week with agents` : 'A week with coding agents'}</RNText>
        {stats.partial && <RNText style={[styles.soFar, { color: Theme.orange, borderColor: Theme.orange + '55' }]}>so far</RNText>}
      </RNView>

      <RNView style={styles.hero}>
        <RNText style={styles.heroValue}>{formatCount(stats.sessions)}</RNText>
        <RNText style={styles.figLabel}>agent sessions</RNText>
      </RNView>

      <RNView style={styles.figures}>
        <Figure value={`${stats.agent_hours}h`} label="agents working" color={Theme.cyan} />
        <Figure value={`${stats.active_days}/7`} label="active days" />
        <Figure value={String(stats.machines.count)} label={stats.machines.count === 1 ? 'machine' : 'machines'} />
      </RNView>
      {machines ? <RNText style={styles.machines}>{machines}</RNText> : null}

      <RNView style={styles.bars}>
        {stats.days.map((d, i) => {
          const best = i === stats.busiest_day;
          return (
            <RNView key={i} style={styles.barCol}>
              <RNText style={[styles.barHours, best && { color: Theme.yellow }]} maxFontSizeMultiplier={CHROME_FONT_CAP}>{d.hours ? `${d.hours}h` : ''}</RNText>
              <RNView style={[styles.bar, { height: Math.max(3, Math.round((d.hours / maxHours) * 88)), backgroundColor: d.hours ? (best ? Theme.yellow : Theme.cyan) : Theme.bgHighlight }]} />
              <RNText style={[styles.barDay, best && { color: Theme.text }]} maxFontSizeMultiplier={CHROME_FONT_CAP}>{WEEK_DAY_NAMES[i]}</RNText>
            </RNView>
          );
        })}
      </RNView>

      {extras.length > 0 && (
        <RNView style={[styles.figures, styles.cardRule]}>
          {extras.map(([k, v]) => <Figure key={k} value={v} label={k} color={k === 'busiest day' ? Theme.yellow : undefined} small />)}
        </RNView>
      )}

      {shares.length > 0 && (
        <RNView style={styles.cardRule}>
          <RNView style={styles.shareBar}>
            {shares.map((a, i) => <RNView key={a.name} style={{ width: `${fraction(a.sessions) * 100}%`, backgroundColor: agentColors[i % agentColors.length] }} />)}
          </RNView>
          <RNView style={styles.legend}>
            {shares.map((a, i) => (
              <RNView key={a.name} style={styles.legendItem}>
                <RNView style={[styles.dot, { backgroundColor: agentColors[i % agentColors.length] }]} />
                <RNText style={styles.legendName}>{a.name}</RNText>
                <RNText style={styles.legendPct}>{pct(a.sessions)}</RNText>
              </RNView>
            ))}
          </RNView>
          {stats.projects.length > 0 && <RNText style={styles.machines}>{stats.projects.slice(0, 3).map((p) => p.name).join(' · ')}</RNText>}
        </RNView>
      )}
    </RNView>
  );
}

function Figure({ value, label, color, small }: { value: string; label: string; color?: string; small?: boolean }) {
  return (
    <RNView style={styles.figure}>
      <RNText style={[small ? styles.figValueSmall : styles.figValue, color ? { color } : null]} numberOfLines={1} adjustsFontSizeToFit>{value}</RNText>
      <RNText style={styles.figLabel} numberOfLines={1}>{label}</RNText>
    </RNView>
  );
}

const styles = themedStyles((Theme) => StyleSheet.create({
  stepper: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md, marginBottom: Spacing.lg },
  stepBtn: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', borderWidth: StyleSheet.hairlineWidth, borderColor: Theme.borderLight, backgroundColor: Theme.card },
  stepperMid: { flex: 1, alignItems: 'center', gap: 2 },
  stepperRange: { fontSize: 16, fontWeight: '700', color: Theme.text, fontVariant: ['tabular-nums'] },
  stepperWhich: { fontSize: 12, color: Theme.textMuted },
  placeholder: { height: 260, alignItems: 'center', justifyContent: 'center', gap: 10, borderRadius: 12, borderWidth: 1, borderStyle: 'dashed', borderColor: Theme.borderLight, marginBottom: Spacing.lg },
  dim: { fontSize: 13, color: Theme.textMuted },
  card: { borderRadius: 14, padding: Spacing.lg, backgroundColor: Theme.card, borderWidth: StyleSheet.hairlineWidth, borderColor: Theme.borderLight, marginBottom: Spacing.lg, gap: Spacing.md },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  cardName: { flex: 1, fontSize: 14, fontWeight: '700', color: Theme.text },
  soFar: { fontSize: 11, fontWeight: '600', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6, borderWidth: 1, overflow: 'hidden' },
  hero: { gap: 2 },
  heroValue: { fontSize: 56, fontWeight: '700', color: Theme.text, lineHeight: 60, letterSpacing: -2, fontVariant: ['tabular-nums'] },
  figures: { flexDirection: 'row', gap: Spacing.md },
  figure: { flex: 1, minWidth: 0, gap: 2 },
  figValue: { fontSize: 24, fontWeight: '700', color: Theme.text, fontVariant: ['tabular-nums'] },
  figValueSmall: { fontSize: 16, fontWeight: '700', color: Theme.text, fontVariant: ['tabular-nums'] },
  figLabel: { fontSize: 11.5, color: Theme.textMuted },
  machines: { fontSize: 12, color: Theme.textMuted0, marginTop: 6 },
  bars: { flexDirection: 'row', alignItems: 'flex-end', gap: 6, height: 130, paddingTop: 8 },
  barCol: { flex: 1, alignItems: 'center', justifyContent: 'flex-end', gap: 4 },
  bar: { width: '100%', borderRadius: 4 },
  barHours: { fontSize: 10, color: Theme.textMuted0, fontVariant: ['tabular-nums'] },
  barDay: { fontSize: 11, color: Theme.textMuted },
  cardRule: { paddingTop: Spacing.md, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: Theme.borderLight },
  shareBar: { flexDirection: 'row', height: 8, borderRadius: 4, overflow: 'hidden', backgroundColor: Theme.bgHighlight },
  legend: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 14, rowGap: 6, marginTop: 10 },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  legendName: { fontSize: 12.5, color: Theme.text },
  legendPct: { fontSize: 12.5, color: Theme.textMuted0, fontVariant: ['tabular-nums'] },
  options: { borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, borderColor: Theme.borderLight, backgroundColor: Theme.card, overflow: 'hidden', marginBottom: Spacing.lg },
  optionRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: Spacing.md, minHeight: 46 },
  optionLabel: { flex: 1, fontSize: 14, color: Theme.text },
  rule: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: Theme.borderLight },
  link: { flex: 1, fontSize: 12.5 },
}));
