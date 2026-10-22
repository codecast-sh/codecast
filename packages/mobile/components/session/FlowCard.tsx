// A flow of the pool, or one run of it, on the phone (docs/architecture/flows.md
// FL6): the same model the web draws (web lib/line/flowDiagram.ts), laid out
// down the screen. One row per step with who does it and, on a run, its state;
// a segment's or a fan-out's steps indented under its name; on a run only the
// route it took, red where it stopped; in a definition the routes off the path,
// neutral.
import React, { useMemo } from 'react';
import { StyleSheet, View as RNView } from 'react-native';
import Feather from '@expo/vector-icons/Feather';
import { Text as RNText } from '@/components/Themed';
import { CHROME_FONT_CAP, useTheme } from '@/constants/Theme';
import { useWorkflowRun, useWorkflows } from '@codecast/web/hooks/useSyncWorkflows';
import { appPool, flowBySlug, flowOfRun, type AppFlow } from '@codecast/web/lib/line/flowPool';
import { flowDiagram, runReached, stepStates, type DiagramStep, type StepState } from '@codecast/web/lib/line/flowDiagram';
import { flowRunState, type FlowRunTone } from '@codecast/web/lib/line/flowFence';

type FeatherName = React.ComponentProps<typeof Feather>['name'];
type RunRow = Parameters<typeof stepStates>[1] & { _id: string; status: string; task_short_id?: string | null; fail_reason?: string | null; workflow_slug?: string; workflow_name?: string };

const WHO: Record<DiagramStep['kind'], FeatherName> = { agent: 'cpu', script: 'terminal', person: 'user', call: 'zap', segment: 'layers', parallel: 'columns', join: 'git-merge' };

function usePool(): AppFlow[] {
  const { workflows } = useWorkflows();
  return useMemo(() => appPool(workflows as any), [workflows]);
}

export function FlowCard({ slug }: { slug: string }) {
  const pool = usePool();
  const flow = flowBySlug(pool, slug);
  if (!flow) return null;
  return <FlowBody flow={flow} run={null} />;
}

export function FlowRunCard({ runId }: { runId: string }) {
  const pool = usePool();
  const run = useWorkflowRun(runId) as RunRow | null | undefined;
  const flow = run ? flowOfRun(pool, run) : null;
  if (!run || !flow) return null;
  return <FlowBody flow={flow} run={run} />;
}

function FlowBody({ flow, run }: { flow: AppFlow; run: RunRow | null }) {
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
          <Feather name={WHO[s.kind]} size={12} color={Theme.textDim} />
          <RNText style={[styles.stepName, { color: Theme.text }]} maxFontSizeMultiplier={CHROME_FONT_CAP}>{s.label}</RNText>
          {m.icon ? <Feather name={m.icon} size={12} color={m.color} /> : null}
        </RNView>
        {routes.map((r, i) => (
          <RNText key={i} style={[styles.route, { color: run && r.tone === 'stop' ? Theme.red : Theme.textDim }]} maxFontSizeMultiplier={CHROME_FONT_CAP}>
            {r.tone === 'back' ? '↺ ' : r.tone === 'stop' ? '⊣ ' : '↳ '}{r.outcome}{r.leadsTo ? ` → ${r.leadsTo}` : ''}
          </RNText>
        ))}
      </RNView>
    );
  };

  return (
    <RNView style={[styles.card, { borderColor: Theme.border, backgroundColor: Theme.bgAlt }]}>
      <RNView style={styles.head}>
        <RNText style={[styles.kind, { color: flow.kind === 'line' ? Theme.blue : Theme.textDim, borderColor: Theme.border }]} maxFontSizeMultiplier={CHROME_FONT_CAP}>{flow.kind === 'line' ? 'LINE' : 'SEGMENT'}</RNText>
        <RNText style={[styles.name, { color: Theme.text }]} numberOfLines={1} maxFontSizeMultiplier={CHROME_FONT_CAP}>{flow.label}</RNText>
        <RNView style={{ flex: 1 }} />
        {state ? <RNText style={[styles.state, { color: tone[state.tone] }]} maxFontSizeMultiplier={CHROME_FONT_CAP}>{state.words}</RNText> : null}
        {run?.task_short_id ? <RNText style={[styles.task, { color: Theme.textMuted }]} maxFontSizeMultiplier={CHROME_FONT_CAP}>{run.task_short_id}</RNText> : null}
      </RNView>
      <RNView style={styles.steps}>
        {model.steps.map((s) => (s.inner.length > 1 || s.kind === 'parallel' ? (
          <RNView key={s.id}>
            <RNText style={[styles.group, { color: Theme.textMuted }]} maxFontSizeMultiplier={CHROME_FONT_CAP}>{s.label}{s.kind === 'parallel' ? ` · ${s.inner.length} side by side` : ''}</RNText>
            {s.inner.map((i) => row(i, 1))}
            {(run ? s.side.filter((r) => runReached(run, r.toId)) : s.side).map((r, i) => (
              <RNText key={i} style={[styles.route, { marginLeft: 14, color: Theme.textDim }]} maxFontSizeMultiplier={CHROME_FONT_CAP}>{r.tone === 'back' ? '↺ ' : '↳ '}{r.outcome}{r.leadsTo ? ` → ${r.leadsTo}` : ''}</RNText>
            ))}
          </RNView>
        ) : s.inner.length === 1 ? row({ ...s.inner[0], label: s.label, side: [...s.inner[0].side, ...s.side] }, 0) : row(s, 0)))}
        {model.end ? (
          <RNText style={[styles.end, { color: run && runReached(run, model.endId) ? Theme.green : Theme.textMuted }]} maxFontSizeMultiplier={CHROME_FONT_CAP}>{model.end}</RNText>
        ) : null}
      </RNView>
      {state?.why ? <RNText style={[styles.why, { color: Theme.textMuted }]} numberOfLines={4} maxFontSizeMultiplier={CHROME_FONT_CAP}>{state.why}</RNText> : null}
    </RNView>
  );
}

const styles = StyleSheet.create({
  card: { marginVertical: 6, borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, overflow: 'hidden' },
  head: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 10, paddingVertical: 8 },
  kind: { fontSize: 9, letterSpacing: 0.5, paddingHorizontal: 5, paddingVertical: 1, borderWidth: StyleSheet.hairlineWidth, borderRadius: 4 },
  name: { fontSize: 13, fontWeight: '600', flexShrink: 1 },
  state: { fontSize: 11, fontWeight: '600' },
  task: { fontSize: 11 },
  steps: { paddingHorizontal: 12, paddingBottom: 10, gap: 6 },
  step: { flexDirection: 'row', alignItems: 'center', gap: 7, paddingVertical: 2 },
  stepName: { fontSize: 13, fontWeight: '600' },
  route: { fontSize: 11, marginLeft: 19 },
  group: { fontSize: 11, fontWeight: '700', marginTop: 2, marginBottom: 2 },
  end: { fontSize: 12, fontWeight: '600', marginTop: 2 },
  why: { fontSize: 11, paddingHorizontal: 12, paddingBottom: 10 },
});
