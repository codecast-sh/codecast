// A flow of the pool, or one run of it, on the phone (docs/architecture/flows.md
// FL6): the same model the web draws (web lib/line/flowDiagram.ts), laid out
// down the screen. One row per step with who does it and, on a run, its state;
// a segment's or a fan-out's steps indented under its name; on a run only the
// route it took, red where it stopped; in a definition the routes off the path,
// neutral.
import React, { useContext, useMemo, useState } from 'react';
import { Pressable, StyleSheet, View as RNView } from 'react-native';
import { useRouter } from 'expo-router';
import Feather from '@expo/vector-icons/Feather';
import { Text as RNText } from '@/components/Themed';
import { CHROME_FONT_CAP, useTheme } from '@/constants/Theme';
import { codeFont } from '@/constants/fonts';
import { CodeRuns } from '@/components/CodeRuns';
import { useWorkflowRun } from '@codecast/web/hooks/useSyncWorkflows';
import { useNamedFlow, useRunFlow, type FlowLibraryState } from '@codecast/web/hooks/useFlowObject';
import { useInboxStore } from '@codecast/web/store/inboxStore';
import { type AppFlow } from '@codecast/web/lib/line/flowPool';
import { flowDiagram, routeTail, runReached, stepStates, type DiagramStep, type SideRoute, type StepState } from '@codecast/web/lib/line/flowDiagram';
import { flowRunState, type FlowRunTone } from '@codecast/web/lib/line/flowFence';
import { takesSessionChange } from '@codecast/shared/contracts/flowPool';
import { leftWords } from '@codecast/web/lib/ship/stationResult';
import { insideWords, journeyOf, type JourneyNow, type JourneyStage, type JourneyWait, type StageState } from '@codecast/web/lib/ship/journey';
import { gateWaitWords, holdWords, sentBackWords, stageNote, stopWords, waitWords, wholeWhy, WHO_WORDS } from '@codecast/web/lib/ship/journeyWords';
import type { FlowEdit } from '@codecast/shared/contracts/flowEdit';
import { asGitDiff, editDrawing, editLines, editRun, liveDeploy, type EditMark } from '@codecast/web/lib/line/flowEditCard';
import { CastDiff } from '@/components/CastDiff';
import { DecisionCard } from '@/components/decisions/DecisionCard';
import { mobileRouteForUrl } from '@/lib/linkRoutes';
import { openAppRoute } from '@/lib/links';
import { flowContext } from '@codecast/web/lib/flowContext';
import { runHref } from '@codecast/web/lib/decisionLinks';
import { useSessionFlowRuns } from '@codecast/web/hooks/useSyncWorkflows';
import { MessageIdentity } from '@codecast/web/lib/conversationBlockContexts';
import { runShip } from '@codecast/web/lib/ship/sessionShip';
import { usePipelineModels, usePipelineWorkspace } from '@codecast/web/hooks/usePipelines';
import { useActiveWorkspaceKey } from '@codecast/web/hooks/useWorkspaceCollection';
import { repoName, spanWords, type PipelineLane } from '@codecast/web/lib/line/pipelineModel';
import { useJourneyViewer } from '@codecast/web/hooks/useJourneyViewer';
import { useCoarseNow } from '@codecast/web/hooks/useCoarseNow';
import { ageShort } from '@codecast/web/lib/lineFlow';
import { ResumeAtAction } from './ResumeAtAction';

type FeatherName = React.ComponentProps<typeof Feather>['name'];
type RunRow = Parameters<typeof stepStates>[1] & { _id: string; status: string; task_short_id?: string | null; fail_reason?: string | null; workflow_slug?: string; workflow_name?: string };

export const WHO: Record<DiagramStep['kind'], { icon: FeatherName; word: string }> = {
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

/** Where a run card's steps open: each step's station (its session, or the decision it asked), and the run itself. */
type RunLinks = { stepHref: (stepId: string) => string | undefined; runHref: string; open: (href: string) => void };

/** A run on its flow. `onOpen` takes over navigation (a sheet closes itself first); by default a tap opens the screen. */
export function FlowRunCard({ runId, onOpen }: { runId: string; onOpen?: (route: string) => void }) {
  const router = useRouter();
  const run = useWorkflowRun(runId) as RunRow | null | undefined;
  const { flow, library } = useRunFlow(run);
  const links = useMemo((): RunLinks | null => {
    if (!run || !flow) return null;
    // The stations as the web's flow strip reads them (lib/flowContext); a step that groups a segment opens its latest station that ran.
    const stations = flowContext(run as any, flow).stations.filter((st) => st.href);
    return {
      stepHref: (stepId) => [...stations].reverse().find((st) => st.id === stepId || st.id.startsWith(`${stepId}__`))?.href,
      runHref: runHref(run._id),
      open: (href) => {
        const route = mobileRouteForUrl(href);
        if (route) (onOpen ? onOpen(route) : openAppRoute(router, route));
      },
    };
  }, [run, flow, onOpen, router]);
  if (!run || !flow || !links) return null;
  if (flow.kind === 'line' && takesSessionChange(flow)) return <ShipBody flow={flow} run={run} links={links} />;
  return <FlowBody flow={flow} run={run} library={library} links={links} />;
}

/** The card's name: a press opens the run when the card draws one. */
function CardName({ label, links }: { label: string; links?: RunLinks | null }) {
  const Theme = useTheme();
  const text = <RNText style={[styles.name, { color: links ? Theme.violet : Theme.text }]} maxFontSizeMultiplier={CHROME_FONT_CAP}>{label}</RNText>;
  if (!links) return text;
  return (
    <Pressable onPress={() => links.open(links.runHref)} hitSlop={8} style={({ pressed }) => [styles.namePress, pressed && { opacity: 0.6 }]} accessibilityRole="link" accessibilityLabel={`Open the ${label} run`} testID="flow-card-run">
      {text}
      <Feather name="chevron-right" size={13} color={Theme.violet} />
    </Pressable>
  );
}

/** A step row: pressable when its station opens somewhere, with a chevron saying so. */
function StepRow({ href, links, style, children, testID }: { href?: string; links?: RunLinks | null; style: any; children: React.ReactNode; testID?: string }) {
  const Theme = useTheme();
  if (!href || !links) return <RNView style={style} testID={testID}>{children}</RNView>;
  return (
    <Pressable onPress={() => links.open(href)} hitSlop={4} style={({ pressed }) => [style, pressed && { opacity: 0.6 }]} accessibilityRole="link" testID={testID}>
      {children}
      <RNView style={{ flex: 1 }} />
      <Feather name="chevron-right" size={13} color={Theme.textDim} />
    </Pressable>
  );
}

/** A session's change on its way to live: one row per stage with who acts there, then what is happening now. */
function ShipBody({ flow, run, links }: { flow: AppFlow; run: RunRow; links: RunLinks }) {
  const Theme = useTheme();
  const router = useRouter();
  const viewer = useJourneyViewer(run as any);
  const journey = useMemo(() => journeyOf(flow, run as any, [], viewer), [flow, run, viewer]);
  const finished = journey.stages.every((s) => s.state === 'done' || s.state === 'skipped' || s.state === 'nothing') && journey.stages.some((s) => s.state === 'done');
  const tone: Record<StageState, string> = { idle: Theme.textDim, active: Theme.blue, back: Theme.violet, waiting: Theme.yellow, done: Theme.green, routed: Theme.textMuted, stopped: Theme.red, skipped: Theme.textDim, nothing: Theme.textMuted, unknown: Theme.textMuted };
  const icon: Record<StageState, FeatherName> = { idle: 'circle', active: 'loader', back: 'corner-down-left', waiting: 'clock', done: 'check-circle', routed: 'arrow-right-circle', stopped: 'x-circle', skipped: 'minus-circle', nothing: 'minus', unknown: 'help-circle' };
  const whoWords = (s: JourneyStage) => (s.state === 'nothing' ? 'Skipped' : finished ? (s.round ? `round ${s.round}` : '') : `${s.state === 'back' ? 'This session' : s.role === 'live' || s.state === 'skipped' ? '' : WHO_WORDS[s.who]}${s.round ? ` · round ${s.round}` : ''}`);
  // What a station's result said, under it (the phone has no hover): what it found or why it skipped, a step it left to the person.
  const result = (s: JourneyStage, indent: number) => (
    <>
      {stageNote(s, journey) ? <RNText style={[styles.who, { marginLeft: indent, color: Theme.textDim }]} maxFontSizeMultiplier={CHROME_FONT_CAP}>{stageNote(s, journey)}</RNText> : null}
      {/* The step left for the person opens the task it was posted to, a native screen. */}
      {s.left && run.task_short_id ? (
        <Pressable onPress={() => router.push(`/task/${run.task_short_id}` as never)} hitSlop={8} accessibilityRole="link">
          <RNText style={[styles.who, { marginLeft: indent, color: Theme.blue, fontWeight: '600' }]} maxFontSizeMultiplier={CHROME_FONT_CAP}>{leftWords(s.left)}</RNText>
        </Pressable>
      ) : s.left ? <RNText style={[styles.who, { marginLeft: indent, color: Theme.text, fontWeight: '600' }]} maxFontSizeMultiplier={CHROME_FONT_CAP}>{leftWords(s.left)}</RNText> : null}
    </>
  );
  return (
    <RNView style={[styles.card, { borderColor: Theme.border, backgroundColor: Theme.bgAlt }]}>
      <RNView style={styles.head}>
        <CardName label={flow.label} links={links} />
        {run.task_short_id ? <RNText style={[styles.task, codeFont, { color: Theme.textMuted }]} maxFontSizeMultiplier={CHROME_FONT_CAP}>{run.task_short_id}</RNText> : null}
      </RNView>
      <RNView style={styles.steps}>
        {journey.stages.map((s) => (
          <RNView key={s.id} style={{ opacity: s.state === 'idle' || s.state === 'skipped' ? 0.55 : 1 }}>
            <StepRow href={links.stepHref(s.id)} links={links} style={styles.step} testID={`flow-card-step-${s.id}`}>
              <Feather name={icon[s.state]} size={13} color={tone[s.state]} />
              <RNText style={[styles.stepName, styles.shrink, { color: Theme.text }]} maxFontSizeMultiplier={CHROME_FONT_CAP}>{s.label}</RNText>
              <RNText style={[styles.who, styles.shrink, { color: s.state === 'back' ? Theme.violet : Theme.textMuted }]} maxFontSizeMultiplier={CHROME_FONT_CAP}>{whoWords(s)}</RNText>
            </StepRow>
            {/* A segment's inside, in a few words: the steps a passing run takes through it. */}
            {s.inside ? <RNText style={[styles.who, { marginLeft: 20, color: Theme.textDim }]} maxFontSizeMultiplier={CHROME_FONT_CAP}>{insideWords(s.inside)}</RNText> : null}
            {result(s, 20)}
            {/* A fan-out's branches run side by side: each with its own state. */}
            {s.branches?.map((b) => (
              <RNView key={b.id}>
                <RNView style={[styles.step, { marginLeft: 20, opacity: b.state === 'idle' ? 0.55 : 1 }]}>
                  <Feather name={icon[b.state]} size={12} color={tone[b.state]} />
                  <RNText style={[styles.who, styles.shrink, { color: Theme.text, fontWeight: '600' }]} maxFontSizeMultiplier={CHROME_FONT_CAP}>{b.label}</RNText>
                  <RNText style={[styles.who, styles.shrink, { color: Theme.textMuted }]} maxFontSizeMultiplier={CHROME_FONT_CAP}>{whoWords(b)}</RNText>
                </RNView>
                {result(b, 38)}
              </RNView>
            ))}
          </RNView>
        ))}
      </RNView>
      <NowLine now={journey.now} whole={wholeWhy(journey)} run={run} />
    </RNView>
  );
}

/** The press that can work for where the run stands, as a native screen: the viewer's card, the run, the session, the deploy. */
function nowAction(now: JourneyNow, run: RunRow): { label: string; href: string } | null {
  if (now.kind === 'gate' && now.decisionId) return { label: now.mine ? 'Answer' : 'Open card', href: `/decisions/${now.decisionId}` };
  // The session asks a person: its card, else the session where it asked in words.
  if (now.kind === 'session' && now.blocked) {
    if (now.ask) return { label: now.ask.mine ? 'Answer' : 'Open card', href: `/decisions/${now.ask.id}` };
    return now.conversation ? { label: 'Open session', href: `/session/${now.conversation}` } : null;
  }
  if (now.kind === 'unlanded') return { label: 'Open run', href: `/run/${run._id}` };
  if (now.kind !== 'stopped' && now.kind !== 'failed') return null;
  if (now.fix === 'session' && now.session) return { label: 'Open session', href: `/session/${now.session}` };
  if (now.fix === 'deploy') {
    const dp = now.why?.match(/\bdp-\d+/)?.[0];
    return dp ? { label: `Open ${dp}`, href: `/deploy/${dp}` } : { label: 'Open run', href: `/run/${run._id}` };
  }
  // A stop re-running can fix, or a deliberate one: the run's own screen, where it can be run again or read whole.
  return { label: 'Open run', href: `/run/${run._id}` };
}

/** `whole`: a reason that shows whole (journeyWords.ts wholeWhy): a personal Ship's stop or end short of Live, or a stop naming its one restart. */
function NowLine({ now, run, whole }: { now: JourneyNow; run: RunRow; whole: boolean }) {
  const Theme = useTheme();
  const router = useRouter();
  const action = nowAction(now, run);
  const at = useCoarseNow(30_000);
  const waits = (list: JourneyWait[], named?: string) => list.map((w) => waitWords({ ...w, on: w.on === named ? '' : w.on }, at, ageShort)).filter(Boolean).join('\n') || null;
  const [head, body, color] = ((): [string, string | null, string] => {
    switch (now.kind) {
      case 'idle': return ['', null, Theme.textMuted];
      case 'starting': return ['Starting', null, Theme.blue];
      case 'working': return [now.stage, waits(now.waits, now.stage), now.who === 'agent' ? Theme.orange : Theme.blue];
      case 'session': return [sentBackWords(now), [now.ask?.question, now.note].filter(Boolean).join('\n') || null, now.blocked ? Theme.yellow : Theme.violet];
      // The decision under the line carries the question; the line says only where the run waits.
      case 'gate': return [now.mine ? 'Your call' : gateWaitWords(now.holder, now.who), now.mine && now.decisionId ? `at ${now.stage}` : now.prompt ?? now.stage, Theme.yellow];
      case 'landed': return [`Merged ${now.sha.slice(0, 7)} · ${holdWords(now.hold).words}`, waits(now.waits, 'Deploy') ?? now.line, Theme.green];
      case 'merged': return [`${now.end ?? 'Merged'} ${now.sha.slice(0, 7)}`, now.why ?? null, Theme.green];
      case 'passed': return ['Done', null, Theme.green];
      case 'unlanded': return ['Not merged', [now.why, waits(now.waits)].filter(Boolean).join('\n'), Theme.red];
      case 'deploying': return ['Deploying', waits(now.waits, 'Deploy') ?? now.line, Theme.blue];
      case 'live': return ['Live', now.line?.replace(/^Live:\s*/, '') ?? null, Theme.green];
      case 'stopped': case 'failed': return [now.kind === 'failed' && !now.end ? 'Failed' : stopWords(now), now.why, Theme.red];
    }
  })();
  if (!head) return null;
  return (
    <RNView style={{ paddingHorizontal: 12, paddingBottom: 10, gap: 2 }}>
      <RNText style={[styles.state, { color }]} maxFontSizeMultiplier={CHROME_FONT_CAP}>{head}</RNText>
      {/* A stop's reason is whole: its last words are what the person does next. */}
      {body ? <RNText style={[styles.why, { color: Theme.text, paddingHorizontal: 0, paddingBottom: 0 }]} numberOfLines={whole ? undefined : 4} maxFontSizeMultiplier={CHROME_FONT_CAP} testID="flow-now-why"><CodeRuns text={body} /></RNText> : null}
      {/* A stop that says to resume the run leads with that press, natively; opening the run follows it. */}
      {(now.kind === 'stopped' || now.kind === 'failed') && now.resume ? <ResumeAtAction runId={run._id} resume={now.resume} /> : null}
      {action ? (
        <Pressable onPress={() => router.push(action.href as never)} hitSlop={8} style={[styles.save, styles.act, { borderColor: Theme.blue }]}>
          <RNText style={[styles.saveText, { color: Theme.blue }]} maxFontSizeMultiplier={CHROME_FONT_CAP}>{action.label}</RNText>
        </Pressable>
      ) : null}
      {now.kind === 'gate' && now.mine && now.decisionId ? <RNView style={{ marginTop: 8 }}><DecisionCard decisionRef={now.decisionId} /></RNView> : null}
    </RNView>
  );
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

function FlowBody({ flow, run, library, links }: { flow: AppFlow; run: RunRow | null; library: FlowLibraryState; links?: RunLinks | null }) {
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
    nothing: { icon: 'minus', color: Theme.textMuted },
    back: { icon: 'corner-down-left', color: Theme.violet },
    unknown: { icon: 'help-circle', color: Theme.textMuted },
  };

  const row = (s: DiagramStep, depth: number) => {
    const st = states.get(s.id) ?? 'idle';
    const m = mark[st];
    const routes = run ? s.side.filter((r) => runReached(run, r.toId)) : s.side;
    return (
      <RNView key={s.id} style={{ marginLeft: depth * 14, opacity: run && st === 'idle' ? 0.5 : 1 }}>
        <StepRow href={links?.stepHref(s.id)} links={links} style={styles.step} testID={`flow-card-step-${s.id}`}>
          <Feather name={WHO[s.kind].icon} size={13} color={Theme.textMuted} />
          <RNText style={[styles.stepName, { color: s.slot?.filled === 'empty' ? Theme.textMuted : Theme.text }]} maxFontSizeMultiplier={CHROME_FONT_CAP}>{s.label}</RNText>
          <RNText style={[styles.who, { color: s.slot?.filled === 'generated' ? Theme.violet : Theme.textMuted }]} maxFontSizeMultiplier={CHROME_FONT_CAP}>{s.slot?.filled === 'empty' ? 'slot' : s.slot?.filled === 'generated' ? 'written here' : WHO[s.kind].word}</RNText>
          {m.icon ? <Feather name={m.icon} size={12} color={m.color} /> : null}
        </StepRow>
        {routes.map((r, i) => <Route key={i} r={r} stopped={!!run && r.tone === 'stop'} />)}
      </RNView>
    );
  };

  return (
    <RNView style={[styles.card, { borderColor: Theme.border, backgroundColor: Theme.bgAlt }]}>
      <RNView style={styles.head}>
        <CardName label={flow.label} links={links} />
        {flow.base ? <RNText style={[styles.task, { color: Theme.textMuted }]} numberOfLines={1} maxFontSizeMultiplier={CHROME_FONT_CAP}>on {flow.base}</RNText> : null}
        <RNView style={{ flex: 1 }} />
        {state ? <RNText style={[styles.state, { color: tone[state.tone] }]} maxFontSizeMultiplier={CHROME_FONT_CAP}>{state.words}</RNText> : null}
        {run?.task_short_id ? <RNText style={[styles.task, codeFont, { color: Theme.textMuted }]} maxFontSizeMultiplier={CHROME_FONT_CAP}>{run.task_short_id}</RNText> : null}
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

/**
 * An edit to a project's flow where it was made (pipeline.md PL5), the web's FlowEditCard laid down the screen: the
 * edit in words, the flow's passing path with this edit's stations marked (a skipped one struck through where it
 * stood), the file's diff a press away, and how far it got: not shipped, the change run carrying it, Live in its deploy.
 */
export function FlowEditCard({ edit, diff = null, dryRun = false }: { edit: FlowEdit; diff?: string | null; dryRun?: boolean }) {
  const Theme = useTheme();
  const identity = useContext(MessageIdentity);
  const conversationId = identity?.conversationId ?? null;
  const madeAt = useMemo(() => {
    if (!conversationId || !identity?.messageId) return null;
    const rows = (useInboxStore.getState().messages?.[conversationId] ?? []) as Array<{ _id?: string; timestamp?: number }>;
    return rows.find((r) => r._id === identity.messageId)?.timestamp ?? null;
  }, [conversationId, identity?.messageId]);
  const runs = useSessionFlowRuns(conversationId);
  const run = useMemo(() => (dryRun ? null : editRun(edit, runs ?? [], madeAt)), [edit, runs, madeAt, dryRun]);
  const { flow: runFlow } = useRunFlow(run);
  const viewer = useJourneyViewer(run as any);
  const journey = useMemo(() => (run && runFlow ? journeyOf(runFlow, run, [], viewer) : null), [run, runFlow, viewer]);
  const live = journey?.now.kind === 'live';
  const { flow: base } = useNamedFlow(edit.graph ? null : edit.base);
  const drawing = useMemo(() => editDrawing(edit, { base: base ?? null, live }), [edit, base, live]);
  const lines = useMemo(() => editLines(edit), [edit]);
  const [fileOpen, setFileOpen] = useState(false);
  const ship = run ? runShip(run as any, viewer.id, null, viewer.ask ?? null) : null;
  const dp = journey && 'line' in journey.now ? liveDeploy(journey.now.line) : null;
  const stateColor = !run ? Theme.textMuted : live ? Theme.green : ship?.tone === 'bad' ? Theme.red : ship?.tone === 'you' || ship?.tone === 'wait' ? Theme.yellow : Theme.blue;
  const sign = (l: string) => (l.startsWith('+ ') ? ['+', Theme.green] : l.startsWith('~ ') ? ['~', Theme.cyan] : l.startsWith('- ') ? ['−', Theme.red] : ['·', Theme.textMuted]) as [string, string];
  const markWords = (m: EditMark | undefined) => (m ? [m.skipped ? 'skipped' : m.own === 'added' ? 'added' : m.own === 'changed' ? (m.changed?.filter((c) => c !== 'when').join(', ') || 'changed') : null, m.when ?? null].filter(Boolean).join(' · ') : '');
  return (
    <RNView style={[styles.card, { borderColor: Theme.border, backgroundColor: Theme.bgAlt }]}>
      <RNView style={styles.head}>
        <RNText style={[styles.kind, { color: Theme.blue, borderColor: Theme.blue }]} maxFontSizeMultiplier={CHROME_FONT_CAP}>PIPELINE EDIT</RNText>
        <RNText style={[styles.name, { color: Theme.text }]} numberOfLines={1} maxFontSizeMultiplier={CHROME_FONT_CAP}>{drawing?.flow.label ?? edit.flow}</RNText>
        {edit.repository ? <RNText style={[styles.task, codeFont, { color: Theme.textMuted }]} numberOfLines={1} maxFontSizeMultiplier={CHROME_FONT_CAP}>{repoName(edit.repository)}</RNText> : null}
        <RNView style={{ flex: 1 }} />
        <RNText style={[styles.state, { color: stateColor }]} maxFontSizeMultiplier={CHROME_FONT_CAP}>{!run ? (dryRun ? 'Dry run' : 'Not shipped') : live ? `Live${dp ? ` · ${dp}` : ''}` : ship?.words ?? 'Shipping'}</RNText>
      </RNView>
      <RNView style={styles.lines}>
        {lines.map((l, i) => {
          const [g, c] = sign(l);
          return (
            <RNView key={i} style={styles.line}>
              <RNText style={[styles.sign, codeFont, { color: c }]} maxFontSizeMultiplier={CHROME_FONT_CAP}>{g}</RNText>
              <RNText style={[styles.lineText, { color: Theme.text }]} maxFontSizeMultiplier={CHROME_FONT_CAP}>{l.replace(/^[+~-] /, '')}</RNText>
            </RNView>
          );
        })}
      </RNView>
      {drawing ? (
        <RNView style={[styles.steps, { gap: 6 }]}>
          {drawing.diagram.steps.map((s) => {
            const m = drawing.marks[s.id];
            const words = markWords(m);
            const accent = m?.skipped ? Theme.textMuted : m?.own ? Theme.cyan : null;
            return (
              <RNView key={s.id} style={[styles.step, { opacity: m?.skipped ? 0.6 : 1 }]}>
                <Feather name={WHO[s.inner.length === 1 ? s.inner[0].kind : s.kind].icon} size={13} color={accent ?? Theme.textMuted} />
                <RNText style={[styles.stepName, { color: accent && !m?.skipped ? Theme.cyan : Theme.text, textDecorationLine: m?.skipped ? 'line-through' : 'none' }]} maxFontSizeMultiplier={CHROME_FONT_CAP}>{s.label}</RNText>
                {words ? <RNText style={[styles.who, { color: accent ?? Theme.textMuted }]} numberOfLines={1} maxFontSizeMultiplier={CHROME_FONT_CAP}>{words}</RNText> : null}
              </RNView>
            );
          })}
          {drawing.diagram.end ? <RNText style={[styles.end, { color: Theme.textMuted, fontWeight: '400' }]} maxFontSizeMultiplier={CHROME_FONT_CAP}>Ends at {drawing.diagram.end}</RNText> : null}
        </RNView>
      ) : null}
      <Pressable disabled={!diff} onPress={() => setFileOpen((o) => !o)} hitSlop={6} style={[styles.file, { borderTopColor: Theme.border }]}>
        {diff ? <Feather name={fileOpen ? 'chevron-down' : 'chevron-right'} size={12} color={Theme.textMuted} /> : null}
        <RNText style={[styles.who, { color: Theme.textMuted, fontWeight: '600' }]} maxFontSizeMultiplier={CHROME_FONT_CAP}>file</RNText>
        <RNText style={[styles.who, codeFont, { color: Theme.textMuted, flexShrink: 1 }]} numberOfLines={1} maxFontSizeMultiplier={CHROME_FONT_CAP}>{edit.file}</RNText>
      </Pressable>
      {fileOpen && diff ? <RNView style={styles.diff}><CastDiff raw={asGitDiff(diff)} fallback={<RNText style={[styles.who, codeFont, { color: Theme.text }]} maxFontSizeMultiplier={CHROME_FONT_CAP}>{diff}</RNText>} /></RNView> : null}
      {journey && run ? <NowLine now={journey.now} whole={wholeWhy(journey)} run={run as RunRow} /> : null}
    </RNView>
  );
}

/** A repository's pipeline (pipeline.md PL6) as the landing's strip: each lane its passing path, main its targets. */
export function FlowPipelineCard({ repository }: { repository: string }) {
  const Theme = useTheme();
  const { workspace: found, feeders } = usePipelineWorkspace(repository);
  const active = useActiveWorkspaceKey();
  const { models, ready } = usePipelineModels(found ?? active);
  const model = models.find((m) => m.repository === repository.toLowerCase()) ?? null;
  if (!model && !ready) return feeders;
  const lane = (title: string, l: PipelineLane, live: string | null) => (
    <RNView style={styles.stripRow}>
      <RNText style={[styles.who, { color: Theme.textMuted, fontWeight: '600' }]} maxFontSizeMultiplier={CHROME_FONT_CAP}>{title}{live ? <RNText style={{ color: Theme.blue }}>{`  ${live}`}</RNText> : null}</RNText>
      <RNText style={[styles.stepName, { color: Theme.text }]} maxFontSizeMultiplier={CHROME_FONT_CAP}>
        {l.diagram.steps.map((st) => (st.kind === 'parallel' && st.inner.length ? st.inner.map((x) => x.label).join(' + ') : st.label)).join('  →  ')}
      </RNText>
    </RNView>
  );
  return (
    <RNView style={[styles.card, { borderColor: Theme.border, backgroundColor: Theme.bgAlt }]}>
      {feeders}
      <RNView style={styles.head}>
        <RNText style={[styles.kind, { color: Theme.blue, borderColor: Theme.blue }]} maxFontSizeMultiplier={CHROME_FONT_CAP}>PIPELINE</RNText>
        <RNText style={[styles.name, { color: Theme.text }]} numberOfLines={1} maxFontSizeMultiplier={CHROME_FONT_CAP}>{model?.name ?? repoName(repository)}</RNText>
        <RNText style={[styles.task, codeFont, { color: Theme.textMuted, flexShrink: 1 }]} numberOfLines={1} maxFontSizeMultiplier={CHROME_FONT_CAP}>{repository}</RNText>
      </RNView>
      {model ? (
        <RNView style={[styles.steps, { gap: 8 }]}>
          {lane('Every change', model.change, model.change.inFlight ? `${model.change.inFlight} in flight` : null)}
          <RNView style={styles.stripRow}>
            <RNText style={[styles.who, codeFont, { color: Theme.textMuted, fontWeight: '600' }]} maxFontSizeMultiplier={CHROME_FONT_CAP}>main</RNText>
            <RNText style={[styles.who, { color: Theme.text }]} maxFontSizeMultiplier={CHROME_FONT_CAP}>
              {model.main.targets.length ? model.main.targets.map((t) => `${t.name} ${t.going?.stuck ? `stuck ${spanWords(t.going.stuck)}` : t.going ? 'going out' : t.tone === 'waiting' ? `${t.waiting} waiting` : t.tone === 'current' ? 'up to date' : t.tone}`).join('   ') : 'no targets declared'}
            </RNText>
          </RNView>
          {lane('Every release', model.release, model.release.stuck ? `${model.release.stuck.deploy} stuck` : model.release.run || model.release.outside ? 'going out' : null)}
        </RNView>
      ) : (
        <RNText style={[styles.why, { color: Theme.textMuted }]} maxFontSizeMultiplier={CHROME_FONT_CAP}>No pipeline published for {repository}</RNText>
      )}
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
  namePress: { flexDirection: 'row', alignItems: 'center', gap: 2, flexShrink: 1 },
  state: { fontSize: 11, fontWeight: '600' },
  task: { fontSize: 11 },
  steps: { paddingHorizontal: 12, paddingBottom: 10, gap: 10 },
  step: { flexDirection: 'row', alignItems: 'center', gap: 7, paddingVertical: 2 },
  stepName: { fontSize: 13, fontWeight: '600' },
  route: { fontSize: 12, marginTop: 2 },
  who: { fontSize: 11 },
  // A stage's name and who acts there share a row: at a large text size they wrap inside the card, never past its edge.
  shrink: { flexShrink: 1 },
  group: { fontSize: 13, fontWeight: '700', marginTop: 2, marginBottom: 4 },
  end: { fontSize: 12, fontWeight: '600', marginTop: 2 },
  why: { fontSize: 11, paddingHorizontal: 12, paddingBottom: 10 },
  save: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 2 },
  saveText: { fontSize: 11, fontWeight: '600' },
  kind: { fontSize: 9, fontWeight: '700', letterSpacing: 0.6, borderWidth: StyleSheet.hairlineWidth, borderRadius: 4, paddingHorizontal: 4, paddingVertical: 1 },
  lines: { paddingHorizontal: 12, paddingBottom: 8, gap: 3 },
  line: { flexDirection: 'row', gap: 6 },
  sign: { width: 10, fontSize: 13, fontWeight: '700' },
  lineText: { fontSize: 13, flexShrink: 1 },
  file: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, paddingVertical: 8, borderTopWidth: StyleSheet.hairlineWidth },
  diff: { paddingHorizontal: 8, paddingBottom: 8 },
  stripRow: { gap: 2 },
  act: { alignSelf: 'flex-start', marginTop: 6, paddingVertical: 8, paddingHorizontal: 12, minHeight: 44, justifyContent: 'center' },
});
