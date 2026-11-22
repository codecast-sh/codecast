// One recording's screen, the phone twin of the web's /ops/replays/<rp-N>:
// who it was and where, what broke (its issues), the timeline of what they
// did on the replay's clock, and the page itself in the player when the
// recording kept a capture. Addressed by rp-N, rp-N@1:23 (a moment, which the
// timeline marks and the player opens at) or the row's _id.
//
// The row and its text timeline are store rows (useSyncOpsReplay feeds both),
// so a cached recording paints at once. The player is replay.codecast.sh, its
// own origin, in the WebView the app loads optionally; a binary without it
// reads the timeline alone. A tap on a timeline row opens the player there.
import { useMemo, useRef, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, TouchableOpacity, View as RNView, useWindowDimensions } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import { useConvex } from 'convex/react';
import { api } from '@codecast/convex/convex/_generated/api';
import { parseReplayRef, replayRefId, replayRefStart } from '@codecast/shared/entities';
import { REPLAY_PLAYER_ORIGIN, type ReplayPlayerLink } from '@codecast/shared/contracts/replayPlayer';
import { activeMsOf, envLine, formatReplayTime, isAnonymous, personKey, personLabel, routeOf, urlPath } from '@codecast/shared/replay';
import { Text as RNText } from '@/components/Themed';
import { Spacing, themedStyles, useTheme } from '@/constants/Theme';
import { Mono, uiFace } from '@/constants/fonts';
import { optionalNative } from '@/lib/optionalNative';
import { openWebPage, WEB_ORIGIN } from '@/lib/links';
import { ObjectHeader, ObjectMissing, SectionLabel, FactChip, objectStyles } from '@/components/objects/ObjectParts';
import { GroupRefRow, GroupRow, ReplayRow, Vital, ago, clock, opsStyles } from '@/components/ops/OpsRows';
import { parseReplayTimeline, rowAt, type TimelineKind, type TimelineRow } from '@/lib/replayTimeline';
import { useCoarseNow } from '@codecast/web/hooks/useCoarseNow';
import { detailGone, useOpsGroups, useOpsReplay, useOpsReplays, useOpsReplayTimeline, useSyncOpsReplay, useSyncOpsReplays } from '@codecast/web/hooks/useSyncOps';
import type { OpsReplay } from '@codecast/web/components/ops/opsTypes';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const WebViewComp: any = optionalNative('RNCWebViewModule', () => require('react-native-webview').WebView);

type IconName = React.ComponentProps<typeof FontAwesome>['name'];

export default function ReplayScreen() {
  const { id: rawId, t: rawT } = useLocalSearchParams<{ id: string; t?: string }>();
  const ref = useMemo(() => parseReplayRef(rawId), [rawId]);
  const lookup = ref?.replay ?? rawId?.trim() ?? null;
  const askedT = replayRefStart(ref) ?? (rawT && /^\d+$/.test(rawT) ? Number(rawT) : null);

  const feed = useSyncOpsReplay(lookup);
  useSyncOpsReplays();
  const replay = useOpsReplay(lookup);
  const timeline = useOpsReplayTimeline(replay?._id);
  const now = useCoarseNow(60_000);

  if (!replay) {
    return <ObjectMissing what="Recording" id={lookup ?? undefined} loading={!detailGone(feed) && !feed.error} />;
  }
  return <ReplayBody replay={replay} timeline={timeline} askedT={askedT} now={now} />;
}

function ReplayBody({ replay, timeline, askedT, now }: { replay: OpsReplay; timeline: ReturnType<typeof useOpsReplayTimeline>; askedT: number | null; now: number }) {
  const Theme = useTheme();
  const convex = useConvex();
  const scroller = useRef<ScrollView>(null);
  const timelineTop = useRef(0);
  const rowY = useRef(new Map<number, number>());
  const scrolled = useRef(false);

  const rows = useMemo(() => parseReplayTimeline(timeline?.timeline_md), [timeline?.timeline_md]);
  const [focusT, setFocusT] = useState<number | null>(askedT);
  const focusIdx = focusT !== null ? rowAt(rows, focusT) : -1;
  const [failuresOnly, setFailuresOnly] = useState(false);
  const [outlines, setOutlines] = useState(false);

  const canPlay = !!WebViewComp && (replay.dom_chunks ?? 0) > 0;
  const [player, setPlayer] = useState<{ state: 'idle' } | { state: 'minting' } | { state: 'ready'; url: string } | { state: 'failed'; error: string }>({ state: 'idle' });
  const play = (t: number | null) => {
    setPlayer({ state: 'minting' });
    convex
      .action((api as any).replays.playerLink, { replay: replay._id, ...(t !== null ? { t_ms: Math.max(0, t - 1000) } : {}), controls: true, autoplay: true })
      .then((link: ReplayPlayerLink) => setPlayer(link.player_url ? { state: 'ready', url: link.player_url } : { state: 'failed', error: 'This recording kept no page capture.' }))
      .catch((e: unknown) => setPlayer({ state: 'failed', error: e instanceof Error ? e.message : String(e) }));
  };

  const groups = useOpsGroups();
  const issues = useMemo(() => {
    const byId = new Map(groups.map((g) => [g._id, g]));
    const named = new Map((timeline?.groups ?? []).map((g) => [g._id, g]));
    return replay.group_ids.map((id) => ({ id, row: byId.get(id), ref: named.get(id) })).filter((x) => x.row || x.ref);
  }, [groups, timeline?.groups, replay.group_ids]);

  const who = personKey(replay.user);
  const all = useOpsReplays();
  const theirs = useMemo(() => (who ? all.filter((r) => r._id !== replay._id && personKey(r.user) === who).slice(0, 5) : []), [all, who, replay._id]);

  const path = replay.url ? routeOf(urlPath(replay.url)) : null;
  const active = activeMsOf(replay);
  const env = envLine(replay.facts);
  const pages = replay.shape?.pages;
  const shortId = replay.short_id;
  const momentRef = askedT !== null ? replayRefId(shortId, askedT) : shortId;
  const failures = rows.filter((r) => r.kind === 'error' || r.kind === 'request').length;
  const hiddenOutlines = rows.filter((r) => r.kind === 'view').length;
  const shown = rows.map((r, i) => ({ r, i })).filter(({ r, i }) => i === focusIdx || (failuresOnly ? r.kind === 'error' || r.kind === 'request' : outlines || r.kind !== 'view'));

  const onRowLayout = (i: number, y: number) => {
    rowY.current.set(i, y);
    if (!scrolled.current && i === focusIdx && askedT !== null) {
      scrolled.current = true;
      requestAnimationFrame(() => scroller.current?.scrollTo({ y: Math.max(0, timelineTop.current + y - 160), animated: false }));
    }
  };
  const pick = (r: TimelineRow) => {
    if (r.t === null) return;
    setFocusT(r.t);
    if (canPlay) play(r.t);
  };

  return (
    <>
      <ObjectHeader
        type="replay"
        shortId={shortId}
        refId={momentRef}
        title={personLabel(replay.user)}
        menu={[{ label: 'Open on the web', onPress: () => { void openWebPage(`${WEB_ORIGIN}/ops/replays/${shortId}${askedT !== null ? `?t=${Math.round(askedT / 1000)}` : ''}`); } }]}
      />
      <ScrollView ref={scroller} style={objectStyles.container} contentContainerStyle={objectStyles.content}>
        <RNText style={styles.person} numberOfLines={1} selectable>
          {isAnonymous(replay.user) && !who ? 'Anonymous' : personLabel(replay.user)}
        </RNText>
        <RNText style={styles.path} numberOfLines={2} selectable>{path ? `on ${path}` : 'no page recorded'}</RNText>

        <RNView style={objectStyles.chips}>
          <FactChip icon="plug" label={replay.source_name ?? replay.provider} color={Theme.cyan} />
          {replay.counts.errors > 0 && <FactChip icon="times-circle" label={`${replay.counts.errors} ${replay.counts.errors === 1 ? 'error' : 'errors'}`} color={Theme.red} />}
          {replay.counts.failed_requests > 0 && <FactChip icon="exchange" label={`${replay.counts.failed_requests} failed`} color={Theme.orange} />}
          <FactChip icon="hand-pointer-o" label={`${replay.counts.clicks} ${replay.counts.clicks === 1 ? 'click' : 'clicks'}`} color={Theme.textMuted} />
          {env ? <FactChip icon="desktop" label={env} color={Theme.textMuted} /> : null}
        </RNView>

        <RNView style={opsStyles.vitals}>
          <Vital label="Started" value={ago(replay.started_at, now)} sub={new Date(replay.started_at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} />
          <Vital label="Length" value={replay.duration_ms ? clock(replay.duration_ms) : 'unknown'} sub={active !== undefined ? `${clock(active)} active` : pages ? `${pages} ${pages === 1 ? 'page' : 'pages'}` : null} />
        </RNView>

        <Player
          canPlay={canPlay}
          hasCapture={(replay.dom_chunks ?? 0) > 0}
          state={player}
          from={focusT}
          onPlay={() => play(focusT)}
        />

        {issues.length > 0 && (
          <RNView style={objectStyles.section}>
            <SectionLabel>{`Issues · ${issues.length}`}</SectionLabel>
            <RNView style={opsStyles.card}>
              {issues.map((x, i) => (x.row ? <GroupRow key={x.id} g={x.row} now={now} first={i === 0} /> : <GroupRefRow key={x.id} g={x.ref!} first={i === 0} />))}
            </RNView>
          </RNView>
        )}

        <RNView style={objectStyles.section} onLayout={(e) => { timelineTop.current = e.nativeEvent.layout.y; }}>
          <SectionLabel
            right={rows.length > 0 ? (
              <RNView style={styles.toggles}>
                {failures > 0 && <Toggle label={`Failures ${failures}`} on={failuresOnly} onPress={() => setFailuresOnly((v) => !v)} />}
                {hiddenOutlines > 0 && !failuresOnly && <Toggle label="Outlines" on={outlines} onPress={() => setOutlines((v) => !v)} />}
              </RNView>
            ) : undefined}
          >
            Timeline
          </SectionLabel>
          <RNView style={opsStyles.card}>
            {rows.length === 0 ? (
              <RNText style={opsStyles.empty}>{replay.chunks === 0 ? 'Nothing recorded yet.' : timeline ? 'No text timeline yet.' : 'Reading the timeline…'}</RNText>
            ) : (
              shown.map(({ r, i }, n) => (
                <TimelineLine key={i} row={r} first={n === 0} focused={i === focusIdx} tappable={r.t !== null} onPress={() => pick(r)} onLayout={(y) => onRowLayout(i, y)} />
              ))
            )}
          </RNView>
        </RNView>

        {theirs.length > 0 && (
          <RNView style={objectStyles.section}>
            <SectionLabel>{`More from ${personLabel(replay.user)}`}</SectionLabel>
            <RNView style={opsStyles.card}>
              {theirs.map((r, i) => <ReplayRow key={r._id} r={r} now={now} first={i === 0} showPerson={false} />)}
            </RNView>
          </RNView>
        )}
      </ScrollView>
    </>
  );
}

function Player({ canPlay, hasCapture, state, from, onPlay }: { canPlay: boolean; hasCapture: boolean; state: { state: string; url?: string; error?: string }; from: number | null; onPlay: () => void }) {
  const Theme = useTheme();
  const { width } = useWindowDimensions();
  if (!hasCapture) return null;
  if (state.state === 'ready' && state.url && WebViewComp) {
    const w = width - Spacing.lg * 2;
    return (
      <RNView style={[styles.player, { height: Math.round(w * 0.66) + 48 }]} testID="replay-player">
        <WebViewComp
          key={state.url}
          source={{ uri: state.url }}
          originWhitelist={[REPLAY_PLAYER_ORIGIN]}
          onShouldStartLoadWithRequest={(req: { url: string; isTopFrame?: boolean }) => req.isTopFrame === false || req.url.startsWith(REPLAY_PLAYER_ORIGIN)}
          javaScriptEnabled
          allowsInlineMediaPlayback
          setSupportMultipleWindows={false}
          style={{ backgroundColor: Theme.bgAlt }}
        />
      </RNView>
    );
  }
  if (!canPlay) return null;
  return (
    <TouchableOpacity style={styles.poster} onPress={onPlay} activeOpacity={0.7} disabled={state.state === 'minting'} testID="replay-play">
      {state.state === 'minting' ? <ActivityIndicator size="small" color={Theme.cyan} /> : <FontAwesome name="play" size={16} color={Theme.cyan} />}
      <RNText style={styles.posterText}>{from !== null ? `Play from ${clock(from)}` : 'Play recording'}</RNText>
      {state.state === 'failed' ? <RNText style={styles.posterErr} numberOfLines={2}>{state.error}</RNText> : null}
    </TouchableOpacity>
  );
}

function Toggle({ label, on, onPress }: { label: string; on: boolean; onPress: () => void }) {
  const Theme = useTheme();
  return (
    <TouchableOpacity onPress={onPress} hitSlop={6} style={[styles.toggle, on && { borderColor: Theme.accent, backgroundColor: Theme.accent + '1a' }]}>
      <RNText style={[styles.toggleText, on && { color: Theme.accent }]}>{label}</RNText>
    </TouchableOpacity>
  );
}

const KIND_LOOK: Record<TimelineKind, { icon: IconName; tone: 'red' | 'orange' | 'yellow' | 'cyan' | 'muted' | 'dim' }> = {
  nav: { icon: 'location-arrow', tone: 'cyan' },
  click: { icon: 'hand-pointer-o', tone: 'muted' },
  input: { icon: 'i-cursor', tone: 'muted' },
  key: { icon: 'keyboard-o', tone: 'muted' },
  scroll: { icon: 'arrows-v', tone: 'dim' },
  view: { icon: 'eye', tone: 'dim' },
  error: { icon: 'times-circle', tone: 'red' },
  request: { icon: 'exchange', tone: 'orange' },
  warn: { icon: 'exclamation-triangle', tone: 'yellow' },
  mark: { icon: 'flag', tone: 'muted' },
  gap: { icon: 'ellipsis-h', tone: 'dim' },
  other: { icon: 'circle-o', tone: 'dim' },
};

function TimelineLine({ row, first, focused, tappable, onPress, onLayout }: { row: TimelineRow; first: boolean; focused: boolean; tappable: boolean; onPress: () => void; onLayout: (y: number) => void }) {
  const Theme = useTheme();
  const look = KIND_LOOK[row.kind];
  const color = look.tone === 'red' ? Theme.red : look.tone === 'orange' ? Theme.orange : look.tone === 'yellow' ? Theme.yellow : look.tone === 'cyan' ? Theme.cyan : look.tone === 'muted' ? Theme.textMuted : Theme.textMuted0;
  const loud = row.kind === 'error' || row.kind === 'request';
  return (
    <TouchableOpacity
      disabled={!tappable}
      onPress={onPress}
      activeOpacity={0.6}
      onLayout={(e) => onLayout(e.nativeEvent.layout.y)}
      style={[styles.line, !first && styles.rule, loud && { backgroundColor: color + '0d' }, focused && { backgroundColor: Theme.accent + '22', borderLeftColor: Theme.accent }]}
      testID={focused ? 'replay-focused-row' : undefined}
    >
      <RNText style={[styles.at, focused && { color: Theme.accent }]}>{row.t !== null ? formatReplayTime(row.t) : ''}</RNText>
      <FontAwesome name={look.icon} size={12} color={color} style={styles.lineIcon} />
      <RNView style={styles.lineBody}>
        <RNText style={[styles.lineText, { color: loud ? color : row.kind === 'view' || row.kind === 'scroll' || row.kind === 'gap' ? Theme.textMuted0 : Theme.text }, row.kind === 'nav' && styles.mono]} numberOfLines={row.kind === 'view' ? 2 : loud ? 6 : 3}>
          {row.text}
        </RNText>
        {row.detail.length > 0 && <RNText style={styles.detail} numberOfLines={4}>{row.detail.join('\n')}</RNText>}
      </RNView>
    </TouchableOpacity>
  );
}

const styles = themedStyles((Theme) => StyleSheet.create({
  person: { fontSize: 20, lineHeight: 26, fontWeight: '700', color: Theme.text },
  path: { marginTop: 2, marginBottom: Spacing.md, fontSize: 13, lineHeight: 18, color: Theme.textMuted, fontFamily: uiFace(Mono.regular) },
  player: { marginBottom: Spacing.xl, borderRadius: 10, overflow: 'hidden', borderWidth: StyleSheet.hairlineWidth, borderColor: Theme.borderLight },
  poster: { marginBottom: Spacing.xl, minHeight: 64, borderRadius: 10, borderWidth: 1, borderColor: Theme.cyan + '55', backgroundColor: Theme.cyan + '12', alignItems: 'center', justifyContent: 'center', flexDirection: 'row', flexWrap: 'wrap', gap: 10, padding: 14 },
  posterText: { fontSize: 14, fontWeight: '600', color: Theme.cyan },
  posterErr: { flexBasis: '100%', textAlign: 'center', fontSize: 12, color: Theme.orange },
  toggles: { flexDirection: 'row', gap: 6 },
  toggle: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999, borderWidth: 1, borderColor: Theme.borderLight },
  toggleText: { fontSize: 11.5, fontWeight: '600', color: Theme.textMuted },
  line: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, paddingHorizontal: 10, paddingVertical: 8, borderLeftWidth: 3, borderLeftColor: 'transparent' },
  rule: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: Theme.borderLight },
  at: { width: 50, fontSize: 11.5, lineHeight: 18, color: Theme.textMuted0, fontFamily: uiFace(Mono.regular), fontVariant: ['tabular-nums'] },
  lineIcon: { width: 14, textAlign: 'center', marginTop: 3 },
  lineBody: { flex: 1, minWidth: 0 },
  lineText: { fontSize: 13, lineHeight: 18 },
  detail: { marginTop: 3, fontSize: 11.5, lineHeight: 16, color: Theme.textMuted0, fontFamily: uiFace(Mono.regular) },
  mono: { fontFamily: uiFace(Mono.regular) },
}));
