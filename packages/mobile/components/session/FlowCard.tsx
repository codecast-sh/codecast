// A flow of the pool, or one run of it, on the phone (docs/architecture/flows.md
// FL6): the same model the web draws (web lib/line/flowDiagram.ts), laid out
// down the screen. One row per step with who does it and, on a run, its state;
// a segment's or a fan-out's steps indented under its name; on a run only the
// route it took, red where it stopped; in a definition the routes off the path,
// neutral.
import React, { useMemo } from 'react';
import { Pressable, StyleSheet, View as RNView } from 'react-native';
import Feather from '@expo/vector-icons/Feather';
import { Text as RNText } from '@/components/Themed';
import { CHROME_FONT_CAP, useTheme } from '@/constants/Theme';
import { useWorkflowRun } from '@codecast/web/hooks/useSyncWorkflows';
import { useNamedFlow, useRunFlow, type FlowLibraryState } from '@codecast/web/hooks/useFlowObject';
import { useInboxStore } from '@codecast/web/store/inboxStore';
import { type AppFlow } from '@codecast/web/lib/line/flowPool';
import { flowDiagram, routeTail, runReached, stepStates, type DiagramStep, type SideRoute, type StepState } from '@codecast/web/lib/line/flowDiagram';
import { flowRunState, type FlowRunTone } from '@codecast/web/lib/line/flowFence';

type FeatherName = React.ComponentProps<typeof Feather>['name'];
type RunRow = Parameters<typeof stepStates>[1] & { _id: string; status: string; task_short_id?: string | null; fail_reason?: string | null; workflow_slug?: string; workflow_name?: string };

const WHO: Record<DiagramStep['kind'], { icon: FeatherName; word: string }> = {
  agent: { icon: 'cpu', word: 'agent' },
  script: { icon: 'terminal', word: 'command' },
  person: { icon: 'user', word: 'you' },
  call: { icon: 'zap', word: 'model' },
  segment: { icon: 'layers', word: 'segment' },
  parallel: { icon: 'columns', word: 'side by side' },
  join: { icon: 'git-merge', word: 'join' },
};

export function FlowCard({ slug }: { slug: string }) {
  const { flow, library } = useNamedFlow(slug);
  if (!flow) return null;
  return <FlowBody flow={flow} run={null} library={library} />;
}

export function FlowRunCard({ runId }: { runId: string }) {
  const run = useWorkflowRun(runId) as RunRow | null | undefined;
  const { flow, library } = useRunFlow(run);
  if (!run || !flow) return null;
  return <FlowBody flow={flow} run={run} library={library} />;
}

/** Save into the team's library, or the name it was saved under. */
function LibraryAction({ library }: { library: FlowLibraryState }) {
  const Theme = useTheme();
  if (!library || library.kind === 'library') return null;
  if (library.kind === 'saved') return <RNText style={[styles.task, { color: Theme.green }]} maxFontSizeMultiplier={CHROME_FONT_CAP}>Saved v{library.version}</RNText>;
  return (
    <Pressable onPress={() => useInboxStore.getState().saveSessionFlow(library.id, library.variantOf ? { variant_of: library.variantOf } : undefined)} hitSlop={8} style={[styles.save, { borderColor: Theme.blue }]}>
      <RNText style={[styles.saveText, { color: Theme.blue }]} maxFontSizeMultiplier={CHROME_FONT_CAP}>Save</RNText>
    </Pressable>
  );
}

function FlowBody({ flow, run, library }: { flow: AppFlow; run: RunRow | null; library: FlowLibraryState }) {
  const Theme = useTheme();
  const model = useMemo(() => flowDiagram(flow), [flow]);
  const states = useMemo(() => stepStates(model, run), [model, run]);
  const state = run ? flowRunState(run, flow) : null;
  const tone: Record<FlowRunTone, string> = { running: Theme.blue, waiting: Theme.yellow, passed: Theme.green, stopped: Theme.red, failed: Theme.red };
  const mark: Record<StepState, { icon: FeatherName | null; color: string }> = {
    idle: { icon: null, color: Theme.textDim },
    done: { icon: 'check', color: Theme.green },
    current: { icon: 'circle', color: Theme.blue },
    stopped: { icon: 'x', color: Theme.red },
  };

  const row = (s: DiagramStep, depth: number) => {
    const st = states.get(s.id) ?? 'idle';
    const m = mark[st];
    const routes = run ? s.side.filter((r) => runReached(run, r.toId)) : s.side;
    return (
      <RNView key={s.id} style={{ marginLeft: depth * 14, opacity: run && st === 'idle' ? 0.5 : 1 }}>
        <RNView style={styles.step}>
          <Feather name={WHO[s.kind].icon} size={13} color={Theme.textMuted} />
          <RNText style={[styles.stepName, { color: s.slot?.filled === 'empty' ? Theme.textMuted : Theme.text }]} maxFontSizeMultiplier={CHROME_FONT_CAP}>{s.label}</RNText>
          <RNText style={[styles.who, { color: s.slot?.filled === 'generated' ? Theme.violet : Theme.textMuted }]} maxFontSizeMultiplier={CHROME_FONT_CAP}>{s.slot?.filled === 'empty' ? 'slot' : s.slot?.filled === 'generated' ? 'written here' : WHO[s.kind].word}</RNText>
          {m.icon ? <Feather name={m.icon} size={12} color={m.color} /> : null}
        </RNView>
        {routes.map((r, i) => <Route key={i} r={r} stopped={!!run && r.tone === 'stop'} />)}
      </RNView>
    );
  };

  return (
    <RNView style={[styles.card, { borderColor: Theme.border, backgroundColor: Theme.bgAlt }]}>
      <RNView style={styles.head}>
        <RNText style={[styles.name, { color: Theme.text }]} numberOfLines={1} maxFontSizeMultiplier={CHROME_FONT_CAP}>{flow.label}</RNText>
        {flow.base ? <RNText style={[styles.task, { color: Theme.textMuted }]} numberOfLines={1} maxFontSizeMultiplier={CHROME_FONT_CAP}>on {flow.base}</RNText> : null}
        <RNView style={{ flex: 1 }} />
        {state ? <RNText style={[styles.state, { color: tone[state.tone] }]} maxFontSizeMultiplier={CHROME_FONT_CAP}>{state.words}</RNText> : null}
        {run?.task_short_id ? <RNText style={[styles.task, { color: Theme.textMuted }]} maxFontSizeMultiplier={CHROME_FONT_CAP}>{run.task_short_id}</RNText> : null}
        <LibraryAction library={library} />
      </RNView>
      <RNView style={styles.steps}>
        {model.steps.map((s) => (s.inner.length > 1 || s.kind === 'parallel' ? (
          <RNView key={s.id}>
            <RNText style={[styles.group, { color: Theme.text }]} maxFontSizeMultiplier={CHROME_FONT_CAP}>{s.label}<RNText style={{ color: s.slot?.filled === 'generated' ? Theme.violet : Theme.textMuted, fontWeight: '400' }}>{s.kind === 'parallel' ? `  ${s.inner.length} side by side` : `  ${s.inner.length} steps${s.slot?.filled === 'generated' ? ', written here' : ''}`}</RNText></RNText>
            {s.inner.map((i) => row(i, 1))}
            {(run ? s.side.filter((r) => runReached(run, r.toId)) : s.side).map((r, i) => <Route key={i} r={r} stopped={false} indent={14} />)}
          </RNView>
        ) : s.inner.length === 1 ? row({ ...s.inner[0], label: s.label, side: [...s.inner[0].side, ...s.side], slot: s.slot }, 0) : row(s, 0)))}
        {model.end ? (
          run && runReached(run, model.endId)
            ? <RNText style={[styles.end, { color: Theme.green }]} maxFontSizeMultiplier={CHROME_FONT_CAP}>✓ {model.end}</RNText>
            : <RNText style={[styles.end, { color: Theme.textMuted, fontWeight: '400' }]} maxFontSizeMultiplier={CHROME_FONT_CAP}>Ends at {model.end} when every step passes</RNText>
        ) : null}
      </RNView>
      {state?.why ? <RNText style={[styles.why, { color: Theme.textMuted }]} numberOfLines={4} maxFontSizeMultiplier={CHROME_FONT_CAP}>{state.why}</RNText> : null}
    </RNView>
  );
}

/** A route off the path: its outcome, then what it does (stops the run, ends here, back to or on to a step). */
function Route({ r, stopped, indent = 0 }: { r: SideRoute; stopped: boolean; indent?: number }) {
  const Theme = useTheme();
  return (
    <RNText style={[styles.route, { marginLeft: 20 + indent, color: stopped ? Theme.red : Theme.textMuted }]} maxFontSizeMultiplier={CHROME_FONT_CAP}>
      <RNText style={{ fontWeight: '600' }}>{r.outcome}</RNText> {routeTail(r)}
    </RNText>
  );
}

const styles = StyleSheet.create({
  card: { marginVertical: 6, borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, overflow: 'hidden' },
  head: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 10, paddingVertical: 8 },
  name: { fontSize: 13, fontWeight: '600', flexShrink: 1 },
  state: { fontSize: 11, fontWeight: '600' },
  task: { fontSize: 11 },
  steps: { paddingHorizontal: 12, paddingBottom: 10, gap: 10 },
  step: { flexDirection: 'row', alignItems: 'center', gap: 7, paddingVertical: 2 },
  stepName: { fontSize: 13, fontWeight: '600' },
  route: { fontSize: 12, marginTop: 2 },
  who: { fontSize: 11 },
  group: { fontSize: 13, fontWeight: '700', marginTop: 2, marginBottom: 4 },
  end: { fontSize: 12, fontWeight: '600', marginTop: 2 },
  why: { fontSize: 11, paddingHorizontal: 12, paddingBottom: 10 },
  save: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 2 },
  saveText: { fontSize: 11, fontWeight: '600' },
});
