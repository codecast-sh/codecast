// The flow around anything a run made, drawn from the web's model
// (web lib/flowContext): where the work came from (the session and the task),
// the flow's name, every station the run reached with its state, where the run
// stands, which station the viewer is on, arrows to the station before and
// after, the stations still ahead, and the task's other runs a flip away. A
// station with a session or a decision opens its screen; one without opens in
// place under the strip. Mounted on a station's session, a gate's decision and
// a task, the phone's twin of the web's components/FlowContext.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View as RNView } from 'react-native';
import { useRouter } from 'expo-router';
import Feather from '@expo/vector-icons/Feather';
import { Text as RNText } from '@/components/Themed';
import { CHROME_FONT_CAP, useTheme } from '@/constants/Theme';
import { codeFont } from '@/constants/fonts';
import { useTaskRuns } from '@codecast/web/hooks/useSyncRuns';
import { mobileRouteForUrl } from '@/lib/linkRoutes';
import { openAppRoute } from '@/lib/links';
import { flowName } from '@codecast/shared/contracts/flowPool';
import { useRunWorkflow, useSessionRun, useWorkflowRun } from '@codecast/web/hooks/useSyncWorkflows';
import { flowContext, flowOrigin, runStanding, stepTarget, type FlowFocus, type FlowOrigin, type FlowStation, type StationState } from '@codecast/web/lib/flowContext';
import { formatRunDuration } from '@codecast/web/lib/workflowRun';
import { useCoarseNow } from '@codecast/web/hooks/useCoarseNow';
import { useInboxStore } from '@codecast/web/store/inboxStore';
import { runHref } from '@codecast/web/lib/decisionLinks';

type FeatherName = React.ComponentProps<typeof Feather>['name'];
type Tone = 'green' | 'red' | 'cyan' | 'orange' | 'textDim';

const MARK: Record<StationState, { icon: FeatherName; tone: Tone }> = {
  done: { icon: 'check-circle', tone: 'green' },
  failed: { icon: 'x-circle', tone: 'red' },
  live: { icon: 'loader', tone: 'cyan' },
  waiting: { icon: 'pause-circle', tone: 'orange' },
  next: { icon: 'circle', tone: 'textDim' },
};


/** Open a web-shaped href (`/conversation/<id>`, `/decisions/<sd-N>`, a run) on its native screen; never a web page. */
function useOpenHref() {
  const router = useRouter();
  return (href: string | undefined) => {
    const route = href ? mobileRouteForUrl(href) : null;
    if (route) openAppRoute(router, route);
  };
}

/** The strip for a run by id. Renders nothing for no run. */
export function FlowContext({ runId, focus, style }: { runId: string | null | undefined; focus?: FlowFocus; style?: object }) {
  const run = useWorkflowRun(runId);
  if (!run) return null;
  return <FlowContextOf run={run} focus={focus} style={style} />;
}

/** The strip on a session's screen: the run it works in, as its own run or as a station of its parent log's run.
 *  Asks the server only for a session that can be in one (it points at a run, or a parent spawned it). */
export function SessionFlowContext({ conversationId, ownRunId, parentId, style }: { conversationId: string; ownRunId?: string | null; parentId?: string | null; style?: object }) {
  const run = useSessionRun(ownRunId || parentId ? conversationId : null, ownRunId);
  if (!run) return null;
  return <FlowContextOf run={run} focus={{ conversationId }} style={style} />;
}

/** The strip for a run row the caller already holds. */
export function FlowContextOf({ run: given, focus: givenFocus, style }: { run: any; focus?: FlowFocus; style?: object }) {
  const Theme = useTheme();
  const open = useOpenHref();
  // Every run on the same task, oldest first: the strip flips between them in place.
  const taskRuns = useTaskRuns(given.task_id ?? null);
  const runs = useMemo(() => {
    const all = taskRuns.some((r: any) => r._id === given._id) ? taskRuns : [given, ...taskRuns];
    return [...all].sort((a: any, b: any) => (a.created_at ?? 0) - (b.created_at ?? 0));
  }, [taskRuns, given]);
  const [pickedId, setPickedId] = useState<string | null>(null);
  const run: any = runs.find((r: any) => r._id === pickedId) ?? given;
  const runIndex = runs.findIndex((r: any) => r._id === run._id);
  // The screen's own place in the flow applies only to the run the screen is about.
  const focus = run._id === given._id ? givenFocus : undefined;
  // The graph the run executes (its pinned version): its stations' names, and whether the flow changed under it.
  const graph = useRunWorkflow(run);
  const ctx = useMemo(() => flowContext(run, graph, focus), [run, graph, focus?.conversationId, focus?.decisionId, focus?.nodeId]);
  const originId: string | undefined = run.task_origin_conversation_id;
  const originTitle = useInboxStore((s) => (originId ? ((s.sessions as any)[originId]?.title ?? (s.conversations as any)[originId]?.title) : undefined) as string | undefined);
  const origin = useMemo(() => flowOrigin(run, originTitle), [run.task_short_id, run.task_title, originId, originTitle]);
  // A station that ran no session (a command, a check) opens here, under the strip; one that did opens its screen.
  const [peek, setPeek] = useState<number | null>(null);
  const [showAhead, setShowAhead] = useState(false);
  const here = peek ?? ctx.focus;

  const scroller = useRef<ScrollView>(null);
  const boxes = useRef(new Map<number, { x: number; w: number }>());
  const viewW = useRef(0);
  const scrollX = useRef(0);
  // Keep the station in view in view: scroll only when it sits off screen, then center it.
  const scrollToHere = () => {
    const f = boxes.current.get(here);
    const w = viewW.current;
    if (!f || !w) return;
    if (f.x >= scrollX.current && f.x + f.w <= scrollX.current + w) return;
    scroller.current?.scrollTo({ x: Math.max(0, f.x - (w - f.w) / 2), animated: false });
  };
  useEffect(scrollToHere, [here, ctx.stations.length]);
  if (!ctx.stations.length) return null;

  const name = flowName({ label: graph?.label ?? run.workflow_label, name: graph?.name ?? run.workflow_name }) || 'Flow';
  const prev = stepTarget(ctx, here, -1);
  const next = stepTarget(ctx, here, 1);
  const standing = runStanding(run, ctx);
  const pickRun = (i: number) => { const r: any = runs[i]; if (r) { setPeek(null); setPickedId(r._id === given._id ? null : r._id); } };
  // The viewer's own station closes what is open; another with a screen opens it; one without opens here (again: closes).
  const go = (i: number) => {
    const h = ctx.stations[i]?.href;
    if (i === ctx.focus && h) setPeek(null);
    else if (h) { setPeek(null); open(h); }
    else setPeek(peek === i ? null : i);
  };
  const shown = peek != null ? ctx.stations[peek] : null;

  return (
    <RNView style={[styles.box, { borderColor: Theme.border + '66', backgroundColor: Theme.bgAlt + '4d' }, style]} testID="flow-context" accessibilityLabel={`${name} flow`}>
      <RNView style={styles.head}>
        <Feather name="git-branch" size={13} color={Theme.violet} />
        <Pressable onPress={() => open(runHref(run._id))} hitSlop={8} style={styles.namePress} accessibilityRole="link" accessibilityLabel={`Open the ${name} run`} testID="flow-context-run">
          <RNText style={[styles.name, { color: Theme.violet }]} numberOfLines={1} maxFontSizeMultiplier={CHROME_FONT_CAP}>{name}</RNText>
        </Pressable>
        <RNText style={[styles.words, { color: Theme[MARK[standing.state].tone] }]} numberOfLines={1} maxFontSizeMultiplier={CHROME_FONT_CAP}>
          {standing.words}
        </RNText>
        {ctx.lineChanged ? (
          <RNText style={[styles.tag, { color: Theme.orange, borderColor: Theme.orange + '66' }]} maxFontSizeMultiplier={CHROME_FONT_CAP} testID="flow-context-changed">flow changed</RNText>
        ) : null}
        <RNView style={{ flex: 1 }} />
        <RNText style={[styles.count, { color: Theme.textDim }]} maxFontSizeMultiplier={CHROME_FONT_CAP}>{here + 1}/{ctx.stations.length}</RNText>
        <Arrow dir="prev" label={ctx.stations[prev] ? `Previous station: ${ctx.stations[prev].label}` : 'No earlier station'} enabled={prev >= 0} onPress={() => go(prev)} testID="flow-context-prev" />
        <Arrow dir="next" label={ctx.stations[next] ? `Next station: ${ctx.stations[next].label}` : 'No later station'} enabled={next >= 0} onPress={() => go(next)} testID="flow-context-next" />
      </RNView>
      {runs.length > 1 ? (
        <RNView style={styles.runs} testID="flow-context-runs">
          <Arrow dir="prev" small label="Earlier run" enabled={runIndex > 0} onPress={() => pickRun(runIndex - 1)} testID="flow-context-run-earlier" />
          <RNText style={[styles.count, { color: Theme.textMuted }]} maxFontSizeMultiplier={CHROME_FONT_CAP}>run {runIndex + 1}/{runs.length}</RNText>
          <Arrow dir="next" small label="Later run" enabled={runIndex < runs.length - 1} onPress={() => pickRun(runIndex + 1)} testID="flow-context-run-later" />
        </RNView>
      ) : null}
      <ScrollView
        ref={scroller}
        onLayout={(e) => { viewW.current = e.nativeEvent.layout.width; scrollToHere(); }}
        onScroll={(e) => { scrollX.current = e.nativeEvent.contentOffset.x; }}
        scrollEventThrottle={64}
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.row}
      >
        {origin.map((o) => (
          <RNView key={o.key} style={styles.cell} testID={`flow-origin-${o.key}`}>
            <OriginChip o={o} onPress={() => open(o.href)} />
            <RNView style={[styles.joint, { backgroundColor: Theme.border + '99' }]} />
          </RNView>
        ))}
        {ctx.stations.map((s, i) => (
          <RNView
            key={`${s.id}:${i}`}
            style={styles.cell}
            onLayout={(e) => { const { x, width } = e.nativeEvent.layout; boxes.current.set(i, { x, w: width }); if (i === here) scrollToHere(); }}
          >
            {i > 0 ? <RNView style={[styles.joint, { backgroundColor: Theme.border }]} /> : null}
            <StationChip s={s} here={i === here} onPress={() => go(i)} />
          </RNView>
        ))}
        {ctx.ahead.length > 0 ? (
          <RNView style={styles.cell}>
            <RNView style={[styles.joint, { backgroundColor: Theme.border + '66' }]} />
            {showAhead ? ctx.ahead.map((s, i) => (
              <RNView key={`${s.id}:ahead:${i}`} style={styles.cell} testID={`flow-ahead-${s.id}`}>
                {i > 0 ? <RNView style={[styles.joint, { backgroundColor: Theme.border + '4d' }]} /> : null}
                <RNView style={[styles.chip, { borderColor: 'transparent', opacity: 0.55 }]} accessibilityLabel={`${s.label}, not reached yet`}>
                  <Feather name="circle" size={12} color={Theme.textDim} />
                  <RNText style={[styles.chipText, { color: Theme.textDim }]} numberOfLines={1} maxFontSizeMultiplier={CHROME_FONT_CAP}>{s.label}</RNText>
                </RNView>
              </RNView>
            )) : null}
            <Pressable onPress={() => setShowAhead((v) => !v)} hitSlop={6} style={({ pressed }) => [styles.ahead, { borderColor: Theme.border + '99' }, pressed && { opacity: 0.6 }]} accessibilityRole="button" accessibilityState={{ expanded: showAhead }} testID="flow-context-ahead">
              <RNText style={[styles.chipText, { color: Theme.textMuted }]} maxFontSizeMultiplier={CHROME_FONT_CAP}>{showAhead ? 'hide ahead' : `${ctx.ahead.length} ahead`}</RNText>
            </Pressable>
          </RNView>
        ) : null}
      </ScrollView>
      {shown ? <StationPeek s={shown} onClose={() => setPeek(null)} /> : null}
    </RNView>
  );
}

function OriginChip({ o, onPress }: { o: FlowOrigin; onPress: () => void }) {
  const Theme = useTheme();
  return (
    <Pressable
      onPress={onPress}
      hitSlop={4}
      style={({ pressed }) => [styles.chip, styles.origin, { borderColor: Theme.border + 'aa' }, pressed && { opacity: 0.6 }]}
      accessibilityRole="link"
      accessibilityLabel={o.key === 'session' ? `Where it started: ${o.label}` : `${o.ref}: ${o.label}`}
    >
      <Feather name={o.key === 'session' ? 'message-square' : 'check-square'} size={11} color={Theme.textDim} />
      <RNText style={[styles.chipText, o.ref ? codeFont : null, { color: Theme.textMuted }]} numberOfLines={1} maxFontSizeMultiplier={CHROME_FONT_CAP}>{o.ref ?? o.label}</RNText>
    </Pressable>
  );
}

function StationChip({ s, here, onPress }: { s: FlowStation; here: boolean; onPress: () => void }) {
  const Theme = useTheme();
  const m = MARK[s.state];
  const color = Theme[m.tone];
  const icon: FeatherName = s.current && s.state !== 'waiting' ? 'target' : m.icon;
  const opens = s.href ? (s.href.startsWith('/decisions') ? 'open the decision' : 'open its session') : 'show what it did';
  const label = [s.segment && s.segment !== s.label ? `${s.segment}, ${s.label}` : s.label, s.current ? 'the run is here' : null, opens].filter(Boolean).join(', ');
  const chipStyle = [styles.chip, here ? { borderColor: color + '66', backgroundColor: color + '1a' } : { borderColor: 'transparent' }];
  return (
    <Pressable
      onPress={onPress}
      hitSlop={4}
      style={({ pressed }) => [chipStyle, pressed && { opacity: 0.6 }]}
      accessibilityRole={s.href ? 'link' : 'button'}
      accessibilityLabel={label}
      accessibilityState={{ selected: here }}
      testID={`flow-station-${s.id}`}
    >
      <Feather name={icon} size={12} color={color} />
      <RNText style={[styles.chipText, { color: here ? Theme.text : Theme.textMuted, fontWeight: here ? '600' : '400' }]} numberOfLines={1} maxFontSizeMultiplier={CHROME_FONT_CAP}>
        {s.label}
      </RNText>
    </Pressable>
  );
}

/** A station that ran no session, read in place: its verdict, how long it took, when, and what it printed. */
function StationPeek({ s, onClose }: { s: FlowStation; onClose: () => void }) {
  const Theme = useTheme();
  const now = useCoarseNow(30_000);
  const took = s.started_at ? formatRunDuration(s.started_at, s.completed_at, now) : null;
  const when = s.started_at ? new Date(s.started_at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : null;
  return (
    <RNView style={[styles.peek, { borderColor: Theme.border + '80', backgroundColor: Theme.bg }]} testID={`flow-peek-${s.id}`}>
      <RNView style={styles.peekHead}>
        <RNText style={[styles.name, { color: Theme[MARK[s.state].tone] }]} numberOfLines={1} maxFontSizeMultiplier={CHROME_FONT_CAP}>{s.label}</RNText>
        {s.segment && s.segment !== s.label ? <RNText style={[styles.meta, { color: Theme.textDim }]} maxFontSizeMultiplier={CHROME_FONT_CAP}>{s.segment}</RNText> : null}
        {s.outcome ? <RNText style={[styles.meta, styles.outcome, { color: Theme.textMuted, backgroundColor: Theme.bgAlt }]} maxFontSizeMultiplier={CHROME_FONT_CAP}>{s.outcome}</RNText> : null}
        {took ? <RNText style={[styles.meta, { color: Theme.textDim }]} maxFontSizeMultiplier={CHROME_FONT_CAP}>{took}</RNText> : null}
        {when ? <RNText style={[styles.meta, { color: Theme.textDim }]} numberOfLines={1} maxFontSizeMultiplier={CHROME_FONT_CAP}>{when}</RNText> : null}
        <RNView style={{ flex: 1 }} />
        <Pressable onPress={onClose} hitSlop={10} accessibilityRole="button" accessibilityLabel="Close" testID="flow-peek-close">
          <Feather name="x" size={14} color={Theme.textDim} />
        </Pressable>
      </RNView>
      {s.output ? (
        <ScrollView style={styles.output} nestedScrollEnabled>
          <RNText style={[styles.outputText, codeFont, { color: Theme.textMuted }]} selectable maxFontSizeMultiplier={CHROME_FONT_CAP}>{s.output}</RNText>
        </ScrollView>
      ) : (
        <RNText style={[styles.meta, { color: Theme.textDim, paddingHorizontal: 8, paddingBottom: 8 }]} maxFontSizeMultiplier={CHROME_FONT_CAP}>{s.state === 'next' ? 'Not reached yet' : 'Printed nothing'}</RNText>
      )}
    </RNView>
  );
}

function Arrow({ dir, label, enabled, small, onPress, testID }: { dir: 'prev' | 'next'; label: string; enabled: boolean; small?: boolean; onPress: () => void; testID?: string }) {
  const Theme = useTheme();
  return (
    <Pressable onPress={onPress} disabled={!enabled} hitSlop={6} style={({ pressed }) => [styles.step, { opacity: !enabled ? 0.3 : pressed ? 0.6 : 1 }]} accessibilityRole="button" accessibilityLabel={label} testID={testID}>
      <Feather name={dir === 'prev' ? 'chevron-left' : 'chevron-right'} size={small ? 13 : 16} color={Theme.textMuted} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  box: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, paddingTop: 6 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 10 },
  runs: { flexDirection: 'row', alignItems: 'center', gap: 2, paddingHorizontal: 6, paddingTop: 2 },
  namePress: { flexShrink: 1 },
  name: { fontSize: 12.5, fontWeight: '600' },
  words: { fontSize: 12, flexShrink: 1 },
  tag: { fontSize: 10.5, borderWidth: StyleSheet.hairlineWidth, borderRadius: 4, paddingHorizontal: 4, paddingVertical: 1 },
  count: { fontSize: 11.5, fontVariant: ['tabular-nums'], marginRight: 2 },
  step: { paddingHorizontal: 3, paddingVertical: 2 },
  row: { alignItems: 'center', paddingHorizontal: 8, paddingTop: 4, paddingBottom: 6 },
  cell: { flexDirection: 'row', alignItems: 'center' },
  joint: { width: 8, height: StyleSheet.hairlineWidth },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 7, paddingVertical: 4, borderRadius: 7, borderWidth: StyleSheet.hairlineWidth },
  origin: { borderStyle: 'dashed', maxWidth: 180 },
  chipText: { fontSize: 12.5, flexShrink: 1 },
  ahead: { marginLeft: 4, paddingHorizontal: 7, paddingVertical: 4, borderRadius: 7, borderWidth: StyleSheet.hairlineWidth, borderStyle: 'dashed' },
  peek: { marginHorizontal: 8, marginBottom: 8, borderRadius: 8, borderWidth: StyleSheet.hairlineWidth },
  peekHead: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6, paddingHorizontal: 8, paddingVertical: 6 },
  meta: { fontSize: 11.5, fontVariant: ['tabular-nums'] },
  outcome: { paddingHorizontal: 4, borderRadius: 4, overflow: 'hidden' },
  output: { maxHeight: 240, paddingHorizontal: 8, paddingBottom: 8 },
  outputText: { fontSize: 11.5, lineHeight: 16 },
});
