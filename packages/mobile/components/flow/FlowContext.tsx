// The flow around anything a run made, drawn from the web's model
// (web lib/flowContext): the flow's name, every station in order with its
// state, where the run stands, which station the viewer is on, arrows to the
// station before and after, and one tap to open any station. Mounted on a
// station's session, a gate's decision and a task, the phone's twin of the
// web's components/FlowContext.

import React, { useEffect, useMemo, useRef } from 'react';
import { Pressable, ScrollView, StyleSheet, View as RNView } from 'react-native';
import { useRouter } from 'expo-router';
import Feather from '@expo/vector-icons/Feather';
import { Text as RNText } from '@/components/Themed';
import { CHROME_FONT_CAP, useTheme } from '@/constants/Theme';
import { mobileRouteForUrl } from '@/lib/linkRoutes';
import { openAppRoute } from '@/lib/links';
import { flowName } from '@codecast/shared/contracts/flowPool';
import { useRunGraph, useSessionRun, useWorkflowRun } from '@codecast/web/hooks/useSyncWorkflows';
import { flowContext, runStanding, stepTarget, type FlowFocus, type FlowStation, type StationState } from '@codecast/web/lib/flowContext';
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
export function FlowContextOf({ run, focus, style }: { run: any; focus?: FlowFocus; style?: object }) {
  const Theme = useTheme();
  const open = useOpenHref();
  const graph = useRunGraph(run._id, run.workflow_id);
  const ctx = useMemo(() => flowContext(run, graph, focus), [run, graph, focus?.conversationId, focus?.decisionId, focus?.nodeId]);
  const scroller = useRef<ScrollView>(null);
  const focusBox = useRef<{ x: number; w: number } | null>(null);
  const viewW = useRef(0);
  // Bring the focused station into view once it and the row have laid out, scrolling only when it would sit off screen.
  const scrollToFocus = () => {
    const f = focusBox.current;
    if (!f || !viewW.current) return;
    const overflow = f.x + f.w + 16 - viewW.current;
    scroller.current?.scrollTo({ x: Math.max(0, overflow), animated: false });
  };
  useEffect(scrollToFocus, [ctx.focus]);
  if (!ctx.stations.length) return null;

  const name = flowName({ label: graph?.label ?? run.workflow_label, name: graph?.name ?? run.workflow_name }) || 'Flow';
  const prev = stepTarget(ctx, ctx.focus, -1);
  const next = stepTarget(ctx, ctx.focus, 1);
  const standing = runStanding(run, ctx);
  const runTone = MARK[standing.state].tone;

  return (
    <RNView style={[styles.box, { borderColor: Theme.border + '66', backgroundColor: Theme.bgAlt + '4d' }, style]} testID="flow-context" accessibilityLabel={`${name} flow`}>
      <RNView style={styles.head}>
        <Feather name="git-branch" size={13} color={Theme.violet} />
        <Pressable onPress={() => open(runHref(run._id))} hitSlop={8} style={styles.namePress} accessibilityRole="link" accessibilityLabel={`Open the ${name} run`} testID="flow-context-run">
          <RNText style={[styles.name, { color: Theme.violet }]} numberOfLines={1} maxFontSizeMultiplier={CHROME_FONT_CAP}>{name}</RNText>
        </Pressable>
        <RNText style={[styles.words, { color: Theme[runTone] }]} numberOfLines={1} maxFontSizeMultiplier={CHROME_FONT_CAP}>
          {standing.words}
        </RNText>
        {ctx.lineChanged ? (
          <RNText style={[styles.tag, { color: Theme.orange, borderColor: Theme.orange + '66' }]} maxFontSizeMultiplier={CHROME_FONT_CAP} testID="flow-context-changed">flow changed</RNText>
        ) : null}
        <RNView style={{ flex: 1 }} />
        <RNText style={[styles.count, { color: Theme.textDim }]} maxFontSizeMultiplier={CHROME_FONT_CAP}>{ctx.focus + 1}/{ctx.stations.length}</RNText>
        <StepButton dir="prev" target={ctx.stations[prev]} onPress={() => open(ctx.stations[prev]?.href)} />
        <StepButton dir="next" target={ctx.stations[next]} onPress={() => open(ctx.stations[next]?.href)} />
      </RNView>
      <ScrollView ref={scroller} onLayout={(e) => { viewW.current = e.nativeEvent.layout.width; scrollToFocus(); }} horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row}>
        {ctx.stations.map((s, i) => (
          <RNView
            key={`${s.id}:${i}`}
            style={styles.cell}
            onLayout={i === ctx.focus ? (e) => { const { x, width } = e.nativeEvent.layout; focusBox.current = { x, w: width }; scrollToFocus(); } : undefined}
          >
            {i > 0 ? <RNView style={[styles.joint, { backgroundColor: Theme.border + (s.state === 'next' ? '66' : 'ff') }]} /> : null}
            <StationChip s={s} focused={i === ctx.focus} onPress={() => open(s.href)} />
          </RNView>
        ))}
      </ScrollView>
    </RNView>
  );
}

function StationChip({ s, focused, onPress }: { s: FlowStation; focused: boolean; onPress: () => void }) {
  const Theme = useTheme();
  const m = MARK[s.state];
  const color = Theme[m.tone];
  const icon: FeatherName = s.current && s.state !== 'waiting' ? 'target' : m.icon;
  const opens = s.href ? (s.href.startsWith('/decisions') ? 'open the decision' : 'open its session') : null;
  const label = [s.segment && s.segment !== s.label ? `${s.segment}, ${s.label}` : s.label, s.current ? 'the run is here' : null, opens].filter(Boolean).join(', ');
  const body = (
    <>
      <Feather name={icon} size={12} color={color} />
      <RNText
        style={[styles.chipText, { color: focused ? Theme.text : Theme.textMuted, fontWeight: focused ? '600' : '400' }]}
        numberOfLines={1}
        maxFontSizeMultiplier={CHROME_FONT_CAP}
      >
        {s.label}
      </RNText>
    </>
  );
  const chipStyle = [styles.chip, focused ? { borderColor: color + '66', backgroundColor: color + '1a' } : { borderColor: 'transparent' }];
  return s.href ? (
    <Pressable onPress={onPress} hitSlop={4} style={({ pressed }) => [chipStyle, pressed && { opacity: 0.6 }]} accessibilityRole="link" accessibilityLabel={label} accessibilityState={{ selected: focused }} testID={`flow-station-${s.id}`}>
      {body}
    </Pressable>
  ) : (
    <RNView style={chipStyle} accessibilityLabel={label} accessibilityState={{ selected: focused }} testID={`flow-station-${s.id}`}>{body}</RNView>
  );
}

function StepButton({ dir, target, onPress }: { dir: 'prev' | 'next'; target?: FlowStation; onPress: () => void }) {
  const Theme = useTheme();
  const label = target ? `${dir === 'prev' ? 'Previous' : 'Next'} station: ${target.label}` : dir === 'prev' ? 'No earlier station to open' : 'No later station to open';
  return (
    <Pressable onPress={onPress} disabled={!target} hitSlop={6} style={({ pressed }) => [styles.step, { opacity: !target ? 0.3 : pressed ? 0.6 : 1 }]} accessibilityRole="button" accessibilityLabel={label} testID={`flow-context-${dir}`}>
      <Feather name={dir === 'prev' ? 'chevron-left' : 'chevron-right'} size={16} color={Theme.textMuted} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  box: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, paddingTop: 6 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 10 },
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
  chipText: { fontSize: 12.5 },
});
