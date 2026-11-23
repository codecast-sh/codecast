// One flow of the pool on the phone, the twin of the web's Flows library with
// that flow open (/flows?view=flows&item=<slug>, `flow:<slug>`): what kind of
// flow it is and where it sits in the library, its steps down the screen
// (each segment's own steps under it, every route off the path in words, a
// step pressed opens what it runs), and the changes that ran through it,
// each run opening where it is now with its session and task one tap away.
// Addressed by slug: `flow:change` and `change` are the same screen.
//
// Store-fed like the web page: useFlowLibrary reads the pool (the shipped
// flows plus the team's and the viewer's pushed rows) and the runs collection;
// the runs feeders are the two the web's Flows app mounts.
import { useMemo, useState } from 'react';
import { ScrollView, StyleSheet, TouchableOpacity, View as RNView } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import Feather from '@expo/vector-icons/Feather';
import { Text as RNText } from '@/components/Themed';
import { Spacing, themedStyles, useTheme, CHROME_FONT_CAP } from '@/constants/Theme';
import { Mono, uiFace } from '@/constants/fonts';
import { MarkdownContent } from '@/components/MarkdownRenderer';
import { BottomSheet } from '@/components/BottomSheet';
import { FactChip, Facts, FactRow, MoreToggle, ObjectHeader, ObjectMissing, SectionLabel, objectStyles } from '@/components/objects/ObjectParts';
import { FlowRunCard, WHO } from '@/components/session/FlowCard';
import { flowSlugOf, flowRefOf } from '@codecast/shared/entities';
import { useCoarseNow } from '@codecast/web/hooks/useCoarseNow';
import { useFlowLibrary, type FlowRun } from '@codecast/web/hooks/useFlowLibrary';
import { useSyncPoolFlows, useTeamDefaultFlowSlug, useWorkflowRun } from '@codecast/web/hooks/useSyncWorkflows';
import { useSyncRuns } from '@codecast/web/hooks/useSyncRuns';
import { useSyncTeamShipFeeds } from '@codecast/web/hooks/useSessionShipState';
import { useActiveWorkspaceKey } from '@codecast/web/hooks/useWorkspaceCollection';
import { compactAge } from '@codecast/web/lib/threadState';
import { flowBySlug, type AppFlow } from '@codecast/web/lib/line/flowPool';
import { defaultFlowOf, takesSessionChange } from '@codecast/shared/contracts/flowPool';
import { changesAnything, libraryEntry } from '@codecast/web/lib/line/flowLibrary';
import { flowDiagram, routeTail, type DiagramStep, type SideRoute } from '@codecast/web/lib/line/flowDiagram';
import { flowRunState, type FlowRunTone } from '@codecast/web/lib/line/flowFence';
import { useFlowStations } from '@codecast/web/lib/line/flowStations';
import { stationView } from '@codecast/web/lib/line/stationView';
import { journeyOf, journeyWords, readableWhy } from '@codecast/web/lib/ship/journey';
import { useJourneyViewer } from '@codecast/web/hooks/useJourneyViewer';

type Tone = FlowRunTone;
const RUNS_FEED = { limit: 200 };
const RUNS_SHOWN = 20;
/** A session change's journey tone as a run tone (the web's Flows view does the same). */
const JOURNEY_TONE: Record<string, Tone> = { idle: 'running', working: 'running', agent: 'running', session: 'waiting', you: 'waiting', wait: 'waiting', ok: 'passed', bad: 'stopped' };
const TAKES_WORDS: Record<string, string> = { branch: "a branch or a session's edits", task: 'a task' };

export default function FlowScreen() {
  const Theme = useTheme();
  const router = useRouter();
  const { id: rawId } = useLocalSearchParams<{ id: string }>();
  const slug = flowSlugOf(rawId?.startsWith('flow:') ? rawId : `flow:${rawId ?? ''}`);
  const now = useCoarseNow(30_000);

  const space = useActiveWorkspaceKey();
  const { ready } = useSyncPoolFlows(space);
  useSyncRuns(RUNS_FEED, true, space);
  useSyncTeamShipFeeds();
  const { lib, flows, runsOf } = useFlowLibrary(space);
  const teamDefault = useTeamDefaultFlowSlug();
  const defaultSlug = useMemo(() => defaultFlowOf(flows, teamDefault)?.slug ?? null, [flows, teamDefault]);

  const flow = flowBySlug(flows, slug);
  const [step, setStep] = useState<DiagramStep | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [allRuns, setAllRuns] = useState(false);

  if (!flow || !slug) return <ObjectMissing what="Flow" id={slug ? flowRefOf(slug) : rawId} loading={!!slug && !ready} />;

  const entry = libraryEntry(lib, flow.slug);
  const usedBy = flows.filter((f) => f.uses.includes(flow.slug));
  const runs = (runsOf.get(flow.slug) ?? []).slice().sort((a, b) => b.created_at - a.created_at);
  const kind = entry?.spine ? 'Spine' : entry?.base ? 'Variant' : flow.kind === 'line' ? 'Flow' : 'Segment';
  const open = (s: string) => router.push(`/flow/${s}` as never);
  const flowChip = (s: string) => (
    <FactChip key={s} icon="random" label={flowBySlug(flows, s)?.label ?? s} color={Theme.violet} onPress={() => open(s)} link testID={`flow-chip-${s}`} />
  );
  const change = entry?.change && changesAnything(entry.change) ? entry.change : null;

  return (
    <>
      <ObjectHeader type="flow" shortId={flowRefOf(flow.slug)} title={flow.label} />
      <ScrollView style={objectStyles.container} contentContainerStyle={objectStyles.content} testID="flow-screen">
        <RNText style={objectStyles.title}>{flow.label}</RNText>
        <RNView style={objectStyles.chips}>
          <FactChip label={kind} color={flow.kind === 'line' ? Theme.violet : Theme.cyan} />
          {flow.slug === defaultSlug ? <FactChip icon="star" label="Default" color={Theme.green} /> : null}
          <FactChip label={flow.where === 'shipped' ? 'Ships with codecast' : flow.where === 'team' ? "Team's library" : 'Yours'} color={Theme.textMuted} />
          {runs.length ? <FactChip label={`${runs.length} ${runs.length === 1 ? 'run' : 'runs'}`} color={Theme.textMuted} /> : null}
        </RNView>
        {flow.description ? <RNText style={styles.desc}>{flow.description}</RNText> : null}

        <Facts>
          <FactRow label="Takes">{flow.takes.map((t) => TAKES_WORDS[t] ?? t).join(', ') || 'anything'}</FactRow>
          {entry?.base ? <FactRow label="Extends">{flowChip(entry.base)}</FactRow> : null}
          {change ? (
            <FactRow label="Changes">
              {[
                  change.added.length ? `adds ${change.added.map((s) => s.label).join(', ')}` : '',
                  change.removed.length ? `drops ${change.removed.map((s) => s.label).join(', ')}` : '',
                  ...change.changed.map((c) => `${c.label}: ${c.what.join(', ')}`),
                  change.serves ? `serves ${change.serves.join(', ')}` : '',
              ].filter(Boolean).join(' · ')}
            </FactRow>
          ) : null}
          {entry?.variants.length ? <FactRow label="Variants">{entry.variants.map((v) => flowChip(v.flow.slug))}</FactRow> : null}
          {flow.uses.length ? <FactRow label="Made of">{flow.uses.map(flowChip)}</FactRow> : null}
          {usedBy.length ? <FactRow label="Part of">{usedBy.map((f) => flowChip(f.slug))}</FactRow> : null}
        </Facts>

        <RNView style={objectStyles.section}>
          <SectionLabel>Steps</SectionLabel>
          <Steps flow={flow} onStep={setStep} />
        </RNView>

        <RNView style={objectStyles.section}>
          <SectionLabel>{runs.length ? `Changes run through it · ${runs.length}` : 'Changes run through it'}</SectionLabel>
          {runs.length === 0 ? <RNText style={objectStyles.empty}>None yet</RNText> : (
            <RNView style={styles.card}>
              {(allRuns ? runs : runs.slice(0, RUNS_SHOWN)).map((r, i) => <RunRow key={r._id} run={r} flow={flow} now={now} first={i === 0} onPress={() => setRunId(r._id)} />)}
            </RNView>
          )}
          <MoreToggle hidden={runs.length - RUNS_SHOWN} open={allRuns} onPress={() => setAllRuns((v) => !v)} />
        </RNView>
      </ScrollView>
      <StepSheet flow={flow} step={step} onClose={() => setStep(null)} onOpenFlow={(s) => { setStep(null); open(s); }} />
      <RunSheet runId={runId} onClose={() => setRunId(null)} onGo={(to) => { setRunId(null); router.push(to as never); }} />
    </>
  );
}

/** The flow down the screen: one numbered step per station on the path, a segment's own steps under its name, each route off the path in words. */
function Steps({ flow, onStep }: { flow: AppFlow; onStep: (s: DiagramStep) => void }) {
  const Theme = useTheme();
  const model = useMemo(() => flowDiagram(flow), [flow]);
  return (
    <RNView>
      {model.steps.map((s, i) => {
        // A segment of one step reads as that step, under the segment's name (FlowCard does the same).
        const lone = s.inner.length === 1 ? { ...s.inner[0], label: s.label, side: [...s.inner[0].side, ...s.side], slot: s.slot } : null;
        const group = !lone && (s.inner.length > 1 || s.kind === 'parallel');
        return (
          <RNView key={`${i}:${s.id}`} style={styles.stepRow}>
            <RNView style={styles.railCol}>
              <RNView style={[styles.bead, { borderColor: Theme.violet }]}><RNText style={[styles.beadText, { color: Theme.violet }]} maxFontSizeMultiplier={CHROME_FONT_CAP}>{i + 1}</RNText></RNView>
              {i < model.steps.length - 1 || model.end ? <RNView style={[styles.rail, { backgroundColor: Theme.borderLight }]} /> : null}
            </RNView>
            <RNView style={styles.stepBody}>
              {group ? (
                <>
                  <StepLine step={s} sub={s.kind === 'parallel' ? `${s.inner.length} side by side` : `${s.inner.length} steps${s.slot?.filled === 'generated' ? ', written here' : ''}`} onPress={() => onStep(s)} />
                  <RNView style={[styles.inner, { borderLeftColor: Theme.borderLight }]}>
                    {s.inner.map((x) => (
                      <RNView key={x.id}>
                        <StepLine step={x} small onPress={() => onStep(x)} />
                        <Routes routes={x.side} />
                      </RNView>
                    ))}
                  </RNView>
                  <Routes routes={s.side} />
                </>
              ) : (
                <>
                  <StepLine step={lone ?? s} onPress={() => onStep(lone ?? s)} />
                  <Routes routes={(lone ?? s).side} />
                </>
              )}
            </RNView>
          </RNView>
        );
      })}
      {model.end ? (
        <RNView style={styles.stepRow}>
          <RNView style={styles.railCol}>
            <RNView style={[styles.bead, { borderColor: Theme.green, backgroundColor: Theme.green + '18' }]}><Feather name="flag" size={11} color={Theme.green} /></RNView>
          </RNView>
          <RNView style={[styles.stepBody, { paddingBottom: 0, justifyContent: 'center', minHeight: 26 }]}>
            <RNText style={[styles.endText, { color: Theme.green }]}>{model.end}<RNText style={styles.endSub}>  when every step passes</RNText></RNText>
          </RNView>
        </RNView>
      ) : null}
    </RNView>
  );
}

function StepLine({ step, sub, small, onPress }: { step: DiagramStep; sub?: string; small?: boolean; onPress: () => void }) {
  const Theme = useTheme();
  const who = WHO[step.kind];
  const empty = step.slot?.filled === 'empty';
  const word = sub ?? (empty ? 'slot, nothing in it yet' : step.slot?.filled === 'generated' ? 'written here' : who.word);
  return (
    <TouchableOpacity style={[styles.stepLine, small && styles.stepLineSmall]} onPress={onPress} activeOpacity={0.6} accessibilityRole="button" accessibilityLabel={`${step.label}, ${word}`} testID={`flow-step-${step.id}`}>
      <Feather name={who.icon} size={small ? 12 : 14} color={Theme.textMuted} style={styles.stepIcon} />
      <RNView style={{ flex: 1, minWidth: 0 }}>
        <RNText style={[small ? styles.stepNameSmall : styles.stepName, empty && { color: Theme.textMuted }]}>{step.label}</RNText>
        <RNText style={[styles.stepWho, step.slot?.filled === 'generated' && { color: Theme.violet }]} maxFontSizeMultiplier={CHROME_FONT_CAP}>{word}</RNText>
      </RNView>
      <Feather name="chevron-right" size={14} color={Theme.textDim} />
    </TouchableOpacity>
  );
}

/** Routes off the path: a way back (violet), a stop (red), any other end or jump (muted). */
function Routes({ routes }: { routes: SideRoute[] }) {
  const Theme = useTheme();
  if (!routes.length) return null;
  return (
    <RNView style={styles.routes}>
      {routes.map((r, i) => {
        const color = r.tone === 'back' ? Theme.violet : r.tone === 'stop' ? Theme.red : Theme.textMuted;
        const icon = r.tone === 'back' ? 'corner-up-left' : r.tone === 'stop' ? 'x-octagon' : r.leadsTo ? 'corner-down-right' : 'log-out';
        return (
          <RNView key={i} style={styles.route}>
            <Feather name={icon} size={11} color={color} style={{ marginTop: 3 }} />
            <RNText style={styles.routeText}>
              <RNText style={{ fontWeight: '600', color: Theme.text }}>{r.outcome}</RNText>
              <RNText style={{ color }}>{`  ${routeTail(r)}`}</RNText>
            </RNText>
          </RNView>
        );
      })}
    </RNView>
  );
}

const TEXT_WORD = { prompt: 'Prompt', guide: "Project's guidance", system: 'System prompt', script: 'Script', doc: 'Decision document' } as const;

/** One step, whole: who does it and with what, the words it runs, and where each outcome sends the work. */
function StepSheet({ flow, step, onClose, onOpenFlow }: { flow: AppFlow; step: DiagramStep | null; onClose: () => void; onOpenFlow: (slug: string) => void }) {
  const Theme = useTheme();
  const stations = useFlowStations(flow, !!step);
  const view = useMemo(() => (step ? stationView(flow, step.id, step.kind, stations) : null), [flow, step, stations]);
  const [tab, setTab] = useState(0);
  const text = view?.texts[Math.min(tab, Math.max(0, view.texts.length - 1))];
  return (
    <BottomSheet visible={!!step && !!view} onClose={() => { setTab(0); onClose(); }}>
      {view && step ? (
        <ScrollView style={{ maxHeight: 560 }} contentContainerStyle={{ paddingBottom: 8 }} testID="flow-step-sheet">
          <RNView style={styles.sheetHead}>
            <Feather name={WHO[step.kind].icon} size={16} color={Theme.textMuted} />
            <RNText style={styles.sheetTitle}>{view.label}</RNText>
          </RNView>
          {view.segment ? <RNText style={styles.sheetSub}>in {view.segment}</RNText> : null}
          <RNView style={[styles.chips, { marginTop: 10, marginBottom: 0 }]}>
            {(view.facts.length ? view.facts : [WHO[step.kind].word]).map((f) => <FactChip key={f} label={f} color={Theme.textMuted} />)}
          </RNView>
          {view.runsFlow ? (
            <TouchableOpacity style={[styles.sheetLink, { borderColor: Theme.borderLight }]} onPress={() => onOpenFlow(view.runsFlow!)} testID="flow-step-runs-flow">
              <Feather name="shuffle" size={13} color={Theme.violet} />
              <RNText style={styles.sheetLinkText}>Runs the {view.runsFlow} flow</RNText>
              <Feather name="chevron-right" size={14} color={Theme.textDim} />
            </TouchableOpacity>
          ) : null}
          {stations === undefined && !view.runsFlow ? <RNText style={[styles.sheetSub, { marginTop: 14 }]}>Loading what it runs…</RNText> : text ? (
            <RNView style={{ marginTop: 16 }}>
              {view.texts.length > 1 ? (
                <RNView style={styles.tabs}>
                  {view.texts.map((t, i) => (
                    <TouchableOpacity key={t.kind} onPress={() => setTab(i)} style={[styles.tab, t === text && { backgroundColor: Theme.violet + '1f' }]} accessibilityRole="tab" accessibilityState={{ selected: t === text }}>
                      <RNText style={[styles.tabText, { color: t === text ? Theme.violet : Theme.textMuted }]} maxFontSizeMultiplier={CHROME_FONT_CAP}>{TEXT_WORD[t.kind]}</RNText>
                    </TouchableOpacity>
                  ))}
                </RNView>
              ) : <RNText style={styles.textLabel}>{TEXT_WORD[text.kind]}</RNText>}
              <RNView style={[styles.textBox, { borderColor: Theme.borderLight, backgroundColor: Theme.bg }]}>
                {text.kind === 'script'
                  ? <RNText style={styles.script} selectable>{text.text}</RNText>
                  : <MarkdownContent text={text.text} baseStyle={styles.promptText} />}
              </RNView>
            </RNView>
          ) : null}
          {view.routes.length ? (
            <RNView style={{ marginTop: 16 }}>
              <RNText style={styles.textLabel}>Where it sends the work</RNText>
              {view.routes.map((r, i) => (
                <RNView key={i} style={styles.sheetRoute}>
                  <RNText style={[styles.sheetRouteWhen, { color: r.ends ? Theme.textMuted : Theme.text }]}>{r.words}</RNText>
                  <Feather name="arrow-right" size={12} color={Theme.textDim} />
                  <RNText style={[styles.sheetRouteTo, r.ends && { color: Theme.textMuted }]} numberOfLines={2}>{r.to}</RNText>
                </RNView>
              ))}
            </RNView>
          ) : null}
        </ScrollView>
      ) : null}
    </BottomSheet>
  );
}

function useToneColor(): Record<Tone, string> {
  const Theme = useTheme();
  return { running: Theme.blue, waiting: Theme.yellow, passed: Theme.green, stopped: Theme.red, failed: Theme.red };
}

/** A run as the web's list says it: where it stands (a session's change in its journey's words), what it carried, why it stopped, how long ago. */
function RunRow({ run, flow, now, first, onPress }: { run: FlowRun; flow: AppFlow; now: number; first: boolean; onPress: () => void }) {
  const Theme = useTheme();
  const tones = useToneColor();
  const st = flowRunState(run as any, flow);
  const viewer = useJourneyViewer(run as any);
  const jw = takesSessionChange(flow) && flow.kind === 'line' ? journeyWords(journeyOf(flow, run as any, [], viewer)) : null;
  const tone = jw ? JOURNEY_TONE[jw.tone] ?? st.tone : st.tone;
  const why = readableWhy(st.why);
  return (
    <TouchableOpacity style={[styles.runRow, !first && styles.rowRule]} onPress={onPress} activeOpacity={0.6} testID={`flow-run-${run._id}`}>
      <RNView style={[styles.runDot, { backgroundColor: tones[tone] }]} />
      <RNView style={{ flex: 1, minWidth: 0 }}>
        <RNText style={styles.runTitle} numberOfLines={1}>{run.task_title ?? run.task_short_id ?? (run.run_kind === 'workflow' ? 'In a session' : 'No task')}</RNText>
        <RNText style={styles.runMeta} numberOfLines={1}>
          <RNText style={{ color: tones[tone], fontWeight: '600' }}>{jw?.words ?? st.words}</RNText>
          {why ? `  ·  ${why}` : ''}
        </RNText>
      </RNView>
      <RNText style={styles.runAge} maxFontSizeMultiplier={CHROME_FONT_CAP}>{compactAge(now - run.created_at)}</RNText>
      <Feather name="chevron-right" size={14} color={Theme.textDim} />
    </TouchableOpacity>
  );
}

/** One run: where it is in its flow (the transcript's run card), and the session and task it belongs to. */
function RunSheet({ runId, onClose, onGo }: { runId: string | null; onClose: () => void; onGo: (route: string) => void }) {
  const Theme = useTheme();
  const run = useWorkflowRun(runId) as (FlowRun & { primary_session_id?: string; gate_decision_id?: string | null; gate_decision_short_id?: string | null }) | null | undefined;
  // A run paused on a person's call answers on the decision's own screen.
  const decision = run?.status === 'paused' ? run.gate_decision_short_id ?? run.gate_decision_id ?? null : null;
  return (
    <BottomSheet visible={!!runId} onClose={onClose}>
      {runId ? (
        <ScrollView style={{ maxHeight: 560 }} testID="flow-run-sheet">
          <RNText style={styles.sheetTitle} numberOfLines={2}>{run?.task_title ?? run?.task_short_id ?? 'Run'}</RNText>
          {run === null ? <RNText style={[styles.sheetSub, { marginTop: 8 }]}>This run is not available.</RNText> : <FlowRunCard runId={runId} />}
          {run ? (
            <RNView style={[styles.card, { marginTop: 8 }]}>
              {decision ? (
                <SheetRow icon="help-circle" color={Theme.yellow} label="Answer it" strong onPress={() => onGo(`/decisions/${decision}`)} testID="flow-run-decision" />
              ) : null}
              {run.primary_conversation_id ? (
                <SheetRow icon="message-square" color={Theme.cyan} label="Open its session" rule={!!decision} onPress={() => onGo(`/session/${run.primary_conversation_id}`)} testID="flow-run-session" />
              ) : null}
              {run.task_short_id ? (
                <SheetRow icon="check-square" color={Theme.orange} label={`Open ${run.task_short_id}`} rule={!!run.primary_conversation_id || !!decision} onPress={() => onGo(`/task/${run.task_short_id}`)} testID="flow-run-task" />
              ) : null}
            </RNView>
          ) : null}
        </ScrollView>
      ) : null}
    </BottomSheet>
  );
}

function SheetRow({ icon, color, label, rule, strong, onPress, testID }: { icon: React.ComponentProps<typeof Feather>['name']; color: string; label: string; rule?: boolean; strong?: boolean; onPress: () => void; testID?: string }) {
  const Theme = useTheme();
  return (
    <TouchableOpacity style={[styles.sheetRow, rule && styles.rowRule]} onPress={onPress} activeOpacity={0.6} testID={testID}>
      <Feather name={icon} size={14} color={color} />
      <RNText style={[styles.sheetRowText, strong && { color, fontWeight: '700' }]}>{label}</RNText>
      <Feather name="chevron-right" size={14} color={Theme.textDim} />
    </TouchableOpacity>
  );
}

const styles = themedStyles((Theme) => StyleSheet.create({
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 10, marginBottom: 4 },
  desc: { marginTop: -Spacing.sm, marginBottom: Spacing.lg, fontSize: 14, lineHeight: 21, color: Theme.textSecondary },
  stepRow: { flexDirection: 'row', gap: 12 },
  railCol: { width: 26, alignItems: 'center' },
  bead: { width: 26, height: 26, borderRadius: 13, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center', backgroundColor: Theme.bg },
  beadText: { fontSize: 12, fontWeight: '700', fontVariant: ['tabular-nums'] },
  rail: { flex: 1, width: 1.5, marginVertical: 2 },
  stepBody: { flex: 1, minWidth: 0, paddingBottom: 18 },
  stepLine: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 26, paddingVertical: 2 },
  stepLineSmall: { paddingVertical: 6 },
  stepIcon: { width: 16, textAlign: 'center' },
  stepName: { fontSize: 16, fontWeight: '600', color: Theme.text },
  stepNameSmall: { fontSize: 14, fontWeight: '500', color: Theme.text },
  stepWho: { fontSize: 12, color: Theme.textMuted, marginTop: 1 },
  inner: { marginTop: 6, marginLeft: 7, paddingLeft: 12, borderLeftWidth: 1.5 },
  routes: { marginTop: 4, marginLeft: 26, gap: 3 },
  route: { flexDirection: 'row', gap: 7 },
  routeText: { flex: 1, fontSize: 12.5, lineHeight: 18 },
  endText: { fontSize: 15, fontWeight: '700' },
  endSub: { fontSize: 12, fontWeight: '400', color: Theme.textMuted },
  card: { borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, borderColor: Theme.borderLight, backgroundColor: Theme.card, overflow: 'hidden' },
  rowRule: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: Theme.borderLight },
  runRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, paddingVertical: 11 },
  runDot: { width: 8, height: 8, borderRadius: 4 },
  runTitle: { fontSize: 14, fontWeight: '500', color: Theme.text },
  runMeta: { marginTop: 2, fontSize: 12, lineHeight: 17, color: Theme.textMuted },
  runAge: { fontSize: 12, color: Theme.textMuted0, fontVariant: ['tabular-nums'] },
  sheetHead: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  sheetTitle: { flex: 1, fontSize: 18, fontWeight: '700', color: Theme.text },
  sheetSub: { marginTop: 2, fontSize: 13, color: Theme.textMuted },
  sheetLink: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 14, borderWidth: StyleSheet.hairlineWidth, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10 },
  sheetLinkText: { flex: 1, fontSize: 14, color: Theme.text },
  tabs: { flexDirection: 'row', gap: 6, marginBottom: 8 },
  tab: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 6 },
  tabText: { fontSize: 12.5, fontWeight: '600' },
  textLabel: { fontSize: 11, fontWeight: '600', letterSpacing: 0.8, textTransform: 'uppercase', color: Theme.textMuted0, marginBottom: 8 },
  textBox: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10 },
  promptText: { fontSize: 13.5, lineHeight: 20, color: Theme.text },
  script: { fontSize: 12.5, lineHeight: 18, color: Theme.text, fontFamily: uiFace(Mono.regular) },
  sheetRoute: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 6, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: Theme.bgHighlight },
  sheetRouteWhen: { flexShrink: 1, fontSize: 13, fontWeight: '600' },
  sheetRouteTo: { flex: 1, fontSize: 13, color: Theme.text },
  sheetRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, paddingVertical: 12 },
  sheetRowText: { flex: 1, fontSize: 14, color: Theme.text },
}));
